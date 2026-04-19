/**
 * Compute the relevant sub-neighborhood of a target function — the
 * slice of the DesignGraph that actually belongs in the Implementer's
 * prompt. Everything else is wired into `ctx.fns` at runtime but
 * hidden from the prompt to save tokens and reduce LLM confusion.
 *
 * Relevance (encoded as Prolog rules):
 *   - The target itself.
 *   - Every ancestor (parent chain to root).
 *   - Every direct child.
 *   - Every sibling (same parent).
 *   - Any function called from the target's tests or body
 *     (`ctx.fns.X` references) — plus one transitive hop, so a dep of
 *     a dep shows up too.
 */

import type { DesignGraph, FunctionNode } from "./design-graph.js";
import { prologQuery } from "./prolog-bridge.js";
import { debug } from "./debug.js";

/** Extract the set of function names called from a code fragment via
 *  `ctx.fns.<name>(` or `ctx.fns.<name>.`. Returns deduped names. */
export function extractCallsFromCode(code: string): string[] {
  const names = new Set<string>();
  const re = /\bctx\.fns\.([A-Za-z_$][\w$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

/** Collect every `ctx.fns.X` referenced across a function's tests and
 *  body. Uses this to populate the `calls/2` Prolog fact. */
function collectCallsForFunction(fn: FunctionNode): string[] {
  const sources: string[] = [];
  for (const t of fn.tests) sources.push(t.code);
  for (const t of fn.integrationTests) sources.push(t.code);
  if (fn.implementation !== null) sources.push(fn.implementation);
  const names = new Set<string>();
  for (const s of sources) {
    for (const n of extractCallsFromCode(s)) names.add(n);
  }
  return [...names];
}

function toProlog(name: string): string {
  // Prolog atoms matching [a-z_][a-zA-Z0-9_]* are safe unquoted. Proc-ts
  // names are valid TS identifiers (enforced globally-unique), so they
  // match `/^[A-Za-z_$][A-Za-z0-9_$]*$/`. Prolog needs lowercase OR
  // quoted atoms; camelCase identifiers must be quoted.
  return `'${name.replace(/'/g, "''")}'`;
}

/** Build the Prolog program encoding the graph's structural edges. */
export function buildFacts(graph: DesignGraph): string {
  const lines: string[] = [];
  const fns = graph.listFunctions();
  for (const fn of fns) {
    lines.push(`fn(${toProlog(fn.name)}).`);
    if (fn.parent) {
      lines.push(
        `parent_of(${toProlog(fn.name)}, ${toProlog(fn.parent)}).`,
      );
    }
    for (const callee of collectCallsForFunction(fn)) {
      // Only emit edges to functions that actually exist — stale
      // `ctx.fns.X` references (unresolved) are dropped silently here.
      if (fns.some((f) => f.name === callee)) {
        lines.push(`calls(${toProlog(fn.name)}, ${toProlog(callee)}).`);
      }
    }
  }
  // Structural rules — relevance derivation.
  lines.push(
    "",
    "% Ancestors — transitive parent chain.",
    "ancestor(X, Y) :- parent_of(X, Y).",
    "ancestor(X, Y) :- parent_of(X, Z), ancestor(Z, Y).",
    "",
    "% Relevance fan from target T:",
    "%   - T itself",
    "%   - all ancestors of T",
    "%   - direct children of T",
    "%   - siblings of T (same parent)",
    "%   - functions T calls (tests or body)",
    "%   - one transitive hop of callees from the above set",
    "relevant(T, T).",
    "relevant(T, A) :- ancestor(T, A).",
    "relevant(T, C) :- parent_of(C, T).",
    "relevant(T, S) :- parent_of(T, P), parent_of(S, P), S \\= T.",
    "relevant(T, K) :- calls(T, K).",
    "% One explicit transitive hop — avoids self-recursion on `relevant`,",
    "% which would loop on call cycles.",
    "relevant(T, K) :- calls(T, M), calls(M, K), M \\= T.",
  );
  return lines.join("\n");
}

export interface ComputeRelevantOptions {
  /** Timeout for Prolog query, ms. Defaults to 2s. */
  timeoutMs?: number;
}

/**
 * Return the subset of `graph.listFunctions()` that the Implementer of
 * `targetName` should see in its prompt. Falls back to the full list on
 * Prolog error/timeout so a broken scope never blocks a build.
 */
export async function computeRelevantFunctions(
  graph: DesignGraph,
  targetName: string,
  _options: ComputeRelevantOptions = {},
): Promise<FunctionNode[]> {
  const all = graph.listFunctions();
  const target = all.find((f) => f.name === targetName);
  if (!target) {
    // Caller error, but don't crash — fall back gracefully.
    debug("scope", `target ${targetName} not found — returning []`);
    return [];
  }

  const program = buildFacts(graph);
  const goal = `relevant(${toProlog(targetName)}, X).`;
  try {
    const result = await prologQuery(program, goal, {
      maxAnswers: Math.max(50, all.length * 4),
    });
    if (result.status !== "success" || !result.answers) {
      debug(
        "scope",
        `prolog query failed (${result.status}); falling back to full list`,
      );
      return all;
    }
    const picked = new Set<string>();
    for (const a of result.answers) {
      const x = a.bindings.X ?? a.bindings.x;
      if (!x) continue;
      // Strip surrounding quotes if present.
      const name = x.replace(/^'/, "").replace(/'$/, "");
      picked.add(name);
    }
    const out = all.filter((f) => picked.has(f.name));
    debug(
      "scope",
      `target=${targetName} picked ${out.length}/${all.length} fns: ${out.map((f) => f.name).join(",")}`,
    );
    // Safety: always include the target.
    if (!out.some((f) => f.name === targetName)) out.unshift(target);
    return out;
  } catch (e) {
    debug(
      "scope",
      `prolog threw (${e instanceof Error ? e.message : String(e)}); falling back to full list`,
    );
    return all;
  }
}
