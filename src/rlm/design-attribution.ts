/**
 * Failure attribution for the integration-run + fix loop.
 *
 * When a project-level test fails, we need to pick which function to
 * dispatch for the fix. Two strategies:
 *
 *   - **direct**: walk the stack trace top-down; the first frame whose
 *     file basename matches a function name in the graph wins. This
 *     is reliable in proc-ts where each function lives in its own
 *     file named `<function>.ts`.
 *
 *   - **fallback**: if no frame resolves to a known function (e.g.,
 *     the failure surfaces in scaffolding, test runner internals, or
 *     generic Node APIs), extract a neighborhood subgraph around the
 *     nearest in-project function (or the whole graph when no project
 *     frame appears) and ask the LLM to nominate a target.
 *
 * Returns `{ function: string | null, confidence: "direct" | "fallback"
 * | "unknown" }`. `unknown` only when both strategies fail.
 */

import type { DesignGraph, FunctionNode } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { debug } from "./debug.js";

/**
 * True when an error looks like an abort/cancellation signal. Node's
 * AbortController uses `name: "AbortError"`; the OpenAI SDK surfaces
 * "aborted" in the message. Anything else is a real per-call failure
 * (rate limit, 5xx, parse error) that callers should swallow locally.
 */
export function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError" || e.name === "AbortException") return true;
  if (/\bAbortError\b/.test(e.name)) return true;
  if (/\baborted?\b/i.test(e.message)) return true;
  return false;
}

export type AttributionConfidence = "direct" | "fallback" | "unknown";

export interface AttributionResult {
  function: string | null;
  confidence: AttributionConfidence;
  /** LLM reasoning on fallback; null otherwise. */
  reason?: string;
}

export interface AttributionOptions {
  chat: (prompt: string) => Promise<string>;
  /** Subgraph hop depth for the fallback prompt. Default 1. */
  fallbackDepth?: number;
}

const STACK_FRAME_RE = /at\s+(?:[^(]*\()?([^():\s]+?)(?::\d+:\d+)?\)?\s*$/;

function parseStackFrames(trace: string): string[] {
  const lines = trace.split("\n");
  const files: string[] = [];
  for (const line of lines) {
    const m = line.match(STACK_FRAME_RE);
    if (!m) continue;
    files.push(m[1]);
  }
  return files;
}

function fileToFunctionName(path: string): string | null {
  // Basename-without-extension — proc-ts emits one file per function.
  const base = path.split("/").pop() ?? path;
  const dot = base.indexOf(".");
  if (dot === -1) return base.length > 0 ? base : null;
  const name = base.slice(0, dot);
  return name.length > 0 ? name : null;
}

function isProjectFrame(path: string): boolean {
  if (path.includes("node_modules/")) return false;
  if (path.startsWith("node:")) return false;
  if (path.includes("vitest/")) return false;
  if (path.includes("/internal/")) return false;
  return true;
}

function attributeDirect(
  graph: DesignGraph,
  frames: string[],
): string | null {
  const known = new Set(graph.listFunctions().map((f) => f.name));
  for (const frame of frames) {
    if (!isProjectFrame(frame)) continue;
    const name = fileToFunctionName(frame);
    if (name && known.has(name)) return name;
  }
  return null;
}

/**
 * Cheap direct-only attribution — no LLM call. Returns a function name
 * if the stack trace's in-project frames map to a known function, else
 * null. Used where an LLM fallback would be wasteful (augmentation
 * decides whether to author a witness test; unattributable failures
 * aren't worth authoring for).
 */
export function attributeStackDirect(
  graph: DesignGraph,
  stackTrace: string,
): string | null {
  return attributeDirect(graph, parseStackFrames(stackTrace));
}

export function extractSubgraph(
  graph: DesignGraph,
  seed: string,
  depth: number,
): FunctionNode[] {
  const fns = graph.listFunctions();
  const byName = new Map(fns.map((f) => [f.name, f] as const));
  const callers = new Map<string, string[]>();
  for (const f of fns) {
    for (const dep of f.spec?.dependencies ?? []) {
      if (!callers.has(dep)) callers.set(dep, []);
      callers.get(dep)!.push(f.name);
    }
  }
  const visited = new Set<string>();
  const frontier = new Set<string>([seed]);
  visited.add(seed);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const name of frontier) {
      const fn = byName.get(name);
      if (!fn) continue;
      for (const dep of fn.spec?.dependencies ?? []) {
        if (!visited.has(dep)) next.add(dep);
      }
      for (const c of callers.get(name) ?? []) {
        if (!visited.has(c)) next.add(c);
      }
    }
    for (const n of next) visited.add(n);
    frontier.clear();
    for (const n of next) frontier.add(n);
    if (frontier.size === 0) break;
  }
  return [...visited]
    .map((n) => byName.get(n))
    .filter((f): f is FunctionNode => f !== undefined);
}

