/**
 * Post-leaf-up cleanup / tightening pass.
 *
 * After pass 2 (leaf-up build), every function has a body and tests
 * green (or is blocked). The call graph observed in the BODIES may
 * diverge from the planned spec.dependencies:
 *
 *   - `body-orphan`: function exists in the graph, passed its tests,
 *     but no other body's `ctx.fns.<name>(...)` call reaches it
 *     (directly or transitively from entry points). The decomposition
 *     created a helper the assembly never wires in. Integration tests
 *     won't exercise it either.
 *
 *   - `unused-dep`: spec.dependencies lists X, but the body never
 *     calls `ctx.fns.X`. Harmless at runtime but misleading for
 *     reviewers and the coherence graph.
 *
 * This pass is PURE analysis — no automatic repair. Callers (the
 * integration orchestrator, a tightening sub-pass, or the user) decide
 * what to do: delete orphans, ask the architect to wire them in, or
 * ignore and trust the integration loop to surface the gap.
 *
 * Entry points for the reachability walk = functions with `parent ===
 * null` (top-level planned functions). These are the external call
 * surface; everything else should be reachable from one of them.
 */

import type { DesignGraph } from "./design-graph.js";
import { analyzeBody } from "./body-analyzer.js";
import { debug } from "./debug.js";

export type CleanupFindingKind = "body-orphan" | "unused-dep";

export interface CleanupFinding {
  kind: CleanupFindingKind;
  module: string;
  name: string;
  /** For `unused-dep`: the declared dep that's never called. */
  dep?: string;
  detail: string;
}

export interface CleanupReport {
  ok: boolean;
  findings: CleanupFinding[];
  /** Entry points used as the BFS root set. */
  entryPoints: string[];
  /** Names reachable from any entry point via observed body calls. */
  reachable: string[];
}

async function collectObservedCalls(
  graph: DesignGraph,
): Promise<Map<string, Set<string>>> {
  const candidates = graph
    .listFunctions()
    .filter((fn) => fn.implementation !== null);
  // Parallelize body analysis — tree-sitter parses are CPU-bound but
  // analyzeBody is async so they naturally interleave. For graphs of
  // ~20 functions, serial takes ~20× a single parse; Promise.all
  // flattens that.
  const results = await Promise.all(
    candidates.map(async (fn) => {
      try {
        const analysis = await analyzeBody(fn.implementation!);
        return { name: fn.name, calls: new Set(analysis.ctxFnsCalls.map((c) => c.name)) };
      } catch (e) {
        debug(
          "cleanup",
          `body-analyze threw for ${fn.name} (${e instanceof Error ? e.message : String(e)}); treating as leaf`,
        );
        return { name: fn.name, calls: new Set<string>() };
      }
    }),
  );
  const calls = new Map<string, Set<string>>();
  for (const r of results) calls.set(r.name, r.calls);
  return calls;
}

export async function designCleanup(
  graph: DesignGraph,
): Promise<CleanupReport> {
  const fns = graph.listFunctions();
  const byName = new Map(fns.map((f) => [f.name, f] as const));
  const observed = await collectObservedCalls(graph);
  // Entry points — top-level planned functions (no decomposition parent).
  const entryPoints = fns
    .filter((f) => f.parent === null)
    .map((f) => f.name)
    .sort();
  // BFS reachable closure from all entry points.
  const reachable = new Set<string>();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const callee of observed.get(cur) ?? []) {
      if (byName.has(callee) && !reachable.has(callee)) queue.push(callee);
    }
  }
  const findings: CleanupFinding[] = [];
  // body-orphan: function has a body, isn't in the reachable set, and
  // isn't itself an entry point (root). Excludes entry points because
  // they're unreachable by definition (nothing calls them externally).
  for (const f of fns) {
    if (f.parent === null) continue;
    if (f.implementation === null) continue;
    if (reachable.has(f.name)) continue;
    findings.push({
      kind: "body-orphan",
      module: f.module,
      name: f.name,
      detail: `Function "${f.name}" has a body but no other function's call chain reaches it from an entry point. The assembly doesn't wire it in. Either update a caller to invoke it, or drop it from the plan.`,
    });
  }
  // unused-dep: spec lists X, body doesn't call ctx.fns.X.
  for (const f of fns) {
    if (f.implementation === null || !f.spec) continue;
    const actualCalls = observed.get(f.name) ?? new Set<string>();
    for (const dep of f.spec.dependencies) {
      if (actualCalls.has(dep)) continue;
      if (!byName.has(dep)) continue; // phantom — coherence handled it
      findings.push({
        kind: "unused-dep",
        module: f.module,
        name: f.name,
        dep,
        detail: `spec.dependencies of "${f.name}" lists "${dep}", but the body never calls ctx.fns.${dep}. Either drop the dep or use it.`,
      });
    }
  }
  debug(
    "cleanup",
    `post-leaf-up cleanup: ${findings.length} finding(s) (${findings.map((f) => f.kind).join(", ")})`,
  );
  return {
    ok: findings.length === 0,
    findings,
    entryPoints,
    reachable: [...reachable].sort(),
  };
}
