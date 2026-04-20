/**
 * Integration-driven plan orchestrator.
 *
 * After Round 17-20 the pipeline is:
 *
 *   Phase 0-2 (structure)  designPlan with skipBuild=true. Architect
 *                           produces package.json, function list, and
 *                           a FunctionSpec per function. No bodies.
 *   Phase 3 (coherence)     Structure check on spec.dependencies —
 *                           phantom deps, orphans, cycles. Hard fail
 *                           on cycles; re-ask LLM on phantom/orphan
 *                           up to maxCoherenceCycles times.
 *   Phase 4 (leaf-up build) Bottom-up dispatch via designLeafUpBuild.
 *                           Each function is implemented ONCE against
 *                           real, tests-green dependencies.
 *   Phase 5 (paths)         Enumerate call-graph paths from roots.
 *   Phase 6 (int. tests)    LLM authors one test per path + extras.
 *   Phase 7 (int. review)   Architect reviews each integration test.
 *   Phase 8 (int. loop)     Run tests → attribute failures → fix.
 *   Finalize                Full vitest + tsc.
 *
 * The sketch pass and per-function harden pass are gone. Leaf-up
 * replaces both with a single ordered dispatch.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import type { FinalizeReport, FinalizeOptions } from "./finalize.js";
import type { BuildReport } from "./design-build.js";
import { designPlan } from "./design-plan.js";
import { designCoherence } from "./design-coherence.js";
import { designLeafUpBuild } from "./design-leaf-up-build.js";
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
  /** Full harden dispatch — generates body + unit tests + runs them
   *  + architect review. Called once per function during leaf-up. */
  hardenDispatch: DispatchFn;
  /** Fix dispatch called by the integration loop. Typically the same
   *  as hardenDispatch with a feedback channel. */
  fixDispatch: FixDispatch;
  integrationRunner: IntegrationRunner;
  finalize: FinalizeFn;
  maxShapeRetries?: number;
  /** Coherence fix-cycles before bailing. Default 3. */
  maxCoherenceCycles?: number;
  /** Integration run + fix cycles before giving up. Default 5. */
  maxIntegrationIterations?: number;
  /** Review cycles per integration test. Default 2. */
  maxIntegrationReviewCycles?: number;
  /** Warm persistent project dir for finalize + fix dispatches. Default
   *  true; disable in tests that don't need real disk. */
  useProjectDir?: boolean;
}

function emptyReport(
  phase: BuildReport["phase"],
  consistency?: BuildReport["consistency"],
): BuildReport {
  return {
    ok: false,
    phase,
    consistency: consistency ?? { ok: false, violations: [], advisories: [] },
    dispatched: [],
    failed: [],
    finalize: null,
    files: {},
  };
}

export async function designPlanIntegration(
  graph: DesignGraph,
  task: string,
  options: IntegrationPlanOptions,
): Promise<BuildReport> {
  // ─── Phase 0-2: structure only (no bodies) ────────────────────────
  debug("plan-integration", "phase 0-2: structure");
  const planReport = await designPlan(graph, task, {
    chat: options.chat,
    maxShapeRetries: options.maxShapeRetries,
    skipBuild: true,
  });
  if (!planReport.ok) {
    debug("plan-integration", `structure phase failed at ${planReport.phase}`);
    return planReport;
  }

  // ─── Phase 3: structure coherence ─────────────────────────────────
  // Cycles are hard-fail. Phantom deps / orphans are soft — we ask the
  // architect to fix by re-dispatching an implementer. But since we
  // don't have bodies yet, the "fix" here means asking the architect
  // to revise specs. For now we surface as a structural failure and
  // bail if coherence can't be made clean.
  debug("plan-integration", "phase 3: structure coherence");
  const maxCohCycles = options.maxCoherenceCycles ?? 3;
  let cohReport = await designCoherence(graph);
  let cohAttempt = 0;
  while (!cohReport.ok && cohAttempt < maxCohCycles) {
    cohAttempt++;
    const hasCycle = cohReport.violations.some((v) => v.kind === "cycle");
    if (hasCycle) {
      debug(
        "plan-integration",
        `cycle detected — cannot self-heal. Aborting.`,
      );
      return emptyReport("consistency", {
        ok: false,
        violations: [],
        advisories: [],
      });
    }
    // Phantom-dep / orphan: ask the architect to revise one affected
    // function's spec. We don't have a spec-revision LLM path yet,
    // so just bail with the violations visible to the caller.
    debug(
      "plan-integration",
      `structure coherence has ${cohReport.violations.length} violation(s); no auto-fix yet — bailing`,
    );
    break;
  }
  if (!cohReport.ok) {
    // Non-cycle violations still let the pipeline proceed — leaf-up
    // will skip phantom/orphan functions via dep-gating. Log and go.
    debug(
      "plan-integration",
      `continuing despite ${cohReport.violations.length} coherence warning(s)`,
    );
  }

  // ─── Phase 4: leaf-up build ───────────────────────────────────────
  debug("plan-integration", "phase 4: leaf-up build");
  const buildReport = await designLeafUpBuild(graph, {
    dispatch: async (g, mod, name, opts) =>
      options.hardenDispatch(g, mod, name, opts),
  });
  if (!buildReport.ok && buildReport.error) {
    // Hard structural error (e.g., cycle caught by computeDependencyLevels).
    return emptyReport("consistency", graph.consistency());
  }
  if (buildReport.blocked.length > 0) {
    debug(
      "plan-integration",
      `leaf-up build: ${buildReport.blocked.length} blocked (${buildReport.blocked.join(", ")}); continuing to integration`,
    );
  }

  // ─── Phase 5: path enumeration ────────────────────────────────────
  const paths = enumeratePaths(graph);
  debug("plan-integration", `phase 5: ${paths.length} path(s) enumerated`);

  // ─── Phase 6: integration test authoring ──────────────────────────
  debug("plan-integration", "phase 6: author integration tests");
  const authoring = await designIntegrationTests(graph, task, {
    chat: options.chat,
    maxRetries: options.maxShapeRetries,
    paths,
  });
  if (!authoring.ok) {
    return emptyReport("project-tests", graph.consistency());
  }

  // ─── Phase 7: integration test review ─────────────────────────────
  debug("plan-integration", "phase 7: review integration tests");
  const review = await reviewIntegrationTests(graph, task, {
    chat: options.chat,
    maxReviewCycles: options.maxIntegrationReviewCycles,
  });
  if (!review.ok) {
    debug(
      "plan-integration",
      `review flagged unresolved issue (continuing): ${review.error}`,
    );
  }

  // ─── Phase 8: integration run + fix loop ──────────────────────────
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
    debug("plan-integration", "phase 8: integration loop");
    const loop = await runIntegrationLoop(graph, {
      runner: options.integrationRunner,
      dispatch: options.fixDispatch,
      chat: options.chat,
      maxIterations: options.maxIntegrationIterations,
      projectDir: projectDir?.path,
    });
    if (!loop.ok) {
      return emptyReport("integration", graph.consistency());
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
