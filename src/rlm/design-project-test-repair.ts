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

import type { DesignGraph } from "./design-graph.js";
import type { IntegrationFailure } from "./design-integration-loop.js";
import { extractJson } from "./design-plan.js";
import {
  extractProjectTestFile,
  parseProjectTestList,
} from "./design-project-tests.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";
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
 * The synthetic `project.runner` (vitest crash) and `project.typecheck`
 * (tsc crash) markers trigger repair. Stack-trace pattern matching is
 * deliberately NOT used: every real integration test's stack trace
 * includes `project.integration.test` (that's where the `expect(...)`
 * line lives), so a regex check there would misroute every genuine
 * function-level assertion failure.
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
  return (
    failure.testName === "project.runner" ||
    failure.testName === "project.typecheck"
  );
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
  const fns = graph.listFunctions();
  const fnList = fns
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return `  - ${f.name}(${params}) -> ${f.signature.returnType}`;
    })
    .join("\n");
  const stored = graph.getProjectTestFile();
  const currentFile = stored
    ? stored
    : graph.listProjectTests().length > 0
      ? graph
          .listProjectTests()
          .map(
            (t) =>
              `// ${t.name}\nit(${JSON.stringify(t.name)}, async () => {\n${t.code}\n});`,
          )
          .join("\n\n")
      : "(no project test file stored yet — write one from scratch)";
  return [
    "The project integration tests failed — either the test file failed to",
    "load (compile error, bad import) or the assertions are structurally",
    "wrong. REWRITE the entire `project.integration.test.ts` file to make",
    "it load and assert something meaningful.",
    ...renderDecisionsBlock(graph),
    `User task: ${task}`,
    "",
    "Available functions (import directly with `.js` extension and call",
    "naturally — no ctx, no framework wrapper):",
    fnList,
    "",
    "Current project.integration.test.ts (what broke):",
    "```ts",
    currentFile,
    "```",
    "",
    "Failure signals from the runner:",
    renderFailures(failures),
    "",
    "OUTPUT — emit ONE fence with the COMPLETE REVISED source of",
    "`project.integration.test.ts`. The harness writes it verbatim:",
    "",
    "```project-test-file",
    "// entire revised project.integration.test.ts",
    "```",
    "",
    "Rules:",
    "- Only use symbols you know exist (functions listed above + node",
    "  built-ins available via static import at the top of the file).",
    "- If the failure mentions a compile error, focus on fixing the test",
    "  code's syntax and imports, not its assertions.",
    "- If a scenario is beyond repair, drop it — 3 working tests beat 10",
    "  broken ones.",
    "- Always pass `ctx` as the first arg to any function call. Forgetting",
    "  ctx is the #1 cause of integration-test failures.",
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
    // Preferred path — complete file fence. Replaces any prior project
    // tests (JSON or file) atomically.
    const fileContent = extractProjectTestFile(response);
    if (fileContent !== null) {
      graph.setProjectTestFile(fileContent);
      graph.replaceProjectTests([]); // retire legacy JSON list
      debug(
        "integration-loop",
        `repaired project test file (${fileContent.length} chars)`,
      );
      return { ok: true, finalCount: 1, error: null };
    }
    // Legacy fallback — a JSON array shape. Kept working but no longer
    // advertised.
    const parsed = extractJson(response);
    if (parsed !== null) {
      try {
        const tests = parseProjectTestList(parsed);
        graph.replaceProjectTests(tests);
        graph.setProjectTestFile(null); // retire wrapper-kill file
        debug(
          "integration-loop",
          `repaired project tests (legacy JSON): ${tests.length} test(s)`,
        );
        return { ok: true, finalCount: tests.length, error: null };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    } else {
      lastError = "repair response had no ```project-test-file fence";
    }
    prompt = `${basePrompt}\n\nYour previous response didn't include a valid \`\`\`project-test-file fence. Emit ONE fence containing the COMPLETE revised TypeScript source of project.integration.test.ts.`;
  }
  return {
    ok: false,
    finalCount: graph.listProjectTests().length,
    error: lastError,
  };
}
