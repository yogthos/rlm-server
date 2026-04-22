/**
 * Phase 6: project-level integration tests. The Architect (or a
 * dedicated pass) asks the LLM for end-to-end tests that exercise
 * the shipped app as a whole, not individual functions. These live
 * on the graph via `addProjectTest` / `listProjectTests` and are
 * rendered into a single integration spec at finalize time.
 *
 * Resume: if projectTests already exist on the graph, skip the LLM
 * call entirely. Project tests are authored once per plan; regen
 * happens only when the graph is empty.
 */

import type { DesignGraph, TestSpec } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";
import { debug } from "./debug.js";

export interface DesignProjectTestsOptions {
  chat: (prompt: string) => Promise<string>;
  /** Parse/shape retries before giving up. Default 1. */
  maxRetries?: number;
}

export interface ProjectTestsReport {
  ok: boolean;
  error?: string;
}

/** Matches a test-construct invocation — `it(`, `describe(`, `test(`,
 *  and dotted variants (`it.skip`, `test.each`). Whitespace/newlines
 *  allowed between name and paren. Requires a word boundary in front
 *  so identifier uses (`splits.push(it)`) don't match. */
const NESTED_TEST_CONSTRUCT =
  /(?:^|[^A-Za-z0-9_$.])(it|describe|test)(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*\(/;

/** Strip // and /* ... *\/ comments and string literals before checking
 *  for nested constructs — avoids matching `// mentions it()` in prose.
 *  Not a full JS parser; good enough for the structural guard. */
function stripCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    // line comment
    if (c === "/" && next === "/") {
      const eol = code.indexOf("\n", i);
      i = eol < 0 ? code.length : eol;
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    // strings (", ', `)
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " "; // replace with space so word boundaries stay
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function parseProjectTestList(raw: unknown): TestSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("project test list must be a JSON array");
  }
  if (raw.length === 0) {
    throw new Error("project test list must contain at least one test");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`test ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") {
      throw new Error(`test ${i} missing "name"`);
    }
    if (typeof r.code !== "string") {
      throw new Error(`test ${i} missing "code"`);
    }
    // Guard against the run-10 repair-output bug: the harness wraps
    // `r.code` inside `it(...)`, so if `r.code` itself calls `it(`,
    // `describe(`, or `test(`, vitest rejects with "Calling the test
    // function inside another test function is not allowed." Catch at
    // parse so the repair loop's retry budget can actually recover.
    const sanitized = stripCommentsAndStrings(r.code);
    const m = NESTED_TEST_CONSTRUCT.exec(sanitized);
    if (m) {
      throw new Error(
        `test ${i} "${r.name}": code contains a nested ${m[1]}(...) call — the harness wraps your code in it(...) already. Write the test body as bare statements (const res = await fetch(...); expect(res.ok).toBe(true);).`,
      );
    }
    return { name: r.name, code: r.code };
  });
}

function buildPrompt(graph: DesignGraph, task: string): string {
  const fns = graph.listFunctions();
  const fnLines = fns.map((f) => {
    const params = f.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    return `  - ${f.name}(${params}) -> ${f.signature.returnType}`;
  });
  const importLines = fns.map((f) => `import ${f.name} from "./${f.name}.js";`);
  return [
    "You are writing the PROJECT-LEVEL integration test file. These tests",
    "exercise the app end-to-end (HTTP round-trips, file I/O, full",
    "workflows) — not individual functions in isolation.",
    ...renderDecisionsBlock(graph),
    `User task: ${task}`,
    "",
    "Functions available (import directly with `.js` extension and call",
    "naturally):",
    ...(fnLines.length > 0 ? fnLines : ["  (none yet)"]),
    "",
    "OUTPUT FORMAT — emit ONE fenced block containing the COMPLETE TypeScript",
    "source of `project.integration.test.ts`:",
    "",
    "```project-test-file",
    '// your entire project.integration.test.ts file goes here',
    "```",
    "",
    "The harness writes this verbatim — no wrapping, no JSON shape, no",
    "post-processing. You own imports, describe/it blocks, assertions,",
    "setup/teardown.",
    "",
    "Template to start from (remove/adjust as you see fit — this is the",
    "complete file shape, not a fragment):",
    "",
    "```project-test-file",
    `import { describe, it, expect } from "<test framework>";`,
    ...importLines.slice(0, 4),
    "",
    'describe("project integration", () => {',
    '  it("<scenario>", async () => {',
    "    // call project functions naturally — no ctx, no wrapper.",
    "    // e.g. const res = await someFn(<real args>);",
    "    // expect(res).toBe(...);",
    "  });",
    "});",
    "```",
    "",
    "Write as many `it(...)` cases as the task requires — each should",
    "exercise a distinct workflow. Do NOT split tests into a JSON array;",
    "write a single complete TypeScript file.",
  ].join("\n");
}

/**
 * Extract the `\`\`\`project-test-file` fence. Returns the raw TS
 * content or null when absent. Mirrors `extractUnitTestFile` in shape.
 *
 * Treats an empty-after-trim fence as absent (returns null). Otherwise
 * callers downstream (`if (content !== null)`) would store a blank
 * string on the graph, and the resume check — which uses truthy-string
 * semantics — would incorrectly conclude the file is already authored
 * and skip the next LLM attempt, leaving the project with no tests.
 */
export function extractProjectTestFile(response: string): string | null {
  const m = response.match(
    /```project-test-file(?::[^\s]*)?[^\S\n]*\r?\n([\s\S]*?)```/,
  );
  if (!m) return null;
  const content = m[1].replace(/\r\n/g, "\n");
  return content.trim().length > 0 ? content : null;
}

export async function designProjectTests(
  graph: DesignGraph,
  task: string,
  options: DesignProjectTestsOptions,
): Promise<ProjectTestsReport> {
  if (graph.getProjectTestFile() || graph.listProjectTests().length > 0) {
    debug(
      "project-tests",
      `resume: project test file already set, skipping LLM`,
    );
    return { ok: true };
  }
  const maxRetries = options.maxRetries ?? 1;
  const basePrompt = buildPrompt(graph, task);
  let prompt = basePrompt;
  let lastError = "(no attempt made)";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug(
      "project-tests",
      `attempt ${attempt + 1}/${maxRetries + 1}`,
    );
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debug("project-tests", `chat error: ${lastError}`);
      break;
    }
    // Preferred path — complete file fence.
    const fileContent = extractProjectTestFile(response);
    if (fileContent !== null) {
      graph.setProjectTestFile(fileContent);
      debug(
        "project-tests",
        `project-test-file stored (${fileContent.length} chars)`,
      );
      return { ok: true };
    }
    // Legacy path — JSON array of {name, code}. Kept so old harness
    // runs / tests keep working; prompt no longer advertises this.
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
        "response did not contain a ```project-test-file fence (and no legacy JSON fallback either)";
    }
    prompt = `${basePrompt}\n\nYour previous response didn't include a valid \`\`\`project-test-file fence. Emit ONE fence containing the COMPLETE TypeScript source of project.integration.test.ts. Do not emit JSON arrays.`;
  }
  return { ok: false, error: lastError };
}
