/**
 * Leaf-up implementation pass. Dispatches each function once, in an
 * order that guarantees its dependencies are already tests-green.
 *
 * Work-queue shape (handles dynamic decomposition):
 *   - Each iteration, recompute which functions are READY — all their
 *     spec.dependencies AND decomposition children are green.
 *   - Pick the lowest-level ready function; dispatch it.
 *   - Three outcomes:
 *       (a) tests-green → mark green; its parents become eligible.
 *       (b) failed      → mark blocked; its parents cascade-block.
 *       (c) stagnated   → if a `decompose` callback is provided,
 *                         clear the Implementer's failed work, ask
 *                         the architect to split this function into
 *                         children, and re-queue the parent. The
 *                         children become ready at a deeper level
 *                         and the parent retries once they're green.
 *                         If no decompose callback, treat as failed.
 *   - Terminate when no candidates remain.
 *
 * Level here is dependency depth derived from `spec.dependencies`
 * UNION decomposition-tree children. Cycles → hard fail upfront.
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

/** Architect callback that splits a stagnated function into children.
 *  Returns true on success, false if the split failed. On success, the
 *  graph has new child functions wired into the function's decomposition
 *  tree (via addFunctionChild); each child has a spec. */
export type DecomposeCallback = (
  graph: DesignGraph,
  fnName: string,
) => Promise<boolean>;

export interface LeafUpBuildOptions {
  dispatch: DispatchFn;
  projectDir?: string;
  /** Recovery: called when a dispatch returns status="stagnated".
   *  If provided, the Implementer's failed work is cleared and the
   *  function gets decomposed into children before retrying. If
   *  omitted, stagnation falls through to blocked. */
  decompose?: DecomposeCallback;
  /** Max concurrent dispatches per batch. Functions at the same
   *  dependency level (or below) are inherently independent — their
   *  specs don't reference each other — so it's safe to run them in
   *  parallel. Each dispatch uses its own tmp project dir, so there's
   *  no file-system contention. Default 4; reduce if the LLM backend
   *  rate-limits. */
  maxConcurrent?: number;
}

export interface LeafUpBuildReport {
  ok: boolean;
  /** Function names dispatched, in order. A function may appear twice
   *  if it was first stagnated-then-decomposed, then re-dispatched. */
  dispatched: string[];
  /** Names that got decomposed during the run (stagnation recovery). */
  decomposed: string[];
  /** Names that couldn't be made green. */
  blocked: string[];
  /** Populated on structural failures (cycles, etc.). */
  error: string | null;
}

/**
 * Compute per-function dependency levels using the UNION of
 * `spec.dependencies` and decomposition-tree children. The union makes
 * a parent wait for its decomposition children even when its spec
 * hasn't yet listed them as callable deps (common right after a
 * decompose-on-stagnation split).
 *
 * Throws on cycles. Phantom deps (names not in the graph) are dropped.
 */
