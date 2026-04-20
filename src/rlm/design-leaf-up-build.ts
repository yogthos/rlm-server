/**
 * Leaf-up implementation pass. Replaces the sketch + harden passes
 * with one bottom-up walk that dispatches each function exactly
 * once, in an order that guarantees its dependencies are already
 * tests-green.
 *
 * Genetic-algorithm principle: each dispatch is a forward step. No
 * function is implemented until its real dependencies exist in the
 * graph, so unit tests exercise the assembly at that level rather
 * than stubs. Parents never see broken children — if a leaf can't
 * be made green, every transitive parent is marked blocked and
 * skipped. Blocked functions surface in the report for a later
 * targeted-fix pass.
 *
 * Levels are computed from `spec.dependencies`:
 *   - L0 = functions with zero in-graph deps (leaves)
 *   - L(N+1) = functions whose deps are all at level ≤ N
 *
 * Phantom deps (names not in the graph) are ignored — coherence
 * should flag them separately. Cycles are hard-fail: the build
 * stops before dispatching anything because a cycle in the call
 * graph means no one is truly a leaf.
 *
 * Specless functions (no `spec` attached) are also blocked — we
 * can't compute their level or know what to dispatch against.
 * They get surfaced in `blocked` without a dispatch attempt.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import { debug } from "./debug.js";

export type DispatchFn = (
  graph: DesignGraph,
  module: string,
  name: string,
  opts?: { projectDir?: string; feedback?: string },
) => Promise<DispatchResult>;

export interface LeafUpBuildOptions {
  dispatch: DispatchFn;
  projectDir?: string;
}

export interface LeafUpBuildReport {
  ok: boolean;
  /** Functions that got a dispatch call, in the order dispatched. */
  dispatched: string[];
  /** Functions that could NOT be dispatched — dep blocked, specless,
   *  or the dispatch itself returned non-green. Caller can re-target
   *  these in a later fix pass. */
  blocked: string[];
  /** Populated on cycle detection / other structural failures. */
  error: string | null;
}

/**
 * Compute per-function dependency levels from `spec.dependencies`.
 * Throws on cycles. Phantom deps (names not in the graph) are
 * dropped — treat them as external and don't let them raise the
 * function's level.
 *
 * Exported for testing and so the orchestrator can reason about
 * level structure if needed.
 */
export function computeDependencyLevels(
  graph: DesignGraph,
): Map<string, number> {
  const fns = graph.listFunctions();
  const names = new Set(fns.map((f) => f.name));
  const deps = new Map<string, string[]>();
  for (const f of fns) {
    const d = (f.spec?.dependencies ?? []).filter((n) => names.has(n));
    deps.set(f.name, d);
  }
  // Kahn's algorithm with per-node "longest path from any leaf" level.
  const level = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of names) {
    inDeg.set(n, deps.get(n)!.length);
    dependents.set(n, []);
  }
  for (const [n, d] of deps) {
    for (const dep of d) {
      dependents.get(dep)!.push(n);
    }
  }
  const queue: string[] = [];
  for (const [n, deg] of inDeg) {
    if (deg === 0) {
      queue.push(n);
      level.set(n, 0);
    }
  }
  let processed = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    processed++;
    for (const down of dependents.get(cur) ?? []) {
      inDeg.set(down, (inDeg.get(down) ?? 1) - 1);
      const candidate = (level.get(cur) ?? 0) + 1;
      const prev = level.get(down);
      if (prev === undefined || candidate > prev) {
        level.set(down, candidate);
      }
      if ((inDeg.get(down) ?? 0) === 0) queue.push(down);
    }
  }
  if (processed < names.size) {
    const stuck = [...names].filter((n) => !level.has(n));
    throw new Error(
      `dependency cycle detected; cannot level: ${stuck.join(", ")}`,
    );
  }
  return level;
}

export async function designLeafUpBuild(
  graph: DesignGraph,
  options: LeafUpBuildOptions,
): Promise<LeafUpBuildReport> {
  const dispatched: string[] = [];
  const blocked = new Set<string>();
  // Specless functions can't be dispatched — require a contract.
  const specless = graph
    .listFunctions()
    .filter((f) => f.spec === null)
    .map((f) => f.name);
  for (const n of specless) blocked.add(n);

  // Build levels on the specced subset. If cycles, bail before any
  // dispatch so we don't leave the graph half-implemented.
  let levels: Map<string, number>;
  try {
    levels = computeDependencyLevels(graph);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debug("leaf-up-build", `structural failure: ${msg}`);
    return {
      ok: false,
      dispatched,
      blocked: [...blocked],
      error: msg,
    };
  }

  // Group by level; dispatch sequentially. Within a level, alphabetical
  // order for determinism.
  const byLevel = new Map<number, Array<{ module: string; name: string }>>();
  for (const f of graph.listFunctions()) {
    if (blocked.has(f.name)) continue;
    const L = levels.get(f.name) ?? Number.MAX_SAFE_INTEGER;
    if (!byLevel.has(L)) byLevel.set(L, []);
    byLevel.get(L)!.push({ module: f.module, name: f.name });
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  for (const L of sortedLevels) {
    const cohort = byLevel.get(L)!.sort((a, b) => a.name.localeCompare(b.name));
    for (const { module, name } of cohort) {
      const fn = graph.getFunction(module, name);
      if (!fn) continue;
      // Dep-gating: any dep blocked → this function is blocked too.
      const deps = fn.spec?.dependencies ?? [];
      const broken = deps.filter((d) => blocked.has(d));
      if (broken.length > 0) {
        debug(
          "leaf-up-build",
          `${name} BLOCKED by deps: ${broken.join(", ")}`,
        );
        blocked.add(name);
        continue;
      }
      debug("leaf-up-build", `dispatch ${name} (level ${L})`);
      dispatched.push(name);
      let result: DispatchResult;
      try {
        result = await options.dispatch(graph, module, name, {
          projectDir: options.projectDir,
        });
      } catch (e) {
        debug(
          "leaf-up-build",
          `${name} threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        blocked.add(name);
        continue;
      }
      // Block when the function didn't go tests-green. Under pure-TDD
      // pass 2 (no architect) a `failed` status means the Implementer
      // never got its own tests to pass — stagnation bail or full
      // exhaustion. The Implementer owns BOTH the body and the tests,
      // so "can't make them pass" is a real signal that the function
      // is broken. Parents building against a red sibling will cascade
      // their own failures. Integration phase 3 is for end-to-end
      // bugs in a working assembly, not for fixing individual broken
      // function contracts.
      if (result.status !== "tests-green") {
        debug(
          "leaf-up-build",
          `${name} BLOCKED (${result.status}) — unit tests red; parents skipped`,
        );
        blocked.add(name);
      }
    }
  }

  return {
    ok: blocked.size === 0,
    dispatched,
    blocked: [...blocked],
    error: null,
  };
}