function renderSubgraph(sub: FunctionNode[]): string {
  return sub
    .map((f) => {
      const deps = f.spec?.dependencies ?? [];
      const purpose = f.spec?.purpose?.slice(0, 120) ?? "(no spec)";
      return `  - ${f.name} → [${deps.join(", ")}]\n      ${purpose}`;
    })
    .join("\n");
}

function buildFallbackPrompt(trace: string, sub: FunctionNode[]): string {
  return [
    "A project-level integration test failed. The stack trace doesn't",
    "point directly at a function in this proc-ts graph. Nominate the",
    "function most likely responsible for the failure.",
    "",
    "Stack trace:",
    "```",
    trace.trim(),
    "```",
    "",
    "Relevant subgraph (name → dependencies):",
    sub.length > 0 ? renderSubgraph(sub) : "  (no neighbors extracted)",
    "",
    "Return ONLY a fenced JSON object:",
    "```json",
    '{"function": "<name from the subgraph>", "reason": "<one sentence>"}',
    "```",
    "",
    "Pick a function that actually exists in the subgraph above.",
  ].join("\n");
}

function findNearestProjectFrame(
  graph: DesignGraph,
  frames: string[],
): string | null {
  // Walk frames; return the first project frame whose basename is a
  // known function OR resembles one. Used only as a seed for subgraph
  // extraction in the fallback path.
  const known = new Set(graph.listFunctions().map((f) => f.name));
  for (const frame of frames) {
    if (!isProjectFrame(frame)) continue;
    const name = fileToFunctionName(frame);
    if (name && known.has(name)) return name;
  }
  return null;
}

export async function attributeFailure(
  graph: DesignGraph,
  stackTrace: string,
  options: AttributionOptions,
): Promise<AttributionResult> {
  const frames = parseStackFrames(stackTrace);
  const direct = attributeDirect(graph, frames);
  if (direct) {
    debug("attribution", `direct match: ${direct}`);
    return { function: direct, confidence: "direct" };
  }
  // Fallback: pick a seed for the subgraph. Prefer an in-project frame
  // if one exists; otherwise use all functions as the search space.
  const seed = findNearestProjectFrame(graph, frames);
  const depth = options.fallbackDepth ?? 1;
  const sub = seed ? extractSubgraph(graph, seed, depth) : graph.listFunctions();
  if (sub.length === 0) {
    debug("attribution", "no subgraph extractable; returning unknown");
    return { function: null, confidence: "unknown" };
  }
  const prompt = buildFallbackPrompt(stackTrace, sub);
  let response: string;
  try {
    response = await options.chat(prompt);
  } catch (e) {
    // Phase H3 — abort-style errors (top-level cancellation, network
    // aborted mid-call) must propagate so the caller can bail its
    // loop instead of burning one aborted LLM call per remaining
    // failure. Other errors (rate limit, parse failure, upstream 5xx)
    // are still swallowed as "unknown" — those are recoverable per-
    // call and shouldn't take down the whole iteration.
    if (isAbortError(e)) {
      throw e;
    }
    debug(
      "attribution",
      `fallback chat threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { function: null, confidence: "unknown" };
  }
  const parsed = extractJson(response);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    debug("attribution", "fallback response unparseable");
    return { function: null, confidence: "unknown" };
  }
  const r = parsed as Record<string, unknown>;
  if (typeof r.function !== "string") {
    return { function: null, confidence: "unknown" };
  }
  const known = new Set(sub.map((f) => f.name));
  if (!known.has(r.function)) {
    debug(
      "attribution",
      `fallback nominated unknown function: ${r.function}`,
    );
    return { function: null, confidence: "unknown" };
  }
  return {
    function: r.function,
    confidence: "fallback",
    reason: typeof r.reason === "string" ? r.reason : undefined,
  };
}
