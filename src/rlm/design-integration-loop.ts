/**
 * Phase G — integration run + fix loop.
 *
 * Replaces the per-function harden pass with an integration-driven
 * fix cycle: run the project-level tests, attribute each failure to
 * a function (via `attributeFailure`), dispatch that function with
 * the test failure text as feedback. Repeat until green or until
 * `maxIterations`.
 *
 * Failures that can't be attributed (no project frame matches a
 * function AND the LLM fallback fails) are SKIPPED with a warning
 * log — they don't block other fixes in the same iteration.
 *
 * Dispatch collapses per iteration: if three tests fail in the same
 * function, we dispatch that function ONCE per cycle, not three
 * times. The fixed body is re-tested against all three failures on
 * the next run.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./design-dispatch.js";
import { attributeFailure } from "./design-attribution.js";
import { debug } from "./debug.js";

export interface IntegrationFailure {
  testName: string;
  stackTrace: string;
  message: string;
}

export interface IntegrationRunResult {
  ok: boolean;
  failures: IntegrationFailure[];
}

export type IntegrationRunner = (
  graph: DesignGraph,
) => Promise<IntegrationRunResult>;

export type FixDispatch = (
  graph: DesignGraph,
  module: string,
  name: string,
  opts?: { feedback?: string; projectDir?: string },
) => Promise<DispatchResult>;

export interface IntegrationLoopOptions {
  runner: IntegrationRunner;
  dispatch: FixDispatch;
  /** Chat for the attribution fallback (LLM picks the target when no
   *  stack frame resolves to a known function). */
  chat: (prompt: string) => Promise<string>;
  /** Hard cap on run → fix cycles. Default 5. */
  maxIterations?: number;
  /** Warm project dir forwarded to each fix dispatch (reuses vitest
   *  module cache). Optional. */
  projectDir?: string;
}

export interface IntegrationLoopReport {
  ok: boolean;
  /** Number of runner invocations completed. */
  iterations: number;
  /** Count of failures observed per iteration. */
  failuresByIteration: number[];
  /** Function names dispatched across the loop (may repeat). */
  dispatched: string[];
  error: string | null;
}

function buildFeedback(failures: IntegrationFailure[]): string {
  return failures
    .map(
      (f) =>
        `Integration test "${f.testName}" failed:\n${f.message}\n\nStack:\n${f.stackTrace.trim()}`,
    )
    .join("\n\n---\n\n");
}

export async function runIntegrationLoop(
  graph: DesignGraph,
  options: IntegrationLoopOptions,
): Promise<IntegrationLoopReport> {
  const maxIter = options.maxIterations ?? 5;
  const failuresByIteration: number[] = [];
  const dispatched: string[] = [];
  let iter = 0;
  while (iter < maxIter) {
    iter++;
    debug("integration-loop", `iteration ${iter}/${maxIter} — running`);
    const result = await options.runner(graph);
    failuresByIteration.push(result.failures.length);
    if (result.ok) {
      return {
        ok: true,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: null,
      };
    }
    debug(
      "integration-loop",
      `iteration ${iter} — ${result.failures.length} failure(s); attributing`,
    );
    // Collapse failures by attributed function so we don't redundantly
    // dispatch the same body three times in one cycle. Group failures
    // under the attribution so feedback can include the full context.
    const grouped = new Map<string, IntegrationFailure[]>();
    for (const failure of result.failures) {
      const attr = await attributeFailure(graph, failure.stackTrace, {
        chat: options.chat,
      });
      if (!attr.function) {
        debug(
          "integration-loop",
          `unattributable failure "${failure.testName}" — skipping`,
        );
        continue;
      }
      if (!grouped.has(attr.function)) grouped.set(attr.function, []);
      grouped.get(attr.function)!.push(failure);
    }
    if (grouped.size === 0) {
      // Nothing we can act on; bail rather than spin.
      return {
        ok: false,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: `no failure attributable to any function in the graph after ${iter} iteration(s)`,
      };
    }
    for (const [name, failures] of grouped) {
      const fn = graph.listFunctions().find((f) => f.name === name);
      if (!fn) {
        debug("integration-loop", `function "${name}" vanished mid-loop`);
        continue;
      }
      dispatched.push(name);
      await options.dispatch(graph, fn.module, fn.name, {
        feedback: buildFeedback(failures),
        projectDir: options.projectDir,
      });
    }
  }
  return {
    ok: false,
    iterations: iter,
    failuresByIteration,
    dispatched,
    error: `integration loop exhausted after ${maxIter} iterations`,
  };
}
