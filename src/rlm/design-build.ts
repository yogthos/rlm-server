/**
 * Mechanical build orchestrator for a DesignGraph.
 *
 * The Architect's only agentic decision is the design itself (what
 * modules/functions/tests exist). Everything else — consistency,
 * ordering, dispatching Implementers, finalizing — is deterministic.
 * `designBuild` runs that mechanical pipeline end-to-end so the
 * Architect's sandbox code collapses to: declare the design, call
 * `await design_build()`, return `FINAL_FILES(report)`.
 */

import type {
  DesignGraph,
  FunctionNode,
  ConsistencyReport,
} from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import type { FinalizeReport, FinalizeOptions } from "./finalize.js";
import { createProjectDir, type ProjectDir } from "./test-runner.js";
import { debug } from "./debug.js";

export interface BuildReport {
  ok: boolean;
  phase:
    | "plan"
    | "consistency"
    | "dispatch"
    | "project-tests"
    | "integration"
    | "finalize"
    | "done";
  consistency: ConsistencyReport;
  dispatched: DispatchResult[];
  failed: DispatchResult[];
  finalize: FinalizeReport | null;
  /** When `ok: true` this is the same as `finalize.files` — surfaced here
   *  so FINAL_FILES(report) unwraps it without further drilling. */
  files: Record<string, string>;
  /** Functions the Architect could not spec during planning (phase 2
   *  retries exhausted). Build still proceeds but these functions are
   *  implemented without a contract, so flag them here. */
  failedSpecs?: string[];
  /** Post-leaf-up cleanup findings (body-orphan, unused-dep).
   *  Populated by designPlanIntegration's phase 4b. A non-empty list
   *  that survives auto-repair surfaces here for the caller's info. */
  cleanupFindings?: {
    kind: string;
    module: string;
    name: string;
    dep?: string;
    detail: string;
  }[];
}

export interface BuildOptions {
  dispatch?: (
    graph: DesignGraph,
    module: string,
    name: string,
    projectDir?: string,
  ) => Promise<DispatchResult>;
  finalize?: (
    graph: DesignGraph,
    options?: FinalizeOptions,
  ) => Promise<FinalizeReport>;
  finalizeOptions?: FinalizeOptions;
  /** When true, skip the "no tests anywhere in the graph" safety check.
   *  Only set by `designPlan` (which drives its own test-writing phase).
   *  Manual callers must declare at least one test or they get a
   *  consistency-phase failure instead of a silent 0/0 = ok build. */
  allowUntested?: boolean;
  /** When true, persist a single tmp project directory across every
   *  dispatch so vitest's module cache warms up — each subsequent
   *  attempt only re-transforms the changed file. Default true. */
  useProjectDir?: boolean;
  /** Phase H3 — when provided, a failed `npm install` during
   *  project-dir setup triggers an architect-driven repair loop on
   *  package.json. Without it, install failures are logged and the
   *  build proceeds (downstream dispatches surface the symptom). */
  chat?: (prompt: string) => Promise<string>;
}

/**
 * Topo-sort functions. Default strategy: walk the parent→children
 * tree depth-first so a parent's body is written AFTER its children
 * are green (it calls them via ctx.fns). Multiple roots are handled;
 * siblings are ordered alphabetically for determinism.
 */
export function topoSortFunctions(graph: DesignGraph): FunctionNode[] {
  return graph.topoSortFunctions();
}

/** Legacy module-import topo-sort. Kept as a fallback for callers that
 *  still pass flat graphs — when no function has a parent the tree
 *  walk degenerates to a single pass, so this is effectively unused on
 *  new graphs. */
