/**
 * Phase E — path-grounded integration test authoring.
 *
 * Round 8 evolves `design-project-tests.ts`. Rather than asking the
 * LLM for "some integration tests," we enumerate call-graph paths
 * from entry points via `enumeratePaths`, then prompt the LLM to
 * author:
 *
 *   1. **One integration test per path** — guarantees coverage scope.
 *   2. **Supplementary tests** — LLM-inferred scenarios the paths
 *      don't capture (error branches, malformed input, concurrency,
 *      etc.). Mix approach per user design.
 *
 * Resume: if the graph already has project tests, the LLM call is
 * skipped entirely. Callers rewrite the graph's project-tests to
 * regenerate.
 */

import type { DesignGraph } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { enumeratePaths, type Path } from "./design-paths.js";
import {
  extractProjectTestFile,
  parseProjectTestList,
} from "./design-project-tests.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";
import { debug } from "./debug.js";

export interface DesignIntegrationTestsOptions {
  chat: (prompt: string) => Promise<string>;
  /** Parse/shape retries before giving up. Default 1. */
  maxRetries?: number;
  /** Pre-enumerated paths. When omitted, paths are derived from the
   *  graph via `enumeratePaths`. Provide this to scope tests to a
   *  subset (e.g., only paths that changed since the last run). */
  paths?: Path[];
}

export interface IntegrationTestsReport {
  ok: boolean;
  error?: string;
}

function renderPaths(paths: Path[]): string[] {
  if (paths.length === 0) return ["  (no paths — graph is empty)"];
  return paths.map((p, i) => {
    const chain = p.nodes.join(">");
    const marker = p.kind === "cyclical" ? " [cyclical]" : "";
    return `  ${i + 1}. ${chain}${marker}`;
  });
}

function renderFunctionSpecs(graph: DesignGraph): string[] {
  const fns = graph.listFunctions();
  if (fns.length === 0) return ["  (no functions yet)"];
  return fns.map((f) => {
    const params = f.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    const purpose = f.spec?.purpose ?? "(no spec)";
    return `  - ${f.name}(${params}) -> ${f.signature.returnType}: ${purpose.slice(0, 140)}`;
  });
}

function buildPrompt(
  graph: DesignGraph,
  task: string,
  paths: Path[],
): string {
  const fns = graph.listFunctions();
  const importLines = fns.map((f) => `import ${f.name} from "./${f.name}.js";`);
  return [
    "You are authoring the PROJECT-LEVEL integration test file. These",
    "tests exercise end-to-end workflows — HTTP round-trips, file I/O,",
    "full call chains — not individual functions in isolation.",
    ...renderDecisionsBlock(graph),
    `User task: ${task}`,
    "",
    "Functions in the design graph (import directly with `.js` extension",
    "and call naturally):",
    ...renderFunctionSpecs(graph),
    "",
    "Call-graph paths (one test per path REQUIRED):",
    ...renderPaths(paths),
    "",
    "Your task:",
    "  1. Write ONE it(...) case for each enumerated path above. The test",
    "     name should reference the path (e.g., \"path X>Y>Z — does <thing>\").",
    "  2. Write ADDITIONAL it(...) cases for scenarios the paths don't",
    "     capture — error branches, malformed input, idempotency, etc.",
    "     Label these as \"supplementary: <what it covers>\".",
    "",
    "OUTPUT — emit ONE fence containing the COMPLETE TypeScript source of",
    "`project.integration.test.ts`:",
    "",
    "```project-test-file",
    `import { describe, it, expect } from "<test framework>";`,
    ...importLines.slice(0, 4),
    "",
    'describe("project integration", () => {',
    '  it("path X>Y>Z — does <thing>", async () => {',
    "    // call project functions naturally — no ctx, no wrapper.",
    "  });",
    "});",
    "```",
    "",
    "The harness writes the file verbatim. Do NOT emit a JSON array.",
  ].join("\n");
}

export async function designIntegrationTests(
  graph: DesignGraph,
  task: string,
  options: DesignIntegrationTestsOptions,
): Promise<IntegrationTestsReport> {
  if (graph.getProjectTestFile() || graph.listProjectTests().length > 0) {
    debug(
      "integration-tests",
      `resume: project test file already set, skipping LLM`,
    );
    return { ok: true };
  }
  if (graph.listFunctions().length === 0) {
    debug("integration-tests", "empty graph — no tests to author");
    return { ok: true };
  }
  const paths = options.paths ?? enumeratePaths(graph);
  const maxRetries = options.maxRetries ?? 1;
  const basePrompt = buildPrompt(graph, task, paths);
  let prompt = basePrompt;
  let lastError = "(no attempt made)";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug(
      "integration-tests",
      `attempt ${attempt + 1}/${maxRetries + 1} paths=${paths.length}`,
    );
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debug("integration-tests", `chat error: ${lastError}`);
      break;
    }
    const fileContent = extractProjectTestFile(response);
    if (fileContent !== null) {
      graph.setProjectTestFile(fileContent);
      debug(
        "integration-tests",
        `project-test-file stored (${fileContent.length} chars)`,
      );
      return { ok: true };
    }
    const parsed = extractJson(response);
    if (parsed !== null) {
      try {
        const tests = parseProjectTestList(parsed);
        for (const t of tests) graph.addProjectTest(t);
        return { ok: true };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    } else {
      lastError =
        "response did not contain a ```project-test-file fence";
    }
    prompt = `${basePrompt}\n\nYour previous response didn't include a valid \`\`\`project-test-file fence. Emit ONE fence containing the COMPLETE TypeScript source of project.integration.test.ts.`;
  }
  return { ok: false, error: lastError };
}
