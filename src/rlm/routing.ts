/**
 * Dual routing: decide whether a request benefits from the RLM loop
 * or should go direct to the model.
 *
 * RLM loop is valuable when the task requires:
 *   - Analyzing/searching large context (long documents, codebases)
 *   - Precise computation (arithmetic, constraint solving, logic)
 *   - Multi-step verification
 *
 * Direct mode is better when the task is:
 *   - A short instruction (write code, answer a question)
 *   - Conversational (no tool usage needed)
 *   - Creative generation without verification needs
 *
 * The dispatcher uses heuristics on the prompt, with explicit override
 * via an `rlm` API parameter.
 */

import type { ChatMessage } from "./types.js";

export type Mode = "rlm" | "direct";

const LARGE_CONTEXT_THRESHOLD = 2000; // chars — prompts above this likely have embedded data
const EXPLICIT_TOOL_KEYWORDS = [
  // Computation / verification
  "verify", "prove", "check that", "exact",
  "z3", "smt-lib", "satisfiability", "constraint solver",
  "prolog", "logical inference", "unify",
  // Code analysis
  "call graph", "callers", "callees", "dead code", "cycles",
  "impact analysis", "tree-sitter",
  // Analysis over data
  "analyze this", "search through", "find in the context",
  "count occurrences", "grep",
];

/**
 * Decide routing mode for a request.
 *
 * Rules (first match wins):
 *   1. Explicit override via `rlm` param → respect it
 *   2. Prompt contains explicit tool keywords → RLM
 *   3. User message body > threshold → RLM (has embedded data/context)
 *   4. Otherwise → direct
 */
export function routeRequest(
  messages: ChatMessage[],
  override?: boolean,
): Mode {
  if (override === true) return "rlm";
  if (override === false) return "direct";

  // Find the last user message — that's the actual prompt
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "direct";

  const content = lastUser.content.toLowerCase();

  // Explicit tool keywords → RLM
  for (const kw of EXPLICIT_TOOL_KEYWORDS) {
    if (content.includes(kw)) return "rlm";
  }

  // Large prompt → likely has context to analyze
  if (lastUser.content.length > LARGE_CONTEXT_THRESHOLD) {
    return "rlm";
  }

  return "direct";
}