export function computeDependencyLevels(
  graph: DesignGraph,
): Map<string, number> {
  const fns = graph.listFunctions();
  const names = new Set(fns.map((f) => f.name));
  const deps = new Map<string, string[]>();
  for (const f of fns) {
    const fromSpec = (f.spec?.dependencies ?? []).filter((n) => names.has(n));
    const fromTree = f.children.filter((n) => names.has(n));
    const union = new Set<string>([...fromSpec, ...fromTree]);
    deps.set(f.name, [...union]);
  }
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

function pickReadyBatch(
  graph: DesignGraph,
  green: Set<string>,
  blocked: Set<string>,
  levels: Map<string, number>,
  max: number,
): Array<{ module: string; name: string }> {
  const candidates: Array<{ module: string; name: string; level: number }> = [];
  const names = new Set(graph.listFunctions().map((f) => f.name));
  for (const f of graph.listFunctions()) {
    if (green.has(f.name) || blocked.has(f.name)) continue;
    if (f.spec === null) continue;
    const specDeps = f.spec.dependencies.filter((d) => names.has(d));
    const treeDeps = f.children.filter((d) => names.has(d));
    const allDeps = [...new Set<string>([...specDeps, ...treeDeps])];
    if (allDeps.some((d) => blocked.has(d))) {
      blocked.add(f.name);
      continue;
    }
    if (!allDeps.every((d) => green.has(d))) continue;
    const L = levels.get(f.name) ?? Number.MAX_SAFE_INTEGER;
    candidates.push({ module: f.module, name: f.name, level: L });
  }
  // Sort by level (leaves first) then alphabetical for deterministic
  // order within a batch — important because Promise.all preserves
  // input order in its results array.
  candidates.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  return candidates.slice(0, max).map((c) => ({ module: c.module, name: c.name }));
}

export async function designLeafUpBuild(
  graph: DesignGraph,
  options: LeafUpBuildOptions,
): Promise<LeafUpBuildReport> {
  const dispatched: string[] = [];
  const decomposed: string[] = [];
  const green = new Set<string>();
  const blocked = new Set<string>();
  // Names we've already asked the architect to decompose at least once.
  // A function that stagnates AGAIN after being decomposed gets
  // blocked instead of looping through another no-op re-plan.
  const decomposedOnce = new Set<string>();
  // Specless functions can't be dispatched.
  for (const f of graph.listFunctions()) {
    if (f.spec === null) blocked.add(f.name);
  }

  try {
    computeDependencyLevels(graph);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debug("leaf-up-build", `structural failure: ${msg}`);
    return {
      ok: false,
      dispatched,
      decomposed,
      blocked: [...blocked],
      error: msg,
    };
  }

  // Bounded work-queue — a decomposition adds nodes and re-queues the
  // parent, so static iteration won't terminate. Cap at
  // (initial function count) × 3 to tolerate a couple of decomposition
  // rounds without risking infinite spin.
  const startSize = graph.listFunctions().length;
  const MAX_ITERATIONS = Math.max(startSize * 3, 30);
  // Clamp to at least 1. A non-positive `maxConcurrent` would pick an
  // empty batch on every iteration and terminate immediately with
  // everything blocked — surprising failure mode for a misconfig.
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
  // Guard against shared-projectDir + concurrent dispatch. When a
  // projectDir is set, multiple dispatches would materialize
  // different function files into the SAME dir simultaneously and
  // clobber each other's writes mid-test-run. Force sequential in
  // that case. (Current production wiring doesn't pass projectDir
  // through leaf-up, so this is defensive.)
  const effectiveConcurrency = options.projectDir ? 1 : maxConcurrent;
  if (options.projectDir && maxConcurrent > 1) {
    debug(
      "leaf-up-build",
      `projectDir set — forcing sequential dispatch (maxConcurrent=${maxConcurrent} ignored)`,
    );
  }
  let iter = 0;
  while (iter++ < MAX_ITERATIONS) {
    let levels: Map<string, number>;
    try {
      levels = computeDependencyLevels(graph);
    } catch (e) {
      return {
        ok: false,
        dispatched,
        decomposed,
        blocked: [...blocked],
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const batch = pickReadyBatch(
      graph,
      green,
      blocked,
      levels,
      effectiveConcurrency,
    );
    if (batch.length === 0) break;
    debug(
      "leaf-up-build",
      `batch: dispatching ${batch.length} function(s) concurrently [${batch.map((p) => p.name).join(", ")}]`,
    );
    for (const p of batch) dispatched.push(p.name);
    // Functions in a batch are inherently independent (deps all green,
    // so they don't call each other's unfinished work). Safe to run
    // LLM calls + tests in parallel. Each dispatch uses its own fresh
    // tmp dir inside test-runner, so no file-system contention.
    const results = await Promise.all(
      batch.map(async (p) => {
        try {
          const r = await options.dispatch(graph, p.module, p.name, {
            projectDir: options.projectDir,
          });
          return { pick: p, result: r, error: null as unknown };
        } catch (e) {
          return { pick: p, result: null, error: e };
        }
      }),
    );
    // Process results SEQUENTIALLY — decompose mutates graph structure
    // (adds children, clears bodies) and concurrent writes would race.
    for (const { pick, result, error } of results) {
      const { module, name } = pick;
      if (error) {
        debug(
          "leaf-up-build",
          `${name} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        blocked.add(name);
        continue;
      }
      if (!result) {
        blocked.add(name);
        continue;
      }
      if (result.status === "tests-green") {
        green.add(name);
        continue;
      }
      if (result.status === "stagnated" && options.decompose) {
        if (decomposedOnce.has(name)) {
          debug(
            "leaf-up-build",
            `${name} STAGNATED AGAIN after prior decompose — blocking`,
          );
          blocked.add(name);
          continue;
        }
        debug(
          "leaf-up-build",
          `${name} STAGNATED — clearing body + decomposing`,
        );
        const childrenBefore = graph.listChildren(name).length;
        graph.clearImplementation(module, name);
        let ok: boolean;
        try {
          ok = await options.decompose(graph, name);
        } catch (e) {
          debug(
            "leaf-up-build",
            `${name} decompose threw: ${e instanceof Error ? e.message : String(e)}`,
          );
          blocked.add(name);
          continue;
        }
        const childrenAfter = graph.listChildren(name).length;
        if (!ok || childrenAfter <= childrenBefore) {
          debug(
            "leaf-up-build",
            `${name} decompose failed (ok=${ok}, children ${childrenBefore}→${childrenAfter}) — blocking`,
          );
          blocked.add(name);
          continue;
        }
        decomposedOnce.add(name);
        decomposed.push(name);
        continue;
      }
      debug(
        "leaf-up-build",
        `${name} not green (${result.status}) — blocking parents`,
      );
      blocked.add(name);
    }
  }
  if (iter >= MAX_ITERATIONS) {
    debug(
      "leaf-up-build",
      `max iterations ${MAX_ITERATIONS} reached — likely decomposition livelock`,
    );
  }

  // Everything that never got into green ends up blocked.
  for (const f of graph.listFunctions()) {
    if (!green.has(f.name) && !blocked.has(f.name)) blocked.add(f.name);
  }

  return {
    ok: blocked.size === 0,
    dispatched,
    decomposed,
    blocked: [...blocked],
    error: null,
  };
}
