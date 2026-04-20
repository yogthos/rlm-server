/**
 * Integration-driven plan orchestrator.
 *
 * Supersedes `design-plan-three-pass.ts`. The pipeline now bets on
 * integration tests at the edges rather than unit-test TDD for every
 * function. Per-function harden still runs — unit tests are useful
 * scaffolding — but is scoped to "do your best, don't block the plan"
 * semantics. Correctness is verified by the integration loop.
 *
 *   Pass A (sketch)          phases 0–2 + body-only skeleton. Unchanged.
 *   Pass B (coherence)       Prolog call-graph fixes. Unchanged.
 *   Pass C (harden)          topo-ordered full dispatch. Failures DO NOT
 *                            fail the plan — we move on to integration.
 *                            Unit tests help the implementer reason but
 *                            don't gate completion.
 *   Pass D (paths)            enumerate call-graph paths from entry
 *                            points. Silent, pure graph walk.
 *   Pass E (integration       author one test per path + supplementary
 *         tests)              LLM-inferred tests.
 *   Pass F (integration       architect reviews each test; REVISE →
 *         review)             rewrite, bounded.
 *   Pass G (integration       run tests → attribute failures → dispatch
 *         loop)               targeted fixes → retry. Bounded.
 *   Finalize                  full vitest + tsc.
 *
 * On loop exhaustion we return `phase: "integration"` with the loop's
 * failure context preserved in `files` so the user can debug.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import type { FinalizeReport, FinalizeOptions } from "./finalize.js";
import type { BuildReport } from "./design-build.js";
import { designPlan } from "./design-plan.js";
import { designCoherence } from "./design-coherence.js";
import { enumeratePaths } from "./design-paths.js";
import { designIntegrationTests } from "./design-integration-tests.js";
import { reviewIntegrationTests } from "./design-integration-review.js";
import {
  runIntegrationLoop,
  type IntegrationRunner,
  type FixDispatch,
} from "./design-integration-loop.js";
import { createProjectDir, type ProjectDir } from "./test-runner.js";
import { debug } from "./debug.js";

export interface DispatchOpts {
  projectDir?: string;
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

export interface IntegrationPlanOptions {
  chat: (prompt: string) => Promise<string>;
  sketchDispatch: DispatchFn;
  hardenDispatch: DispatchFn;
  /** Fix dispatch called by the integration loop. Typically the same
   *  as hardenDispatch with mode="harden" and a feedback channel. */
  fixDispatch: FixDispatch;
  integrationRunner: IntegrationRunner;
  finalize: FinalizeFn;
  maxShapeRetries?: number;
  maxCoherenceCycles?: number;
  /** Integration run + fix cycles before giving up. Default 5. */
  maxIntegrationIterations?: number;
  /** Review cycles per integration test. Default 2. */
  maxIntegrationReviewCycles?: number;
  /** Warm persistent project dir for finalize + fix dispatches. Default
   *  true; disable in tests that don't need real disk. */
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

