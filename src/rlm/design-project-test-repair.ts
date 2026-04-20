/**
 * Repair project-level integration tests when vitest can't even load
 * them (compile error, bad import, wrong type) or when the test
 * assertions are structurally wrong. Complements `fixDispatch`:
 * function targets get function fixes; test-file targets get test-
 * file fixes.
 *
 * Trigger signals (caller decides when to invoke):
 *   - `project.runner` synthetic failure (runner crashed, no parseable
 *     test results).
 *   - Stack trace pointing at `project.integration.test.ts` with no
 *     in-project function frame.
 *
 * Strategy: hand the LLM the current test list + the full stderr/
 * stdout tail, ask for a revised test list. Replace on success.
 */

import type { DesignGraph, TestSpec } from "./design-graph.js";
import type { IntegrationFailure } from "./design-integration-loop.js";
import { extractJson } from "./design-plan.js";
import { parseProjectTestList } from "./design-project-tests.js";
import { debug } from "./debug.js";

export interface RepairOptions {
  chat: (prompt: string) => Promise<string>;
  task: string;
  maxRetries?: number;
}

export interface RepairReport {
  ok: boolean;
  /** Number of tests after repair. */
  finalCount: number;
  error: string | null;
}

/**
 * Decide whether a failure is best repaired in the project TEST FILE
 * (rewrite the tests) vs. in a function body (regular fix-dispatch).
 *
 * Only the synthetic `project.runner` marker triggers repair. Stack-
 * trace pattern matching is deliberately NOT used: every real
 * integration test's stack trace includes `project.integration.test`
 * (that's where the `expect(...)` line lives), so a regex check there
 * would misroute every genuine function-level assertion failure.
 *
 * Tradeoff: we miss the rare case where the test FILE has a direct
 * assertion not involving any function call. In practice such tests
 * either (a) fail to load entirely → synthetic marker catches them,
 * or (b) are simple enough that mis-routing to a function dispatch
 * doesn't cause pathological loops.
 *
 * Exported so callers (integration loop) can detect without
 * duplicating the rule.
 */
export function isProjectTestFailure(
  failure: IntegrationFailure,
): boolean {
  return failure.testName === "project.runner";
}

function renderCurrentTests(tests: readonly TestSpec[]): string {
  if (tests.length === 0) return "  (no tests currently)";
  return tests
    .map((t, i) => `${i + 1}. "${t.name}"\n\`\`\`\n${t.code}\n\`\`\``)
    .join("\n\n");
}

function renderFailures(failures: readonly IntegrationFailure[]): string {
  return failures
    .map(
      (f) =>
        `- ${f.testName}: ${f.message}\n  stack/err:\n${f.stackTrace.split("\n").slice(0, 10).join("\n  ")}`,
    )
    .join("\n\n");
}

function buildPrompt(
  graph: DesignGraph,
  task: string,
  failures: IntegrationFailure[],
): string {
  const current = graph.listProjectTests();
  const fns = graph.listFunctions();
  const fnList = fns
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return `  - ${f.name}(${params}) -> ${f.signature.returnType}`;
    })
    .join("\n");
  return [
    "The project integration tests failed — either the test file failed to",
    "load (compile error, bad import) or the assertions are structurally",
    "wrong. REWRITE the integration test list to make it load and assert",
    "something meaningful.",
    "",
    `User task: ${task}`,
    "",
    "Available functions (wired into ctx.fns):",
    fnList,
    "",
    "Current integration tests (what broke):",
    renderCurrentTests(current),
    "",
    "Failure signals from the runner:",
    renderFailures(failures),
    "",
    "Return a revised test list as a fenced JSON array. Shape:",
    '  [{"name": "<test name>", "code": "<full test body>"}]',
    "",
    "Rules:",
    "- Only use symbols you know exist (functions listed above, node built-ins",
    "  available via dynamic require/import inside the test body).",
    "- Each test body runs inside an `it(...)` async block — use top-level",
    "  `await` / `expect` / etc.",
    "- If the failure mentions a compile error, focus on fixing the test",
    "  code's syntax and imports, not its assertions.",
    "- If a current test is beyond repair, drop it. Don't preserve every",
    "  test — it's better to have 3 working tests than 10 broken ones.",
    "",
    "```json",
    '[{"name": "...", "code": "..."}]',
    "```",
  ].join("\n");
}

export async function repairProjectTests(
  graph: DesignGraph,
  failures: IntegrationFailure[],
  options: RepairOptions,
): Promise<RepairReport> {
  const maxRetries = options.maxRetries ?? 1;
  const basePrompt = buildPrompt(graph, options.task, failures);
  let prompt = basePrompt;
  let lastError = "(no attempt made)";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug(
      "integration-loop",
      `repair project tests attempt ${attempt + 1}/${maxRetries + 1}`,
    );
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      break;
    }
    const parsed = extractJson(response);
    if (parsed === null) {
      lastError = "repair response was not valid JSON";
      prompt = `${basePrompt}\n\nYour previous response was not valid JSON. Return ONLY a fenced JSON block.`;
      continue;
    }
    try {
      const tests = parseProjectTestList(parsed);
      graph.replaceProjectTests(tests);
      debug(
        "integration-loop",
        `repaired project tests: ${tests.length} test(s) after repair`,
      );
      return { ok: true, finalCount: tests.length, error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      prompt = `${basePrompt}\n\nYour previous response had a schema error: ${lastError}. Fix the shape and return ONLY a fenced JSON block.`;
    }
  }
  return {
    ok: false,
    finalCount: graph.listProjectTests().length,
    error: lastError,
  };
}