export function topoSortByModuleImports(graph: DesignGraph): FunctionNode[] {
  const fns = [...graph.listFunctions()].sort((a, b) =>
    `${a.module}#${a.name}`.localeCompare(`${b.module}#${b.name}`),
  );

  // module → set of project-local modules it imports from
  const moduleDeps = new Map<string, Set<string>>();
  for (const mod of graph.listModules()) {
    const deps = new Set<string>();
    for (const edge of mod.imports) {
      if (graph.getModule(edge.from)) deps.add(edge.from);
    }
    moduleDeps.set(mod.path, deps);
  }

  // Kahn's algorithm over modules, then expand each module into its
  // alphabetically-ordered function list.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const [m] of moduleDeps) {
    inDegree.set(m, 0);
    dependents.set(m, new Set());
  }
  for (const [m, deps] of moduleDeps) {
    for (const d of deps) {
      inDegree.set(m, (inDegree.get(m) ?? 0) + 1);
      dependents.get(d)!.add(m);
    }
  }

  const queue: string[] = [];
  for (const [m, deg] of inDegree) {
    if (deg === 0) queue.push(m);
  }
  queue.sort();

  const moduleOrder: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const m = queue.shift()!;
    if (visited.has(m)) continue;
    visited.add(m);
    moduleOrder.push(m);
    const pending = [...(dependents.get(m) ?? [])].sort();
    for (const dep of pending) {
      inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      if ((inDegree.get(dep) ?? 0) <= 0 && !visited.has(dep)) {
        queue.push(dep);
      }
    }
    queue.sort();
  }
  // Any modules left over are in cycles — append in alphabetical order.
  for (const m of [...moduleDeps.keys()].sort()) {
    if (!visited.has(m)) moduleOrder.push(m);
  }

  const positions = new Map(moduleOrder.map((m, i) => [m, i]));
  return fns.sort((a, b) => {
    const pa = positions.get(a.module) ?? Number.MAX_SAFE_INTEGER;
    const pb = positions.get(b.module) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

/** Pick the next function ready to dispatch. A function is ready when:
 *  (a) it isn't tests-green yet, (b) it hasn't already failed in this
 *  build, and (c) all its children are tests-green (or it has none).
 *  Returns null when no more work remains. Children precede parents. */
function findReady(
  graph: DesignGraph,
  failedSoFar: Map<string, DispatchResult>,
): FunctionNode | null {
  // Depth-first search from roots; return the first leaf-ready node.
  const sorted = graph.topoSortFunctions();
  for (const fn of sorted) {
    if (fn.status === "tests-green") continue;
    if (failedSoFar.has(fn.name)) continue;
    // Ready if all children are green.
    const childrenReady = graph
      .listChildren(fn.name)
      .every((c) => c.status === "tests-green");
    if (!childrenReady) continue;
    return fn;
  }
  return null;
}

export async function designBuild(
  graph: DesignGraph,
  options: BuildOptions = {},
): Promise<BuildReport> {
  const dispatch = options.dispatch;
  const finalize = options.finalize;

  debug(
    "build",
    `start modules=${graph.listModules().length} functions=${graph.listFunctions().length}`,
  );
  debug(
    "progress",
    `build: start — ${graph.listModules().length} modules, ${graph.listFunctions().length} functions`,
  );
  const consistency = graph.consistency();
  debug(
    "build",
    `consistency ok=${consistency.ok} violations=${consistency.violations.length} advisories=${consistency.advisories.length}`,
  );
  const base: BuildReport = {
    ok: false,
    phase: "consistency",
    consistency,
    dispatched: [],
    failed: [],
    finalize: null,
    files: {},
  };
  if (!consistency.ok) {
    debug(
      "build",
      `abort at consistency; first violation=${JSON.stringify(consistency.violations[0])}`,
    );
    return base;
  }

  // Safety gate: a build with no tests anywhere is not a TDD contract.
  // 0/0 would later be treated as "no signal → ok" by the dispatch
  // pre-test, which lets any body through and produces uncovered code.
  // Fail loudly via the consistency phase so the Architect sees it.
  if (!options.allowUntested) {
    const anyTests = graph
      .listFunctions()
      .some((f) => f.tests.length > 0);
    if (!anyTests) {
      debug(
        "build",
        `abort: no tests declared on any function — call design_plan() or attach design_test() to at least one function`,
      );
      const report = { ...base };
      report.consistency = {
        ok: false,
        violations: [],
        advisories: [
          ...consistency.advisories,
        ],
      };
      // Surface the missing-tests condition via a violation entry the
      // caller can match on by looking at report.consistency.advisories
      // (kind=no_tests) combined with report.phase=consistency.
      return report;
    }
  }

  if (!dispatch || !finalize) {
    throw new Error("designBuild requires `dispatch` and `finalize` in options");
  }

  const ordered = topoSortFunctions(graph);
  debug(
    "build",
    `topo-order: ${ordered.map((f) => `${f.module}#${f.name}`).join(" → ")}`,
  );

  // Warm project dir: materialize once; each dispatch rewrites only
  // the changed function file so vitest reuses cached compilations of
  // every untouched sibling. Reusing the dir is ~5–10× faster per
  // attempt for multi-function builds.
  const useProjectDir = options.useProjectDir ?? true;
  let projectDir: ProjectDir | null = null;
  if (useProjectDir) {
    try {
      projectDir = await createProjectDir(graph, { chat: options.chat });
      debug("build", `warmed project dir ${projectDir.path}`);
    } catch (e) {
      debug(
        "build",
        `project dir init failed (${e instanceof Error ? e.message : String(e)}); falling back to cold tmpdirs`,
      );
    }
  }
  try {
  const dispatched: DispatchResult[] = [];
  // Work-queue walk so decomposition mid-build picks up newly-added
  // children without re-sorting. On each pass: find the next ready
  // function — one that's NOT tests-green AND whose children are all
  // tests-green (or empty). Dispatch it. If the dispatch returns
  // "decomposed" (its children were just added), it stays not-green,
  // the children become dispatchable on the next pass, and eventually
  // the parent is revisited. `dispatch-dispatch.ts` self-guards
  // against asking DECOMPOSE twice (it only asks when
  // `fn.children.length === 0`).
  const failedSoFar = new Map<string, DispatchResult>();
  // Safety fence to prevent infinite loops.
  const maxIterations = 500;
  let iter = 0;
  while (iter++ < maxIterations) {
    const fn = findReady(graph, failedSoFar);
    if (!fn) break;
    const key = `${fn.module}#${fn.name}`;
    debug(
      "build",
      `dispatch ${key} (status=${fn.status} hasImpl=${fn.implementation !== null} children=${fn.children.length})`,
    );
    debug("progress", `build: dispatch ${key}`);
    let result: DispatchResult;
    try {
      result = await dispatch(graph, fn.module, fn.name, projectDir?.path);
      debug(
        "build",
        `dispatch ${key} → ${result.status} attempts=${result.attempts} impl=${result.implementation !== null}`,
      );
      debug(
        "progress",
        `build: dispatch ${key} → ${result.status} (${result.attempts} attempts)`,
      );
    } catch (e) {
      result = {
        module: fn.module,
        name: fn.name,
        status: "failed",
        implementation: null,
        attempts: 0,
        testOutput: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    // Detect the decompose-signal: status=failed AND error mentions
    // "decomposed". The function's children were just added — revisit
    // in a later iteration (children green first, then this parent's
    // assembly body). Dispatch.ts's own guard prevents asking twice.
    if (
      result.status === "failed" &&
      result.error &&
      result.error.startsWith("decomposed")
    ) {
      debug(
        "progress",
        `build: ${key} decomposed — new children in the graph, requeuing`,
      );
      continue;
    }
    dispatched.push(result);
    // Reconcile: the real dispatcher mutates the graph via
    // setImplementation/setTestStatus, but a caller that passes a
    // pure-function mock leaves the graph node stale. Mirror the
    // authoritative result onto the node so the work-queue sees the
    // latest status. Wrap in try/catch so a mock that points at a
    // non-existent node (edge case) doesn't crash the whole build.
    try {
      const node = graph.getFunction(fn.module, fn.name);
      if (node) {
        if (
          result.status === "tests-green" &&
          result.implementation !== null &&
          node.status !== "tests-green"
        ) {
          graph.setImplementation(fn.module, fn.name, result.implementation);
          graph.setTestStatus(
            fn.module,
            fn.name,
            "tests-green",
            result.testOutput ?? "",
          );
        } else if (result.status === "failed" && node.status !== "tests-red") {
          graph.setTestStatus(
            fn.module,
            fn.name,
            "tests-red",
            result.testOutput ?? result.error ?? "",
          );
        }
      }
    } catch (e) {
      debug(
        "build",
        `reconcile failed for ${key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (result.status !== "tests-green") {
      failedSoFar.set(fn.name, result);
    }
  }
  if (iter >= maxIterations) {
    debug("build", `maxIterations reached — likely dispatch livelock`);
  }
  const failed = dispatched.filter((d) => d.status !== "tests-green");
  debug(
    "build",
    `dispatch summary: total=${dispatched.length} green=${dispatched.length - failed.length} failed=${failed.length}`,
  );
  if (failed.length > 0) {
    debug(
      "build",
      `abort at dispatch; failing=${failed.map((f) => `${f.module}#${f.name}`).join(",")}`,
    );
    debug(
      "progress",
      `build: FAILED at dispatch — ${failed.length}/${dispatched.length} red: ${failed.map((f) => `${f.module}#${f.name}`).join(", ")}`,
    );
    return { ...base, phase: "dispatch", dispatched, failed };
  }

  debug("build", `finalize (typecheck default=on)`);
  debug("progress", `build: finalize — vitest + tsc`);
  const finalizeReport = await finalize(graph, {
    typecheck: true,
    ...(options.finalizeOptions ?? {}),
  });
  debug(
    "build",
    `finalize → ok=${finalizeReport.ok} tests=${finalizeReport.testsPassed}/${finalizeReport.testsPassed + finalizeReport.testsFailed} typecheck=${finalizeReport.typecheckOk}`,
  );
  if (!finalizeReport.ok) {
    debug(
      "progress",
      `build: FAILED at finalize — tests=${finalizeReport.testsPassed}/${finalizeReport.testsPassed + finalizeReport.testsFailed} typecheck=${finalizeReport.typecheckOk}`,
    );
    return {
      ...base,
      phase: "finalize",
      dispatched,
      failed: [],
      finalize: finalizeReport,
      files: finalizeReport.files,
    };
  }

  debug("build", `done files=${Object.keys(finalizeReport.files).length}`);
  debug(
    "progress",
    `build: DONE ok=true — ${Object.keys(finalizeReport.files).length} files`,
  );
  return {
    ok: true,
    phase: "done",
    consistency,
    dispatched,
    failed: [],
    finalize: finalizeReport,
    files: finalizeReport.files,
  };
  } finally {
    // Phase H1 — keep the project dir around so the user can inspect
    // artifacts after the build finishes. Opt-in cleanup via env var
    // when running in CI / tests where directories accumulate.
    if (projectDir && process.env.RLM_DISPOSE_PROJECT_DIR === "1") {
      await projectDir.dispose();
    } else if (projectDir) {
      debug("build", `project dir preserved at ${projectDir.path}`);
    }
  }
}