export async function designPlanIntegration(
  graph: DesignGraph,
  task: string,
  options: IntegrationPlanOptions,
): Promise<BuildReport> {
  // ─── Pass A: sketch ────────────────────────────────────────────────
  debug("plan-integration", "pass A: sketch");
  const sketchReport = await designPlan(graph, task, {
    chat: options.chat,
    dispatch: async (g, mod, name, projectDir) =>
      options.sketchDispatch(g, mod, name, { projectDir }),
    finalize: async () => noopFinalize(),
    maxShapeRetries: options.maxShapeRetries,
  });
  if (!sketchReport.ok) {
    debug("plan-integration", `sketch failed at ${sketchReport.phase}`);
    return sketchReport;
  }

  // ─── Pass B: coherence ────────────────────────────────────────────
  const maxCohCycles = options.maxCoherenceCycles ?? 3;
  for (let cycle = 0; cycle < maxCohCycles; cycle++) {
    const coh = await designCoherence(graph);
    if (coh.ok) break;
    const targets = new Map<string, { module: string; name: string; fb: string[] }>();
    for (const v of coh.violations) {
      let tMod = v.module;
      let tName = v.name;
      if (v.kind === "orphan") {
        const node = graph.getFunction(v.module, v.name);
        if (node?.parent) {
          const p = graph.listFunctions().find((f) => f.name === node.parent);
          if (p) {
            tMod = p.module;
            tName = p.name;
          }
        }
      }
      const key = `${tMod}#${tName}`;
      const entry = targets.get(key) ?? { module: tMod, name: tName, fb: [] };
      entry.fb.push(`[${v.kind}] ${v.detail}`);
      targets.set(key, entry);
    }
    for (const { module, name, fb } of targets.values()) {
      try {
        await options.sketchDispatch(graph, module, name, {
          feedback: fb.join("\n"),
        });
      } catch {}
    }
  }

  // ─── Pass C: harden (best-effort, non-blocking) ───────────────────
  debug("plan-integration", "pass C: harden");
  for (const fn of graph.topoSortFunctions()) {
    if (fn.status === "tests-green") {
      graph.setTestStatus(fn.module, fn.name, "implemented", "");
    }
    try {
      await options.hardenDispatch(graph, fn.module, fn.name);
    } catch (e) {
      debug(
        "plan-integration",
        `harden ${fn.name} threw (continuing): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Swallow exhaustion / failure — integration loop is the truth-teller.
  }

  // ─── Pass D: path enumeration ─────────────────────────────────────
  const paths = enumeratePaths(graph);
  debug("plan-integration", `pass D: ${paths.length} path(s) enumerated`);

  // ─── Pass E: integration test authoring ───────────────────────────
  debug("plan-integration", "pass E: author integration tests");
  const authoring = await designIntegrationTests(graph, task, {
    chat: options.chat,
    maxRetries: options.maxShapeRetries,
    paths,
  });
  if (!authoring.ok) {
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

  // ─── Pass F: integration test review ──────────────────────────────
  debug("plan-integration", "pass F: review integration tests");
  const review = await reviewIntegrationTests(graph, task, {
    chat: options.chat,
    maxReviewCycles: options.maxIntegrationReviewCycles,
  });
  if (!review.ok) {
    debug(
      "plan-integration",
      `review flagged unresolved issue (continuing): ${review.error}`,
    );
    // Non-fatal: an unreviewed test may still catch real bugs.
  }

  // ─── Pass G: integration run + fix loop ───────────────────────────
  const useDir = options.useProjectDir ?? true;
  let projectDir: ProjectDir | null = null;
  if (useDir) {
    try {
      projectDir = await createProjectDir(graph);
    } catch (e) {
      debug(
        "plan-integration",
        `project dir init failed (continuing without warm dir): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  try {
    debug("plan-integration", "pass G: integration loop");
    const loop = await runIntegrationLoop(graph, {
      runner: options.integrationRunner,
      dispatch: options.fixDispatch,
      chat: options.chat,
      maxIterations: options.maxIntegrationIterations,
      projectDir: projectDir?.path,
    });
    if (!loop.ok) {
      return {
        ok: false,
        phase: "integration",
        consistency: graph.consistency(),
        dispatched: [],
        failed: [],
        finalize: null,
        files: {},
      };
    }

    // ─── Finalize ───────────────────────────────────────────────────
    const finalizeReport = await options.finalize(graph, { typecheck: true });
    if (!finalizeReport.ok) {
      return {
        ok: false,
        phase: "finalize",
        consistency: graph.consistency(),
        dispatched: [],
        failed: [],
        finalize: finalizeReport,
        files: finalizeReport.files,
      };
    }
    return {
      ok: true,
      phase: "done",
      consistency: graph.consistency(),
      dispatched: [],
      failed: [],
      finalize: finalizeReport,
      files: finalizeReport.files,
    };
  } finally {
    if (projectDir) await projectDir.dispose();
  }
}
