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
import type { DispatchResult } from "./dispatch-types.js";
import {
  attributeFailure,
  attributeStackDirect,
  isAbortError,
} from "./design-attribution.js";
import {
  extractProjectTestFile,
  parseProjectTestList,
} from "./design-project-tests.js";
import { extractJson } from "./design-plan.js";
import { isProjectTestFailure } from "./design-project-test-repair.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";
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
  /** Fix dispatch for FUNCTION targets — failures attributed to a
   *  specific function in the graph. Called with failure feedback. */
  dispatch: FixDispatch;
  /** Fix dispatch for the project integration TEST FILE itself.
   *  Called when failures are synthetic runner crashes (test file
   *  failed to load) or when stack frames point at the integration
   *  test file rather than any function. Without this callback such
   *  failures fall through to regular attribution and usually get
   *  mis-attributed to an arbitrary function. */
  fixProjectTests?: (
    graph: DesignGraph,
    failures: IntegrationFailure[],
  ) => Promise<void>;
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
  // Self-tagged: dispatch no longer wraps externalFeedback, so the
  // sender owns the header.
  const body = failures
    .map(
      (f) =>
        `Integration test "${f.testName}" failed:\n${f.message}\n\nStack:\n${f.stackTrace.trim()}`,
    )
    .join("\n\n---\n\n");
  return `[integration-loop feedback]\n${body}`;
}

function buildAugmentPrompt(
  graph: DesignGraph,
  recurring: IntegrationFailure,
  iteration: number,
  attributedFnName: string,
): string {
  const fn = graph.listFunctions().find((f) => f.name === attributedFnName);
  const fnBlock: string[] = [];
  if (fn) {
    const params = fn.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    fnBlock.push(
      `Target function (attributed from the stack trace):`,
      `  ${fn.name}(${params}): ${fn.signature.returnType}`,
      `  purpose: ${fn.spec?.purpose ?? "(no spec)"}`,
    );
    if (fn.implementation) {
      fnBlock.push(
        "  body:",
        "  ```ts",
        ...fn.implementation.split("\n").slice(0, 40).map((l) => `    ${l}`),
        "  ```",
      );
    }
    if (fn.tests.length > 0) {
      fnBlock.push(
        `  existing unit tests (${fn.tests.length}):`,
        ...fn.tests.slice(0, 8).map((t) => `    - ${t.name}`),
      );
    }
    if (fn.integrationTests.length > 0) {
      fnBlock.push(
        `  existing integration tests (${fn.integrationTests.length}):`,
        ...fn.integrationTests.slice(0, 6).map((t) => `    - ${t.name}`),
      );
    }
    // Phase N8 — show graph-backed context so the author knows which
    // OTHER functions exercise this one (callers) and which siblings
    // it in turn calls. Both derived from tree-sitter-analyzed edges.
    const callers = graph
      .listFunctions()
      .filter((other) => other.analyzedCallees.includes(fn.name))
      .map((o) => o.name);
    if (callers.length > 0) {
      fnBlock.push(
        `  called by: ${callers.join(", ")}`,
      );
    }
    if (fn.analyzedCallees.length > 0) {
      fnBlock.push(
        `  calls: ${fn.analyzedCallees.join(", ")}`,
      );
    }
  }
  const currentFile = graph.getProjectTestFile();
  const existingFileBlock = currentFile
    ? [
        "Current project.integration.test.ts — append to this, don't duplicate:",
        "```ts",
        currentFile,
        "```",
      ]
    : [
        "No project.integration.test.ts yet — write one from scratch that",
        "covers this scenario.",
      ];
  return [
    `An integration test has failed for ${iteration} iterations in a row.`,
    "The fix attempts haven't resolved the underlying bug. Coverage is",
    "likely thin — the existing assertion may not fully articulate what's",
    "broken. Revise the project integration test file to add ONE more",
    "additional integration test that exercises the same scenario from a different angle",
    "(different input, different side-effect check, different assertion",
    "shape) so the bug has a concrete second witness.",
    ...renderDecisionsBlock(graph),
    `Recurring test name: ${recurring.testName}`,
    `Message: ${recurring.message}`,
    "Stack (excerpt):",
    recurring.stackTrace.split("\n").slice(0, 10).join("\n"),
    "",
    ...fnBlock,
    "",
    ...existingFileBlock,
    "",
    "Call project functions naturally — direct import, no framework wrapper.",
    "",
    "OUTPUT — emit ONE fence with the COMPLETE revised source of",
    "`project.integration.test.ts` (preserve existing tests + add the",
    "new one):",
    "",
    "```project-test-file",
    "// entire revised project.integration.test.ts",
    "```",
  ].join("\n");
}

