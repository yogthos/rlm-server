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

/** Indicators that a task should be planned/decomposed up front. */
const DECOMPOSE_INDICATORS = [
  // Multi-item / ranking tasks
  "top ", "top-", "rank", "list all", "all functions",
  "for each", "every function", "every file",
  // Code analysis (multi-file / multi-function)
  "analyze these", "analyze the", "callers", "callees", "impact",
  "dead code", "cycles", "transitive",
  // Multi-document / multi-chunk analysis
  "across the", "summarize these", "compare these",
];

/** Verbs that imply writing or modifying code. */
const CODING_VERBS = [
  "build ", "implement ", "write ", "create ", "add ", "refactor ",
  "port ", "migrate ", "rewrite ", "scaffold ", "generate ", "fix ",
];

/**
 * Heuristic: does this prompt describe a coding task the hierarchical
 * agent system should consider decomposing?
 */
export function detectCodingTask(prompt: string): boolean {
  const lower = " " + prompt.toLowerCase();
  for (const v of CODING_VERBS) {
    if (lower.includes(" " + v)) return true;
  }
  // Explicit path reference like "src/foo.ts" → coding task
  if (/\b(src|tests?|lib)\/[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|clj|cljs)\b/.test(prompt)) {
    return true;
  }
  // Keyword hints
  if (/\b(unit tests?|integration tests?|module|function|class|api endpoint)\b/i.test(prompt)) {
    return true;
  }
  return false;
}

/**
 * Decide whether to route a request through the hierarchical-agent pipeline.
 *
 * Phase A default: OFF. Callers opt in with `override=true`. Once benchmarks
 * justify it, the default can flip and we'll use the heuristic as the gate.
 */
export function shouldUseHierarchical(prompt: string, override?: boolean): boolean {
  // Phase A: `prompt` is part of the signature so we can swap in a real
  // heuristic (e.g. detectCodingTask(prompt)) once Phase B benchmarks show
  // the hierarchical path wins. Until then, default is off — callers must
  // opt in explicitly via `override=true`.
  void prompt;
  if (override === true) return true;
  if (override === false) return false;
  return false;
}

/**
 * Decide whether a task should be planned up-front (Plan-Then-Execute).
 * Used by the RLM loop to inject a planning directive in the initial
 * prompt, encouraging the model to decompose before any tool use.
 *
 * Returns true for tasks that:
 *   - Mention multiple items to process (top N, all X, for each)
 *   - Code analysis tasks (almost always benefit from decomposition)
 *   - Long prompts (probably have N items embedded)
 */
export function shouldPlanFirst(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  for (const ind of DECOMPOSE_INDICATORS) {
    if (lower.includes(ind)) return true;
  }
  // Multiple file paths in prompt → likely multi-file analysis
  const pathLines = (prompt.match(/^\/[^\s]+\.(ts|tsx|js|py|go|rs|java|c|cpp|clj)/gm) ?? []).length;
  if (pathLines >= 2) return true;
  return false;
}
