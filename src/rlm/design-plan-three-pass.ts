/**
 * Three-pass plan orchestrator.
 *
 * Restructures the pipeline so the skeleton lands before tests/review
 * apply — avoids the infinite-loop failure mode where the architect
 * invents edge cases phase-2 and review enforces them against an
 * unfinished assembly.
 *
 *   Pass A (sketch):    phases 0–2 + `sketchDispatch` — body-only
 *                       skeleton. No tests, no architect review.
 *   Pass B (coherence): `designCoherence` → for each violation, re-
 *                       dispatch the affected function in sketch mode
 *                       with the violation detail as `feedback`.
 *                       Iterates up to `maxCoherenceCycles`.
 *   Pass C (project):   `designProjectTests` generates integration
 *                       tests for the whole assembly.
 *   Pass D (harden):    topo-ordered `hardenDispatch` re-implements
 *                       every function with tests + architect review.
 *                       Status is reset off `tests-green` first so the
 *                       dispatcher's pre-test short-circuit doesn't
 *                       skip regeneration.
 *   Finalize:           full vitest + typecheck.
 *
 * Dispatches receive `opts.projectDir` (warmed once per plan for vitest
 * module-cache reuse) and optional `opts.feedback` (coherence only).
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import type { FinalizeReport, FinalizeOptions } from "./finalize.js";
import type { BuildReport } from "./design-build.js";
import { designPlan } from "./design-plan.js";
import { designCoherence } from "./design-coherence.js";
import { designProjectTests } from "./design-project-tests.js";
import { createProjectDir, type ProjectDir } from "./test-runner.js";
import { debug } from "./debug.js";

export interface DispatchOpts {
  projectDir?: string;
  /** Optional violation detail threaded into the implementer prompt on
   *  coherence re-dispatch. Ignored in sketch / harden passes. */
  feedback?: string;
}

export type DispatchFn = (
  graph: DesignGraph,
  module: string,
  name: string,
  opts?: DispatchOpts,
) => Promise<DispatchResult>;

export type FinalizeFn = (
  graph: DesignGraph,
  options?: FinalizeOptions,
) => Promise<FinalizeReport>;

export interface ThreePassPlanOptions {
  chat: (prompt: string) => Promise<string>;
  sketchDispatch: DispatchFn;
  hardenDispatch: DispatchFn;
  finalize: FinalizeFn;
  maxShapeRetries?: number;
  /** Coherence-fix iterations before giving up. Default 3. */
  maxCoherenceCycles?: number;
  /** Warm a persistent project dir for the harden pass so vitest reuses
   *  its compiled-module cache. Default true; disable in tests. */
  useProjectDir?: boolean;
}

function noopFinalize(): FinalizeReport {
  return {
    ok: true,
    files: {},
    unimplemented: [],
    consistency: { ok: true, violations: [], advisories: [] },
    testsPassed: 0,
    testsFailed: 0,
    testOutput: "",
    typecheckOk: true,
    typecheckOutput: "",
  };
}

