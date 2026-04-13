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

  let summaryText: string;
  try {
    const resp = await llm.chat(
      [{ role: "user", content: summaryPrompt }],
      options.signal ? { signal: options.signal } : undefined,
    );
    summaryText = resp.content.trim();
  } catch {
    // If summarization fails (timeout, abort, etc.), fall back to drop
    return [...prefix, ...recent];
  }

  const summaryMsg: ChatMessage = {
    role: "user",
    content: `[Progress summary from earlier iterations]: ${summaryText}`,
  };

  return [...prefix, summaryMsg, ...recent];
}
