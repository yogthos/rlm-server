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
import { extractJson } from "./design-plan.js";
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
  /** Round 16: when a test name fails in two consecutive iterations
   *  (fix didn't stick), ask the LLM for one additional integration
   *  test that articulates the bug from a different angle. The new
   *  test lands on the graph via `addProjectTest`. Default true. */
  augmentOnRecurrence?: boolean;
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

function buildAugmentPrompt(
  recurring: IntegrationFailure,
  iteration: number,
): string {
  return [
    `An integration test has failed for ${iteration} iterations in a row.`,
    "The fix attempts haven't resolved the underlying bug. Coverage is",
    "likely thin — the existing assertion may not fully articulate what's",
    "broken. Author ONE additional integration test that exercises the",
    "same scenario from a different angle (different input, different",
    "side-effect check, different assertion shape) so the bug has a",
    "concrete second witness.",
    "",
    `Recurring test name: ${recurring.testName}`,
    `Message: ${recurring.message}`,
    "Stack (excerpt):",
    recurring.stackTrace.split("\n").slice(0, 10).join("\n"),
    "",
    "Return ONLY a fenced JSON object (SINGLE test):",
    "```json",
    '{"name": "<new test name>", "code": "<test body>"}',
    "```",
  ].join("\n");
}

async function augmentTestsForRecurrence(
  graph: DesignGraph,
  recurring: IntegrationFailure,
  iteration: number,
  chat: (prompt: string) => Promise<string>,
): Promise<void> {
  try {
    const response = await chat(buildAugmentPrompt(recurring, iteration));
    const parsed = extractJson(response);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const r = parsed as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.code !== "string") return;
    // Avoid duplicating an existing test name.
    const existing = new Set(graph.listProjectTests().map((t) => t.name));
    if (existing.has(r.name)) return;
    graph.addProjectTest({ name: r.name, code: r.code });
    debug(
      "integration-loop",
      `augmented tests with "${r.name}" (recurrence witness)`,
    );
  } catch (e) {
    debug(
      "integration-loop",
      `augment threw (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export async function runIntegrationLoop(
  graph: DesignGraph,
  options: IntegrationLoopOptions,
): Promise<IntegrationLoopReport> {
  const maxIter = options.maxIterations ?? 5;
  const augment = options.augmentOnRecurrence ?? true;
  const failuresByIteration: number[] = [];
  const dispatched: string[] = [];
  /** Per-test iteration counters — how many cycles each test has been
   *  failing. Drives the recurrence threshold for augmentation. */
  const recurrenceCount = new Map<string, number>();
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
    // Track recurrence — tests that fail again bump their counter;
    // tests that no longer appear drop back to 0 on next iteration.
    const currentNames = new Set(result.failures.map((f) => f.testName));
    for (const name of [...recurrenceCount.keys()]) {
      if (!currentNames.has(name)) recurrenceCount.delete(name);
    }
    if (augment) {
      for (const failure of result.failures) {
        const prior = recurrenceCount.get(failure.testName) ?? 0;
        const next = prior + 1;
        recurrenceCount.set(failure.testName, next);
        // On the 2nd consecutive occurrence, augment once.
        if (next === 2) {
          await augmentTestsForRecurrence(graph, failure, next, options.chat);
        }
      }
    }
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