async function augmentTestsForRecurrence(
  graph: DesignGraph,
  recurring: IntegrationFailure,
  iteration: number,
  chat: (prompt: string) => Promise<string>,
): Promise<void> {
  // Skip synthetic project.* failures — they can't be "witnessed" by
  // more tests (they're environmental crashes, not assertion failures).
  // Adding tests just piles up noise; run 10 saw this amplify phantom
  // crashes into new phantom tests.
  if (isProjectTestFailure(recurring)) {
    debug(
      "integration-loop",
      `augment skipped for synthetic "${recurring.testName}" — no test can witness an environmental crash`,
    );
    return;
  }
  // Attribute the failure BEFORE authoring so the prompt can show the
  // model which function is actually involved (and what tests already
  // cover it). Direct-only attribution — no LLM call for this step.
  const attributed = attributeStackDirect(graph, recurring.stackTrace);
  if (!attributed) {
    debug(
      "integration-loop",
      `augment skipped for "${recurring.testName}" — unattributable stack, author wouldn't know what to witness`,
    );
    return;
  }
  try {
    const response = await chat(
      buildAugmentPrompt(graph, recurring, iteration, attributed),
    );
    // Wrapper-kill path — architect emits the full revised file.
    const fileContent = extractProjectTestFile(response);
    if (fileContent !== null) {
      graph.setProjectTestFile(fileContent);
      graph.replaceProjectTests([]);
      debug(
        "integration-loop",
        `augmented project test file (${fileContent.length} chars, witness for ${attributed})`,
      );
      return;
    }
    // Legacy fallback — single {name, code} JSON object. Kept so
    // mid-migration runs don't fall over.
    const parsed = extractJson(response);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const r = parsed as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.code !== "string") return;
    const existing = new Set(graph.listProjectTests().map((t) => t.name));
    if (existing.has(r.name)) return;
    try {
      parseProjectTestList([{ name: r.name, code: r.code }]);
    } catch (e) {
      debug(
        "integration-loop",
        `augment response rejected — ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    graph.addProjectTest({ name: r.name, code: r.code });
    debug(
      "integration-loop",
      `augmented tests with "${r.name}" (legacy JSON path; witness for ${attributed})`,
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
  /** Signature of the prior iteration's failures + whether the prior
   *  iteration attempted any fix. Drives the no-progress guard below —
   *  "same failures twice running AND we tried to fix" = bail.
   *  Covers both environmental loops (synthetic repeats) and broader
   *  no-progress (missing db/service, failing assertion that repairs
   *  can't address, etc). `priorAugmentedLastIter` grants one extra
   *  iteration after augmentation so the new witness test's result
   *  can be observed before we call the loop stuck. */
  let priorFailuresSignature: string | null = null;
  let priorAttemptedFix = false;
  let priorAugmentedLastIter = false;
  let iter = 0;
  while (iter < maxIter) {
    iter++;
    debug("integration-loop", `iteration ${iter}/${maxIter} — running`);
    let result: IntegrationRunResult;
    try {
      result = await options.runner(graph);
    } catch (e) {
      // Phase U2 — runner can throw on misconfiguration (e.g. missing
      // decisions.testCommand). Treat a thrown runner as an integration
      // failure so the loop's normal failure path runs: no crash, and
      // the error propagates through the ok=false return.
      const msg = e instanceof Error ? e.message : String(e);
      debug("integration-loop", `runner threw: ${msg}`);
      return {
        ok: false,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: `runner threw: ${msg}`,
      };
    }
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
    // No-progress guard setup. Computes current iteration's failure
    // signature. The actual bail decision runs BELOW, after any
    // augmentation — augmentation is itself a prospective fix
    // (authors a new test) and deserves one iteration to see its
    // effect before we call the loop stuck.
    //
    // Bail cases the guard catches:
    //   - Environmental crash (tsc/vitest crash repeats) — fast path
    //     bails even without priorAttemptedFix (nothing to wait for)
    //   - Missing external dep (db/service unreachable, import fail)
    //   - Over-specific test that fix-dispatches can't satisfy
    //   - Cross-function bug that one-function-at-a-time repair can't
    //     cohere on
    // Synthetic `project.*` messages embed PIDs (`(node:12345)`) and
    // varying stderr tails — using them in the signature would prevent
    // the guard from detecting repeats. For synthetics, sign on the
    // testName ALONE (names are stable across iters). For real
    // failures, keep message[0..200] since assertion text is stable
    // and distinguishes per-test failures.
    const currentSignature = result.failures
      .map((f) =>
        isProjectTestFailure(f)
          ? f.testName
          : `${f.testName}::${f.message.slice(0, 200)}`,
      )
      .sort()
      .join("||");
    const allSynthetic =
      result.failures.length > 0 &&
      result.failures.every(isProjectTestFailure);
    // Reset attempt tracker for THIS iteration — will be set true
    // below by augmentation, dispatch, or repair.
    let thisIterAttempted = false;
    let thisIterAugmented = false;
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
          const beforeCount = graph.listProjectTests().length;
          await augmentTestsForRecurrence(graph, failure, next, options.chat);
          if (graph.listProjectTests().length > beforeCount) {
            // Augmentation added a test — count as a structural fix
            // attempt so the no-progress guard doesn't bail before we
            // see the new test's result in the next iteration.
            thisIterAttempted = true;
            thisIterAugmented = true;
          }
        }
      }
    }
    // Early bail when failures repeat AND either we just ran fix
    // attempts last iter (and they didn't help) OR all failures are
    // synthetic (no repair can help). Placed AFTER augmentation so
    // augmentation gets to run at count=2 before we decide stuck.
    if (
      iter > 1 &&
      currentSignature === priorFailuresSignature &&
      (priorAttemptedFix || allSynthetic) &&
      !priorAugmentedLastIter &&
      !thisIterAugmented
    ) {
      const reason = allSynthetic
        ? `environmental failure loop — ${result.failures.length} synthetic project.* failure(s) unchanged across iterations ${iter - 1} → ${iter}; no user-function attribution possible (likely tsc/vitest/external-service crash that pipeline fixes can't address)`
        : `no-progress loop — ${result.failures.length} failure(s) unchanged across iterations ${iter - 1} → ${iter} despite attempted fixes (possibly missing external dep, cross-function bug, or over-specific test the fix-dispatcher can't satisfy)`;
      debug(
        "integration-loop",
        `no-progress abort at iter ${iter}: ${reason.slice(0, 160)}`,
      );
      return {
        ok: false,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: reason,
      };
    }
    // Collapse failures by attributed target. Two target kinds:
    //   1. project-tests: the project integration TEST FILE is the
    //      problem (synthetic runner crash, or stack frame in
    //      project.integration.test.ts with no function frame).
    //   2. function: existing behavior — attribute to a specific
    //      function in the graph.
    // Cache per-trace attribution so identical stack traces skip the
    // LLM fallback.
    const grouped = new Map<string, IntegrationFailure[]>();
    const projectTestFailures: IntegrationFailure[] = [];
    const attrCache = new Map<string, string | null>();
    // Phase H3 — if the fallback chat aborts (top-level cancel / timeout),
    // every remaining failure would hit the same abort. Bail the whole
    // iteration instead of burning N aborted LLM calls in a row.
    let attributionAborted = false;
    let abortMessage = "";
    for (const failure of result.failures) {
      if (isProjectTestFailure(failure)) {
        projectTestFailures.push(failure);
        continue;
      }
      let fnName = attrCache.get(failure.stackTrace);
      if (fnName === undefined) {
        try {
          const attr = await attributeFailure(graph, failure.stackTrace, {
            chat: options.chat,
          });
          fnName = attr.function;
          attrCache.set(failure.stackTrace, fnName);
        } catch (e) {
          if (isAbortError(e)) {
            attributionAborted = true;
            abortMessage = e instanceof Error ? e.message : String(e);
            break;
          }
          throw e;
        }
      }
      if (!fnName) {
        debug(
          "integration-loop",
          `unattributable failure "${failure.testName}" — skipping`,
        );
        continue;
      }
      if (!grouped.has(fnName)) grouped.set(fnName, []);
      grouped.get(fnName)!.push(failure);
    }
    if (attributionAborted) {
      debug(
        "integration-loop",
        `attribution aborted at iter ${iter} — bailing without dispatches`,
      );
      return {
        ok: false,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: `attribution aborted at iter ${iter}: ${abortMessage}`,
      };
    }
    if (grouped.size === 0 && projectTestFailures.length === 0) {
      // Nothing we can act on; bail rather than spin. Surface a
      // sample failure so the caller can distinguish a genuine dead-
      // end ("nothing attributable") from other cases.
      const sample = result.failures[0];
      const tail = sample
        ? `first failure — ${sample.testName}: ${sample.message.slice(0, 240)}`
        : "(no failures surfaced)";
      return {
        ok: false,
        iterations: iter,
        failuresByIteration,
        dispatched,
        error: `no failure attributable to any function in the graph after ${iter} iteration(s); ${tail}`,
      };
    }
    // Dispatch project-test repairs FIRST — when the test file is
    // broken, function-level fixes can't be validated anyway.
    if (projectTestFailures.length > 0) {
      if (options.fixProjectTests) {
        debug(
          "integration-loop",
          `dispatching project-test repair for ${projectTestFailures.length} failure(s)`,
        );
        dispatched.push("__project-tests__");
        thisIterAttempted = true;
        try {
          await options.fixProjectTests(graph, projectTestFailures);
        } catch (e) {
          debug(
            "integration-loop",
            `fixProjectTests threw (continuing): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else {
        debug(
          "integration-loop",
          `${projectTestFailures.length} project-test failure(s) but no fixProjectTests callback wired — skipping`,
        );
      }
    }
    for (const [name, failures] of grouped) {
      const fn = graph.listFunctions().find((f) => f.name === name);
      if (!fn) {
        debug("integration-loop", `function "${name}" vanished mid-loop`);
        continue;
      }
      dispatched.push(name);
      thisIterAttempted = true;
      try {
        await options.dispatch(graph, fn.module, fn.name, {
          feedback: buildFeedback(failures),
          projectDir: options.projectDir,
        });
      } catch (e) {
        // A thrown dispatch must not kill the whole loop. Log and move
        // to the next target; the next runner invocation will surface
        // whether the fix landed or not.
        debug(
          "integration-loop",
          `dispatch ${name} threw (continuing): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // Persist this iteration's state for the next iteration's
    // no-progress guard.
    priorFailuresSignature = currentSignature;
    priorAttemptedFix = thisIterAttempted;
    priorAugmentedLastIter = thisIterAugmented;
  }
  return {
    ok: false,
    iterations: iter,
    failuresByIteration,
    dispatched,
    error: `integration loop exhausted after ${maxIter} iterations`,
  };
}