export async function designPlanThreePass(
  graph: DesignGraph,
  task: string,
  options: ThreePassPlanOptions,
): Promise<BuildReport> {
  // ─── Pass A: sketch ────────────────────────────────────────────────
  // designPlan handles phases 0–2 and invokes designBuild with the
  // sketch dispatch. We supply a no-op finalize — finalize runs fully
  // in pass D after hardening. Adapter re-shapes sketchDispatch into
  // designPlan's four-arg (graph, module, name, projectDir?) form.
  debug("three-pass", "pass A: sketch");
  const sketchReport = await designPlan(graph, task, {
    chat: options.chat,
    dispatch: async (g, mod, name, projectDir) =>
      options.sketchDispatch(g, mod, name, { projectDir }),
    finalize: async () => noopFinalize(),
    maxShapeRetries: options.maxShapeRetries,
  });
  if (!sketchReport.ok) {
    debug(
      "three-pass",
      `sketch failed at phase=${sketchReport.phase}; aborting`,
    );
    return sketchReport;
  }

  // ─── Pass B: coherence fix loop ───────────────────────────────────
  const maxCycles = options.maxCoherenceCycles ?? 3;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const coh = await designCoherence(graph);
    debug(
      "three-pass",
      `coherence cycle ${cycle + 1}/${maxCycles} — ok=${coh.ok} violations=${coh.violations.length}`,
    );
    if (coh.ok) break;
    // Collect re-dispatch targets. `orphan` names the CALLEE (the one
    // nothing calls); fix must target its decomposition parent (the
    // call site that's missing). Other kinds name the caller directly.
    // Each target's feedback aggregates all violations pointing at it.
    const targets = new Map<
      string,
      { module: string; name: string; feedback: string[] }
    >();
    for (const v of coh.violations) {
      let tMod = v.module;
      let tName = v.name;
      if (v.kind === "orphan") {
        const node = graph.getFunction(v.module, v.name);
        if (node?.parent) {
          const parentNode = graph
            .listFunctions()
            .find((f) => f.name === node.parent);
          if (parentNode) {
            tMod = parentNode.module;
            tName = parentNode.name;
          }
        }
      }
      const key = `${tMod}#${tName}`;
      const entry =
        targets.get(key) ?? { module: tMod, name: tName, feedback: [] };
      entry.feedback.push(`[${v.kind}] ${v.detail}`);
      targets.set(key, entry);
    }
    for (const { module, name, feedback } of targets.values()) {
      try {
        await options.sketchDispatch(graph, module, name, {
          feedback: feedback.join("\n"),
        });
      } catch (e) {
        debug(
          "three-pass",
          `coherence re-dispatch ${module}#${name} threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // ─── Pass C: project-level integration tests ──────────────────────
  debug("three-pass", "pass C: project tests");
  const ptReport = await designProjectTests(graph, task, {
    chat: options.chat,
    maxRetries: options.maxShapeRetries,
  });
  if (!ptReport.ok) {
    debug("three-pass", `project tests failed: ${ptReport.error}`);
    return {
      ok: false,
      phase: "project-tests",
      consistency: graph.consistency(),
      dispatched: [],
      failed: [],
      finalize: null,
      files: {},
    };
  }

  // ─── Pass D: harden ───────────────────────────────────────────────
  // Warm a persistent project dir so vitest reuses its module cache
  // across dispatches. Reset each function's status off "tests-green"
  // before dispatching so design-dispatch.ts's pre-test short-circuit
  // doesn't skip LLM regeneration.
  debug("three-pass", "pass D: harden");
  const useProjectDir = options.useProjectDir ?? true;
  let projectDir: ProjectDir | null = null;
  if (useProjectDir) {
    try {
      projectDir = await createProjectDir(graph);
      debug("three-pass", `warmed project dir ${projectDir.path}`);
    } catch (e) {
      debug(
        "three-pass",
        `project dir init failed (${e instanceof Error ? e.message : String(e)}); falling back to cold tmpdirs`,
      );
    }
  }
  try {
    const dispatched: DispatchResult[] = [];
    const failed: DispatchResult[] = [];
    for (const fn of graph.topoSortFunctions()) {
      // Clear sketched tests-green status so dispatch re-runs the full
      // test + review pipeline instead of short-circuiting.
      if (fn.status === "tests-green") {
        graph.setTestStatus(fn.module, fn.name, "implemented", "");
      }
      let result: DispatchResult;
      try {
        result = await options.hardenDispatch(graph, fn.module, fn.name, {
          projectDir: projectDir?.path,
        });
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
      dispatched.push(result);
      if (result.status !== "tests-green") failed.push(result);
    }
    if (failed.length > 0) {
      debug(
        "three-pass",
        `harden failed: ${failed.length}/${dispatched.length} red`,
      );
      return {
        ok: false,
        phase: "dispatch",
        consistency: graph.consistency(),
        dispatched,
        failed,
        finalize: null,
        files: {},
      };
    }

    // ─── Finalize ───────────────────────────────────────────────────
    debug("three-pass", "finalize");
    const finalizeReport = await options.finalize(graph, { typecheck: true });
    if (!finalizeReport.ok) {
      return {
        ok: false,
        phase: "finalize",
        consistency: graph.consistency(),
        dispatched,
        failed: [],
        finalize: finalizeReport,
        files: finalizeReport.files,
      };
    }
    return {
      ok: true,
      phase: "done",
      consistency: graph.consistency(),
      dispatched,
      failed: [],
      finalize: finalizeReport,
      files: finalizeReport.files,
    };
  } finally {
    if (projectDir) {
      await projectDir.dispose();
    }
  }
}
