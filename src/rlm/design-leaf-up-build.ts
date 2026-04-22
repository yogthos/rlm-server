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
import { mkdir, symlink, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Phase H2 — per-dispatch overlay dir. Used when `projectDir` is set
 * and the batch dispatches more than one function concurrently.
 *
 * Each overlay is a subdir of `parent`. Structure:
 *   <parent>/.rlm-overlays/<fnName>-<salt>/
 *     package.json   (copied from parent)
 *     tsconfig.json  (copied from parent)
 *     node_modules   (symlink → parent's node_modules)
 *
 * Co-ready dispatches can now rewrite their own function files + run
 * their own test spawns without clobbering siblings' work. Node ESM
 * walks up the tree for any imports the tests issue that need parent-
 * level deps; the symlinked node_modules keeps vitest / tsx happy.
 */
async function createOverlayDir(
  parent: string,
  fnName: string,
): Promise<string> {
  const overlayRoot = path.join(parent, ".rlm-overlays");
  await mkdir(overlayRoot, { recursive: true });
  const salt = randomBytes(3).toString("hex");
  const overlay = path.join(overlayRoot, `${fnName}-${salt}`);
  await mkdir(overlay, { recursive: true });
  // Copy config files the test runner expects in the dir it spawns.
  // Also copy the install-hash marker so ensureDepsInstalled skips
  // re-running `npm install` in every overlay (parent's node_modules
  // is already set up; hash matches mean "no work needed").
  for (const f of ["package.json", "tsconfig.json", ".rlm-install-hash"]) {
    try {
      await copyFile(path.join(parent, f), path.join(overlay, f));
    } catch {
      // File may not exist in parent (e.g. deno runtime, skip).
    }
  }
  // Symlink node_modules so vitest/tsx/jest resolve within the overlay.
  try {
    await symlink(
      path.join(parent, "node_modules"),
      path.join(overlay, "node_modules"),
      "dir",
    );
  } catch {
    // If the parent doesn't have node_modules yet, or the symlink
    // already exists, silently proceed — Node's upward resolution
    // will fall back to the parent's node_modules anyway.
  }
  return overlay;
}

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

/** Reflect callback — called on stagnation to choose a recovery
 *  action. When absent, leaf-up falls back to the old behavior (decompose
 *  if provided, otherwise block). See `design-reflect.ts` for the
 *  decision types. */
export type ReflectCallback = (
  graph: DesignGraph,
  module: string,
  name: string,
  failureContext: { testOutput: string; attempts: number },
) => Promise<import("./design-reflect.js").ReflectDecision>;

export interface LeafUpBuildOptions {
  dispatch: DispatchFn;
  projectDir?: string;
  /** Recovery: called when a dispatch returns status="stagnated".
   *  If provided, the Implementer's failed work is cleared and the
   *  function gets decomposed into children before retrying. If
   *  omitted, stagnation falls through to blocked. */
  decompose?: DecomposeCallback;
  /** Stagnation recovery (supersedes `decompose` when both are set).
   *  Given the failure context, the architect chooses retry /
   *  rewrite-tests / decompose / give-up. retry + rewrite-tests
   *  re-queue the function with a hint; decompose delegates to the
   *  `decompose` callback; give-up marks blocked. */
  reflect?: ReflectCallback;
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
  // Names already put through the reflect step. One reflect per
  // function: if the recovery decision itself stagnates, we block
  // rather than reflect again (which would just loop).
  const reflectedOnce = new Set<string>();
  // Pending reflection hints — when reflect chose retry or
  // rewrite-tests, we surface its advice as the next dispatch's
  // externalFeedback so the implementer sees what to do differently.
  const pendingHints = new Map<string, string>();
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
  // Phase H2 — projectDir no longer forces sequential dispatch. Each
  // co-ready dispatch gets its own overlay subdir so filesystem writes
  // + test spawns don't race. node_modules is shared via symlink so
  // vitest/tsx start cold on only the first install.
  const effectiveConcurrency = maxConcurrent;
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
    // Phase H2 — when projectDir is set AND the batch has more than
    // one function, each dispatch gets its own overlay subdir. Single-
    // function batches can use the parent dir directly (no overlay
    // overhead — same as pre-H2 behavior when batch was always one).
    const dispatchDirs = await Promise.all(
      batch.map(async (p) => {
        if (!options.projectDir || batch.length === 1) {
          return options.projectDir;
        }
        return await createOverlayDir(options.projectDir, p.name);
      }),
    );
    const results = await Promise.all(
      batch.map(async (p, idx) => {
        try {
          const hint = pendingHints.get(p.name);
          if (hint !== undefined) pendingHints.delete(p.name);
          const r = await options.dispatch(graph, p.module, p.name, {
            projectDir: dispatchDirs[idx],
            feedback: hint,
          });
          return { pick: p, result: r, error: null as unknown };
        } catch (e) {
          return { pick: p, result: null, error: e };
        }
      }),
    );
    // Phase H2b — delete overlay subdirs as soon as their dispatch
    // completes. Leaving them around causes later phases (integration
    // tests, fix-dispatches) to discover stale `<fn>.test.ts` copies
    // under `.rlm-overlays/*/`, triple-counting the same failures and
    // burning attribution cycles on ghosts. Only overlays — never the
    // parent projectDir — get removed.
    await Promise.all(
      dispatchDirs.map(async (d) => {
        if (!d || d === options.projectDir) return;
        try {
          await rm(d, { recursive: true, force: true });
        } catch (e) {
          debug(
            "leaf-up-build",
            `overlay cleanup failed for ${d}: ${e instanceof Error ? e.message : String(e)}`,
          );
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
      if (result.status === "stagnated") {
        // Second stagnation AFTER a prior decompose or reflect round
        // is always blocked — no second-chance recovery.
        if (decomposedOnce.has(name) || reflectedOnce.has(name)) {
          debug(
            "leaf-up-build",
            `${name} STAGNATED AGAIN after prior recovery — blocking`,
          );
          blocked.add(name);
          continue;
        }

        // When a reflect callback is provided, it drives the choice.
        // Otherwise fall through to the old decompose-if-provided path.
        if (options.reflect) {
          let decision: Awaited<ReturnType<ReflectCallback>>;
          try {
            decision = await options.reflect(graph, module, name, {
              testOutput: result.testOutput ?? "",
              attempts: result.attempts,
            });
          } catch (e) {
            debug(
              "leaf-up-build",
              `${name} reflect threw: ${e instanceof Error ? e.message : String(e)} — blocking`,
            );
            blocked.add(name);
            continue;
          }
          reflectedOnce.add(name);
          debug(
            "leaf-up-build",
            `${name} reflect → ${decision.kind}: ${decision.rationale.slice(0, 100)}`,
          );
          if (decision.kind === "retry" || decision.kind === "rewrite-tests") {
            // Re-queue with the hint surfaced as next-attempt feedback.
            // Don't add to green/blocked; the outer loop picks the
            // function up again on its next pass.
            const hintPrefix =
              decision.kind === "rewrite-tests"
                ? "[reflect: rewrite tests] "
                : "[reflect: retry with new hypothesis] ";
            pendingHints.set(name, hintPrefix + decision.hint);
            continue;
          }
          if (decision.kind === "revise-child") {
            // E1: the parent can't compose its children as-is. Un-green
            // the named child, stash the parent's hint for the child's
            // next dispatch, and leave the parent un-green (it'll wait
            // for the child to re-green before re-dispatching). If the
            // named child doesn't exist or isn't actually a child of
            // this function, block — avoids "phantom revise-child"
            // infinite loops.
            const child = graph.listChildren(name).find(
              (c) => c.name === decision.childName,
            );
            if (!child) {
              debug(
                "leaf-up-build",
                `${name} reflect revise-child "${decision.childName}" — no such child; blocking parent`,
              );
              blocked.add(name);
              continue;
            }
            if (!green.has(decision.childName)) {
              debug(
                "leaf-up-build",
                `${name} reflect revise-child "${decision.childName}" — child not green; odd state, blocking`,
              );
              blocked.add(name);
              continue;
            }
            green.delete(decision.childName);
            pendingHints.set(
              decision.childName,
              `[parent ${name} requests revision] ${decision.hint}`,
            );
            debug(
              "leaf-up-build",
              `${name} reflect revise-child ${decision.childName} — un-greened, hinted`,
            );
            continue;
          }
          if (decision.kind === "give-up") {
            blocked.add(name);
            continue;
          }
          // decision.kind === "decompose" — fall through to the
          // decompose path below.
          if (!options.decompose) {
            debug(
              "leaf-up-build",
              `${name} reflect chose decompose but no decompose callback — blocking`,
            );
            blocked.add(name);
            continue;
          }
        } else if (!options.decompose) {
          blocked.add(name);
          continue;
        }
        debug(
          "leaf-up-build",
          `${name} STAGNATED — attempting decompose`,
        );
        // Body-clear is deferred until AFTER decompose confirms
        // children were added. If decompose refuses (returns false or
        // adds no children), the last stagnation attempt's body stays
        // in the graph — reflect/finalize downstream can still see
        // what was tried.
        const childrenBefore = graph.listChildren(name).length;
        let ok: boolean;
        try {
          ok = await options.decompose!(graph, name);
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
            `${name} decompose refused/failed (ok=${ok}, children ${childrenBefore}→${childrenAfter}) — body preserved, blocking`,
          );
          blocked.add(name);
          continue;
        }
        // Children added — the parent's prior body was written against
        // NO children; it's stale now. Clear it so the re-dispatch
        // (after children green) authors fresh glue against the new
        // decomposition.
        graph.clearImplementation(module, name);
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
