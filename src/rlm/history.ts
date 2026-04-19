/**
 * Active-use-aware history compaction.
 *
 * When the RLM loop's history grows too large, instead of blindly dropping
 * old turns we:
 *
 *   1. Identify handles referenced in the recent messages (active working set)
 *   2. Ask the LLM to summarize the older turns into a single message,
 *      with extra context about which handles matter
 *   3. Replace the summarized middle with that one summary message
 *
 * The handle STORE itself is always preserved (LRU with 200 cap). This
 * compaction only targets the message history sent to the LLM.
 */

import type { ChatMessage, LLMClient } from "./types.js";

export interface CompactOptions {
  /** Trigger compaction when message count exceeds this. */
  maxMessages: number;
  /** Trigger compaction when total chars exceed this. */
  maxChars: number;
  /** Always keep the last N messages verbatim (recent context). */
  keepRecent: number;
  /** Passed through to LLM call for abort support. */
  signal?: AbortSignal;
}

/** Extract `$handle_name` references from text. */
export function extractHandleRefs(text: string): Set<string> {
  const refs = new Set<string>();
  // Match $ followed by valid handle-name characters
  const matches = text.matchAll(/\$[a-zA-Z_][a-zA-Z0-9_]*/g);
  for (const m of matches) {
    refs.add(m[0]);
  }
  return refs;
}

export function shouldCompact(
  history: ChatMessage[],
  options: { maxMessages: number; maxChars: number },
): boolean {
  if (history.length > options.maxMessages) return true;
  let total = 0;
  for (const m of history) total += m.content.length;
  return total > options.maxChars;
}

export type SummaryCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check that a summary is usable before we commit to it.
 *   - Must be non-empty (after trimming).
 *   - Must be SHORTER than what it replaces (otherwise compaction is
 *     net-negative).
 *   - Must preserve every active handle reference the model cares about
 *     — dropping `$handle_name` mentions silently loses working state.
 */
export function validateSummary(
  summary: string,
  middle: ChatMessage[],
  activeHandles: Set<string>,
): SummaryCheck {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "summary was empty or blank" };
  }
  const middleChars = middle.reduce((s, m) => s + m.content.length, 0);
  if (trimmed.length >= middleChars) {
    return {
      ok: false,
      reason: `summary (${trimmed.length}ch) is not shorter than what it replaces (${middleChars}ch)`,
    };
  }
  const missing: string[] = [];
  for (const h of activeHandles) {
    if (!trimmed.includes(h)) missing.push(h);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `summary dropped active handle references: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

/** Build the prompt that asks the LLM to summarize old turns. */
export function buildSummaryPrompt(
  turnsToSummarize: ChatMessage[],
  activeHandles: Set<string>,
): string {
  const turnsText = turnsToSummarize
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n---\n\n");

  const handlesLine =
    activeHandles.size > 0
      ? `\n\nThe following handles are actively referenced and must be preserved in the summary: ${[...activeHandles].join(", ")}`
      : "";

  return `Summarize the following excerpt from an RLM (Recursive Language Model) reasoning session into 2-4 concise sentences. Focus on:
- What was explored or attempted
- Key findings or discoveries
- Any conclusions reached
- Which handles were created and what they contain${handlesLine}

Turns to summarize:

${turnsText}

Output ONLY the summary — no preamble, no repetition of the task, no meta-commentary. Start directly with the progress description.`;
}

/**
 * Compact history if it has grown too large.
 *
 * Keeps: [system, initial user prompt, summary-of-middle, ...recent N messages]
 * Returns the original history if no compaction needed.
 */
export async function compactHistory(
  history: ChatMessage[],
  llm: LLMClient,
  options: CompactOptions,
): Promise<ChatMessage[]> {
  if (!shouldCompact(history, options)) return history;

  // Structure: [system, user-initial, ...turns..., most recent turns]
  // We always keep the first 2 (system + initial) and the last `keepRecent`
  const prefix = history.slice(0, 2);
  const recent = history.slice(-options.keepRecent);
  const middle = history.slice(2, -options.keepRecent);

  if (middle.length === 0) return history;

  // Find active handle references in the recent window
  const activeRefs = new Set<string>();
  for (const m of recent) {
    for (const r of extractHandleRefs(m.content)) activeRefs.add(r);
  }

  const summaryPrompt = buildSummaryPrompt(middle, activeRefs);

  // Two attempts: initial summary, then one retry with a corrective nudge
  // if the first response was unusable (empty, too long, dropped handles).
  // On double-failure we fall back to the drop path.
  const chatOptions = options.signal ? { signal: options.signal } : undefined;
  let summaryText: string | null = null;
  const conversation: ChatMessage[] = [{ role: "user", content: summaryPrompt }];

  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp;
    try {
      resp = await llm.chat(conversation, chatOptions);
    } catch {
      // Network/abort failure — fall back immediately.
      return [...prefix, ...recent];
    }
    const candidate = resp.content.trim();
    const check = validateSummary(candidate, middle, activeRefs);
    if (check.ok) {
      summaryText = candidate;
      break;
    }
    if (attempt === 2) break;
    // Retry: add assistant turn + corrective user nudge.
    conversation.push({ role: "assistant", content: resp.content });
    conversation.push({
      role: "user",
      content: [
        `That summary is not usable: ${check.reason}.`,
        "",
        "Try again. Produce a summary that is:",
        "  - non-empty",
        "  - strictly shorter than the source",
        `  - preserves every handle reference above (${[...activeRefs].join(", ") || "(none)"})`,
        "",
        "Output ONLY the new summary text, nothing else.",
      ].join("\n"),
    });
  }

  if (summaryText === null) {
    // Both attempts failed validation — drop the middle.
    return [...prefix, ...recent];
  }

  const summaryMsg: ChatMessage = {
    role: "user",
    content: `[Progress summary from earlier iterations]: ${summaryText}`,
  };

  return [...prefix, summaryMsg, ...recent];
}
