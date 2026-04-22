/**
 * Build the focused brief an Implementer agent sees for a single function.
 * Pure function over the DesignGraph — no I/O, no file reads. Decision
 * making happens against the graph; files exist only for test execution.
 *
 * Contract shift (SPEC-driven): the Architect writes a structured SPEC
 * on fn.spec. The Implementer now owns BOTH the tests and the body.
 * On the first attempt tests are authored from the spec; on retries
 * the Implementer can revise them.
 */

import type {
  DesignGraph,
  FunctionSpec,
  ParamSpec,
  Signature,
  TestSpec,
} from "./design-graph.js";
import { computeRelevantFunctions } from "./prompt-scope.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";

/**
 * W1 — take the FIRST `limit` chars and, if truncated, append an
 * explicit note so the model knows there's more content it isn't
 * seeing. Analyzer/architect violation lists are in source order;
 * the root cause is usually violation #1, so keep the head.
 */
function truncateHead(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const kept = s.slice(0, limit);
  const dropped = s.length - limit;
  return `${kept}\n…[${dropped} more chars truncated — fix these first, then resubmit to see remaining violations if any]`;
}

/**
 * W2 — format a compact one-line progress trend so the Implementer can
 * see whether it's converging. Combines prior history (oldest-first)
 * with the most recent attempt. Returns null when there's no history
 * worth reporting (0 or 1 data points).
 *
 * Examples:
 *   "Progress: failed 8→6→3 (converging ↓)"
 *   "Progress: failed 5→5→5 (stalled — same count 3× in a row; try a DIFFERENT approach, not another tweak)"
 *   "Progress: failed 3→5→2 (oscillating; tests you thought were passing now fail — revisit)"
 */
export function renderFailureTrend(
  history: Array<{ passed: number; failed: number }> | undefined,
  currentPassed: number,
  currentFailed: number,
): string | null {
  const recent = (history ?? []).slice(-4);
  const series = [...recent, { passed: currentPassed, failed: currentFailed }];
  if (series.length < 2) return null;
  const failedCounts = series.map((s) => s.failed);
  const arrow = failedCounts.join("→");
  const last = failedCounts[failedCounts.length - 1];
  const prev = failedCounts[failedCounts.length - 2];
  const allSame = failedCounts.every((n) => n === failedCounts[0]);
  if (allSame && failedCounts.length >= 3) {
    return `Progress: failed ${arrow} (stalled — same count ${failedCounts.length}× in a row; try a DIFFERENT approach, not another tweak to the same shape)`;
  }
  if (last < prev) {
    return `Progress: failed ${arrow} (converging ↓ — keep going)`;
  }
  if (last > prev) {
    return `Progress: failed ${arrow} (regressed ↑ — you broke a previously-passing test; revert or fix what you just changed)`;
  }
  // Same count as prior, but earlier differs → oscillation.
  const oscillating = failedCounts.length >= 3 && !allSame;
  if (oscillating) {
    return `Progress: failed ${arrow} (oscillating — fixing one test breaks another; step back and reconsider your mental model, don't tweak)`;
  }
  return `Progress: failed ${arrow}`;
}

function renderParam(p: ParamSpec): string {
  const q = p.optional ? "?" : "";
  const def = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : "";
  return `${p.name}${q}: ${p.type}${def}`;
}

/**
 * Phase N3 — natural TypeScript signature. No ctx injection. The
 * architect's declared params ARE the signature.
 */
function renderSignature(name: string, sig: Signature): string {
  const async = sig.isAsync ? "async " : "";
  const paramList = sig.params.map(renderParam).join(", ");
  return `export default ${async}function ${name}(${paramList}): ${sig.returnType}`;
}

function renderSpec(spec: FunctionSpec): string {
  const lines: string[] = [];
  lines.push(`Purpose: ${spec.purpose}`);
  if (spec.inputs.length > 0) {
    lines.push("Inputs:");
    for (const i of spec.inputs) {
      lines.push(`  - ${i.name}: ${i.type} — ${i.description}`);
    }
  }
  lines.push(`Output: ${spec.output.type} — ${spec.output.description}`);
  if (spec.sideEffects.length > 0) {
    lines.push("Side effects:");
    for (const s of spec.sideEffects) lines.push(`  - ${s}`);
  }
  if (spec.dependencies.length > 0) {
    lines.push("Dependencies (import these directly):");
    for (const d of spec.dependencies) lines.push(`  - ${d}`);
  }
  if (spec.edgeCases.length > 0) {
    lines.push("Edge cases (MUST be covered by tests):");
    for (const e of spec.edgeCases) lines.push(`  - ${e}`);
  }
  if (spec.examples.length > 0) {
    lines.push("Examples:");
    for (const ex of spec.examples) {
      lines.push(`  - input: ${ex.input} → output: ${ex.output}`);
    }
  }
  return lines.join("\n");
}

function renderTestList(tests: TestSpec[]): string {
  const lines: string[] = [];
  for (const t of tests) {
    lines.push(`- ${t.name}`);
    for (const row of t.code.split("\n")) {
      lines.push(`    ${row}`);
    }
  }
  return lines.join("\n");
}

export interface ImplementerFeedback {
  attempt: number;
  maxAttempts: number;
  previousBody: string;
  testOutput: string;
  /** When present, the previous attempt's tests PASSED but the
   *  Architect rejected the body against the spec. Rendered under a
   *  distinct section so the Implementer doesn't misread it as a
   *  flaky-test signal. */
  architectFeedback?: string;
  /** When present, the previous attempt FAILED static analysis (tree-
   *  sitter body check) BEFORE tests ran — e.g. top-level imports or
   *  calls to undeclared siblings. Rendered under its own section so
   *  the Implementer knows this is a structural proc-ts violation,
   *  not a test failure. */
  analyzerFeedback?: string;
  /** True when every declared test failed on the last attempt (0
   *  passing, >0 failing). Prompts the Implementer to question
   *  whether its TESTS, not just its body, match the spec — same
   *  agent writes both, so they can be wrong in the same way. */
  allTestsFailed?: boolean;
  /** True when the dispatch loop has seen two+ near-identical bodies
   *  in a row and the test failure count hasn't dropped. The prompt
   *  nudges the Implementer toward a materially different approach
   *  instead of another cosmetic tweak. */
  stagnating?: boolean;
  /** Number of tests that PASSED on the previous attempt. Shown with
   *  a "do not regress" directive so the Implementer protects the
   *  green tests when revising (e.g. after architect REVISE or when
   *  adding new tests). */
  previousPassed?: number;
  previousFailed?: number;
  /** W2 — recent history of (passed, failed) counts in oldest-first
   *  order, excluding the most recent attempt (that's `previousPassed`
   *  / `previousFailed`). Used to compute a one-line progress trend
   *  ("converging 8→6→3" vs. "stalled: 5 failed for 3 consecutive
   *  attempts"). The Implementer seeing this explicitly works better
   *  than asking it to infer the trend from a stagnating flag. */
  failureHistory?: Array<{ passed: number; failed: number }>;
  /** W4 — structured list of failing test names from the last run.
   *  Rendered as an explicit "Failed tests:" block so the Implementer
   *  doesn't have to parse TAP/vitest output to identify which tests
   *  failed. */
  failingTestNames?: string[];
  /** W4 — first failure's full message (assertion text + one-line
   *  stack hint). Rendered under "First failure:" so the root cause
   *  is visible without requiring a `request-info stack-trace` round
   *  trip. */
  firstFailureMessage?: string;
  /** W5 — true when the test file failed to LOAD (compile/import error
   *  before any assertion ran). The prompt tags the failure as a
   *  compile-stage problem ("fix imports / syntax") rather than a
   *  test-stage problem ("tweak assertions") — different debugging
   *  approach. */
  loadFailure?: boolean;
  /** W6 — full content of the unit test file the Implementer emitted
   *  on the last attempt. Rendered alongside `previousBody` on retry
   *  so the model can see BOTH halves of the TDD pair when deciding
   *  what to revise. Body-only retries let the model forget what the
   *  tests were asserting; this closes that loop. */
  previousTestFile?: string;
  /** W7 — N consecutive attempts with a byte-identical body. Signals
   *  "you're rewriting tests but not touching the body — the BODY is
   *  probably the bug, not the tests." Counted in design-dispatch.ts. */
  bodyUnchangedStreak?: number;
  /** W9 — cumulative dispatch-cycle count for this function ACROSS
   *  batches + integration-loop iterations. High values mean the model
   *  has been thrashing; the prompt renders a step-back nudge to
   *  break blame-shifting / cosmetic-tweak loops. */
  totalDispatchCycles?: number;
}

export interface ImplementerPromptOptions {}

export async function buildImplementerPrompt(
  graph: DesignGraph,
  module: string,
  name: string,
  feedback?: ImplementerFeedback,
  _options?: ImplementerPromptOptions,
): Promise<string> {
  const fn = graph.getFunction(module, name);
  if (!fn) {
    throw new Error(`function not found: ${module}#${name}`);
  }
  // Compute the relevant subgraph via Prolog relevance rules so the
  // prompt only names functions that matter to this one (parent chain,
  // children, siblings, call deps, 1-hop transitive). Falls back to
  // the full list on Prolog error.
  const relevant = await computeRelevantFunctions(graph, fn.name);
  const descriptionBlock = fn.description
    ? ["", "Short description:", fn.description].join("\n")
    : "";

  const specBlock: string[] = fn.spec
    ? ["", "SPEC (from the Architect — your contract):", renderSpec(fn.spec)]
    : ["", "(no spec attached — derive tests from the description and signature)"];

  // Test framework was picked in phase 0; adapt the test-harness
  // guidance to match. Default to vitest for manual/legacy graphs that
  // never went through phase 0.
  const projectCfg = graph.getProjectConfig();
  // Phase C: inject ALL project decisions verbatim into the prompt.
  // No hardcoded per-framework guidance — the model committed to a
  // combination in phase 0, and the downstream prompts read that
  // commitment rather than the harness prescribing it.
  const decisionsBlock = renderDecisionsBlock(graph);
  // Legacy framework guidance kept as a last-resort fallback for
  // graphs that never went through phase 0 (tests, manual setups).
  // Production runs hit the decisions block above.
  const framework = projectCfg?.testFramework ?? "vitest";
  const frameworkGuidanceLine = projectCfg
    ? `   The test \`code\` runs under your chosen framework (${framework}). Use whatever APIs your testImports exposes.`
    : framework === "jest"
      ? "   The test `code` runs inside a **jest** `it(...)` body — use `jest.fn()` / `jest.spyOn()` / `jest.mock()` for mocks. The `vi` global is NOT defined under jest."
      : "   The test `code` runs inside a **vitest** `it(...)` body — use `vi.fn()` / `vi.spyOn()` / `vi.mock()` for mocks. The `jest` global is NOT defined; `jest.fn()` throws at load time and fails every test.";

  const existingBlock: string[] = [];
  if (fn.implementation !== null) {
    existingBlock.push(
      "",
      "Current implementation (already saved for this function):",
      "```",
      fn.implementation,
      "```",
      "",
      "Your task is to MODIFY this body so the tests you emit pass.",
      "Preserve behavior not contradicted by the spec.",
    );
  }

  const hasChildren = fn.children.length > 0;
  const childList = hasChildren
    ? fn.children
        .map((c) => {
          const cfn = relevant.find((f) => f.name === c) ?? graph.listFunctions().find((f) => f.name === c);
          if (!cfn) {
            throw new Error(
              `buildImplementerPrompt: ${fn.name}.children lists "${c}" but the graph has no such function — graph corruption`,
            );
          }
          const params = cfn.signature.params
            .map((p) => `${p.name}: ${p.type}`)
            .join(", ");
          return [
            `  - import ${c} from "./${c}.js";`,
            `      ${c}(${params}): ${cfn.signature.returnType} — ${cfn.description}`,
          ].join("\n");
        })
        .join("\n")
    : "";
  // Phase N3 — siblings are importable modules, not ctx.fns entries.
  // List every relevant project function as an import + natural call
  // shape so the model can pull in whichever it needs.
  const childSet = new Set(fn.children);
  const otherAvailable = relevant
    .filter((f) => f.name !== fn.name && !childSet.has(f.name))
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return [
        `  - import ${f.name} from "./${f.name}.js";`,
        `      ${f.name}(${params}): ${f.signature.returnType}`,
      ].join("\n");
    })
    .join("\n");

  // Tests already in the graph — on first attempt this is empty, on
  // retry it shows what the Implementer emitted last time so they can
  // iterate instead of rewriting from scratch.
  const hasExistingUnit = fn.tests.length > 0;
  const hasExistingIntegration = fn.integrationTests.length > 0;
  const existingTestsBlock: string[] = [];
  if (hasExistingUnit || hasExistingIntegration) {
    existingTestsBlock.push("", "Tests currently on this function (you wrote these last round — revise as needed):");
    if (hasExistingUnit) {
      existingTestsBlock.push("Unit:", renderTestList(fn.tests));
    }
    if (hasExistingIntegration) {
      existingTestsBlock.push("Integration:", renderTestList(fn.integrationTests));
    }
  }

  const integrationNeeded = hasChildren;

  const paramExamples = fn.signature.params
    .map((p) => `<${p.name}>`)
    .join(", ");
  const firstSibling = [...fn.children, ...relevant.filter((f) => f.name !== fn.name && !childSet.has(f.name)).map((f) => f.name)][0];
  const lines = [
    `You are the Implementer of \`${fn.name}\`. Write it the way you'd`,
    "write any small TypeScript module: plain imports, a natural",
    "signature, a body that does exactly what the spec says, and unit",
    "tests that exercise it. The harness takes care of wiring.",
    "",
    `Signature: ${renderSignature(fn.name, fn.signature)}`,
    descriptionBlock,
    ...specBlock,
    "",
    ...(hasChildren
      ? [
          "Available sibling functions — DECOMPOSED CHILDREN (already",
          "implemented and tested). Import and call them directly:",
          "",
          childList,
          "",
          "These children are a WORKING, TESTED unit — their signatures",
          "are AUTHORITATIVE. If your mental model of a child differs",
          "from its declared shape, REVISE YOUR HYPOTHESIS to match the",
          "reality you got. If you genuinely cannot compose them into",
          "the spec's purpose, emit `request-info` with `sibling:<name>`",
          "or `help` to explore.",
          "",
        ]
      : []),
    ...(otherAvailable.length > 0
      ? [
          hasChildren
            ? "Other sibling functions you MAY import if helpful:"
            : "Available sibling functions in the project — import if you need them:",
          otherAvailable,
          "",
        ]
      : []),
    "CONTRACT (mandatory):",
    "- Emit a COMPLETE TypeScript source file: imports + default-exported",
    `  \`${fn.name}\` with the declared signature + body. The harness`,
    "  writes it verbatim — no wrapping, no post-processing.",
    `- The default export MUST be named \`${fn.name}\` with the signature`,
    `  \`${renderSignature(fn.name, fn.signature)}\`. The harness parses`,
    "  the file and rejects drift with specific feedback.",
    "- Top-level `import` statements are REQUIRED whenever your signature",
    "  or body references an external namespace or type. tsc rejects",
    "  unresolved references with TS2503 (\"Cannot find namespace\") and",
    "  TS2304 (\"Cannot find name\"). Examples:",
    '    import * as http from "node:http";            // namespace',
    '    import type * as fs from "node:fs";           // type-only',
    '    import { readFile } from "node:fs/promises";  // named',
    '    import sibling from "./sibling.js";           // sibling',
    "  Use `import type` for imports referenced only in type positions.",
    "- Siblings are ordinary modules — import them with the `.js`",
    "  extension (ESM convention). No framework-provided `ctx` object.",
    "- CUSTOM cross-function types (e.g. `Entry`, `User`, `Config`) must",
    "  be DECLARED INLINE at the top of your file — the harness does",
    '  NOT create a shared "./types.js" or "./common.ts" module, and any',
    "  relative import that doesn't resolve to a sibling function file",
    "  will fail the structural check. Duplicate the type across files",
    "  that need it:",
    "    interface Entry { id: number; name: string; message: string; }",
    "    export default function renderPage(entries: Entry[]): string {",
    "      // ...",
    "    }",
    "  Types from external packages (`Database` from better-sqlite3,",
    "  `IncomingMessage` from node:http, etc.) must be IMPORTED from",
    "  those packages; don't redeclare them.",
    "",
    ...existingTestsBlock,
    ...existingBlock,
    ...decisionsBlock,
    "",
    "**TDD ordering** — write the TESTS FIRST (from the SPEC and edge",
    "cases above), then write the BODY that satisfies them. Do this",
    "mentally in two passes even though you emit both fences in one",
    "response:",
    "  (1) Read the SPEC; translate each edge-case + example into a",
    "      concrete `it(\"...\")` case with explicit inputs and",
    "      expected outputs. Don't peek at the body you're about to",
    "      write — the tests must encode the contract, not mirror the",
    "      implementation.",
    "  (2) NOW write the body. Use the tests as the target: anything",
    "      they assert is required; anything they don't check is free.",
    "This ordering prevents the \"model wrote tests to match its own",
    "buggy body\" failure mode. If the tests and body disagree later,",
    "you can revise either — but the FIRST iteration must put the",
    "tests ahead of the code in your thinking.",
    "",
    "Task — emit TWO (or THREE) fenced blocks in your response:",
    "",
    "1. ```ts — the COMPLETE function file: imports + default-exported",
    `   function \`${fn.name}\` with the declared signature + body.`,
    "",
    `2. \`\`\`unit-test-file — the COMPLETE TypeScript test file for \`${fn.name}\`.`,
    "   You own it end-to-end: imports, describe/it, assertions.",
    frameworkGuidanceLine,
    `   Import the function under test as \`import ${fn.name} from "./${fn.name}.js";\``,
    `   and call it naturally: \`${fn.name}(${paramExamples})\` — no ctx.`,
    "   Cover every edge case from the spec and at least one example.",
    "   When you need to isolate this function from its siblings, use",
    "   the test framework's native mock API (see decisions.mockingStrategy).",
    "",
    "   **MOCKING STRATEGY** — when the function wraps an external library",
    "   (native module, database client, HTTP client, file system), PREFER",
    "   a real ephemeral instance over `vi.mock()`:",
    "     - SQLite (better-sqlite3, sqlite3): use `:memory:` as the path.",
    "       Real database, no disk, no cross-test contamination, tears",
    "       down when the handle goes out of scope.",
    "     - HTTP servers: start on port 0 (ephemeral), make real requests,",
    "       tear down in afterEach. No mock of the HTTP layer.",
    "     - File system: create a tmpdir, write real files, `rm -rf` after.",
    "     - Rate-limited / paid APIs: mock is appropriate.",
    "   `vi.mock('native-pkg', () => ({ default: ... }))` of native",
    "   modules with default exports is FRAGILE — the factory runs after",
    "   the import is evaluated, bindings escape the sandbox, and type",
    "   hints break. If you find yourself writing a complex `vi.mock()`",
    "   factory for a native module, stop and use a real instance instead.",
    "",
    integrationNeeded
      ? `3. \`\`\`integration-test-file — REQUIRED. Full TS content for \`${fn.name}.integration.test.ts\`.`
      : "3. ```integration-test-file — OMIT for this function (no children to assemble).",
    integrationNeeded
      ? "   Import REAL siblings and exercise the full assembly end-to-end."
      : "   Put all behavior coverage in the unit-test-file.",
    "",
    "Fence shape:",
    "```ts",
    firstSibling ? `import ${firstSibling} from "./${firstSibling}.js";` : "// imports as needed",
    "",
    `export default function ${fn.name}(${fn.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ")}): ${fn.signature.returnType} {`,
    firstSibling ? `  // e.g. ${firstSibling}(...)` : "  // body statements",
    "}",
    "```",
    "",
    "```unit-test-file",
    `import { describe, it, expect } from "<framework>";`,
    `import ${fn.name} from "./${fn.name}.js";`,
    "",
    `describe("${fn.name}", () => {`,
    `  it("...", () => {`,
    `    const result = ${fn.name}(${paramExamples});`,
    "    expect(result).toBe(/* expected */);",
    "  });",
    "});",
    "```",
    ...(integrationNeeded
      ? [
          "```integration-test-file",
          "// full TS test file — import real siblings directly and",
          "// exercise the assembly end-to-end. No mocking.",
          "```",
        ]
      : []),
    "",
    "Rules:",
    "- Do not narrate, do not call test_run, do not call design_implement.",
    "  The harness runs the tests and saves the body on your behalf.",
    "- If the tests fail, you will be called again with the failure output.",
    "  You can revise BOTH the source file and the test file(s) on each",
    "  retry — whichever you believe is wrong. Emitting a test-file fence",
    "  REPLACES the stored test file entirely. Omit the fence to keep",
    "  the previous test file unchanged.",
    "- Tests are YOURS. Siblings' tests and project-level tests are out",
    "  of scope for you.",
    "",
    "ASSET REVISION — the model owns every non-source-file asset in the",
    "project (package.json, tsconfig.json, custom configs, seed data,",
    "…). To change one, emit a `file:<path>` fence alongside your",
    "code fence:",
    "",
    "    ```file:package.json",
    '    { ... updated contents ... }',
    "    ```",
    "",
    "The harness replaces the asset verbatim. Use this when the test",
    "run failed because of a missing dep, a config mismatch, or a tool",
    "setting — don't suffer under the existing assets if they're the",
    "root cause.",
    "",
    "═══════════════════════════════════════════════════════════════",
    "REQUEST-INFO TOOL (always available — use whenever you need it)",
    "═══════════════════════════════════════════════════════════════",
    "",
    "If the prompt doesn't give you enough context to write the body",
    "confidently, emit a `request-info` fence INSTEAD of body+tests:",
    "",
    "```request-info",
    "stack-trace              # full test-runner traces from the last run",
    "sibling:<name>           # a sibling's body + spec + tests",
    "spec:<name>              # full spec of a function (defaults to self)",
    "signature:<name>         # one-line declared signature (defaults to self)",
    "body:<name>              # stored implementation of a function",
    "callers                  # who calls me (or callers:<name>)",
    "callees                  # what I call     (or callees:<name>)",
    "imports:<name>           # analyzer-observed import list of a function",
    "related                  # ±1 hop call subgraph around me",
    "graph                    # compact neighborhood summary",
    "task                     # the original top-level user task",
    "file:<path>              # read any project asset by path",
    "                         # e.g. file:package.json, file:tsconfig.json,",
    "                         # file:<fn>.ts, file:<fn>.test.ts",
    "files                    # list every file the harness will write",
    "decisions                # echo the committed ProjectDecisions",
    "help                     # list all supported request kinds",
    "```",
    "",
    "The harness answers each query and re-prompts you with the",
    "information appended — NO ATTEMPT IS CONSUMED. Use this whenever",
    "you need details beyond the signatures and spec in this prompt.",
    "Common uses:",
    "  - after a test failure: `stack-trace` to see the full assertion",
    "    error and stack (the digest can be truncated / object-collapsed)",
    "  - before calling a sibling: `sibling:<name>` to see how it behaves",
    "  - unclear about a dep's contract: `spec:<name>` for full spec",
    "",
    "Max 2 info rounds per attempt. If you emit both a body fence AND",
    "a request-info fence in the same response, the harness processes",
    "the body (request-info is ignored). To get info, emit request-info",
    "ALONE — then respond with body+tests on the next round.",
  ];

  if (feedback) {
    lines.push(
      "",
      "---",
      `Attempt ${feedback.attempt + 1} of ${feedback.maxAttempts}.`,
      "Your previous body:",
      "```",
      feedback.previousBody,
      "```",
    );
    // W9 — cumulative step-back nudge. When the function has been
    // re-dispatched many times across batches / integration iterations
    // WITHOUT going green, the model is stuck in a local minimum.
    // A step-back directive at dispatch-start (before the model dives
    // into another tweak) is the best time to ask "am I on the right
    // path at all?"
    if (feedback.totalDispatchCycles && feedback.totalDispatchCycles >= 3) {
      lines.push(
        "",
        `**STEP BACK — dispatch cycle #${feedback.totalDispatchCycles} on this function.**`,
        "You've been re-dispatched multiple times across batches or",
        "integration-loop iterations. Whatever approach you've tried so",
        "far isn't working. BEFORE you write the next attempt, consider:",
        "",
        "  1. Is the TEST STRATEGY wrong? If you've been mocking a native",
        "     module (databases, file system, native add-ons) and it keeps",
        "     failing, switch to a real in-memory / ephemeral instance.",
        "     `:memory:` for SQLite; port 0 for HTTP servers; tmpdir for fs.",
        "",
        "  2. Is the BODY ARCHITECTURE wrong? If you've been tweaking",
        "     the body within the same shape and failures persist, the",
        "     shape itself is wrong. Rewrite the body from the SPEC.",
        "",
        "  3. Are the TESTS testing the wrong thing? Re-read the SPEC and",
        "     check: do your assertions actually cover the edge cases",
        "     listed, or are you testing your mental model of the body?",
        "",
        "Do NOT submit another cosmetic tweak of the previous attempt.",
        "Pick ONE of (1) / (2) / (3), act on it, and explain the change",
        "in a one-line comment at the top of your ```ts fence.",
      );
    }
    // W7 — "body unchanged across attempts" directive. The model
    // keeps shipping the same body and rewriting only the tests to
    // try to force green. That's blame-shifting: the tests are
    // failing because the BODY is wrong, not because the tests are.
    if (feedback.bodyUnchangedStreak && feedback.bodyUnchangedStreak >= 2) {
      lines.push(
        "",
        `**BODY UNCHANGED across ${feedback.bodyUnchangedStreak + 1} attempts.** You've`,
        "submitted a byte-identical body each time and rewritten only",
        "the tests. Tests keep failing because the BODY is the bug, not",
        "the tests. This round: CHANGE THE BODY. If you believe the",
        "body is correct, you must either",
        "  (a) prove it by writing tests that actually pass against it, or",
        "  (b) accept that the tests encode the spec correctly and the",
        "      body needs to change to satisfy them.",
        "Rewriting the tests to match a buggy body is cheating the spec.",
      );
    }
    // W6 — show the previous test file alongside the body so the model
    // can revise EITHER. Body-only retries invite the model to tweak
    // the implementation to match buggy tests (or vice versa). Seeing
    // both lets it diagnose which side is wrong.
    if (feedback.previousTestFile && feedback.previousTestFile.length > 0) {
      lines.push(
        "",
        "Your previous unit-test-file (review this alongside the body —",
        "if a failing assertion doesn't match what the SPEC requires,",
        "the TEST is the bug, not the body):",
        "```",
        feedback.previousTestFile.length > 4000
          ? `${feedback.previousTestFile.slice(0, 4000)}\n…[${feedback.previousTestFile.length - 4000} more chars]`
          : feedback.previousTestFile,
        "```",
      );
    }
    if (typeof feedback.previousPassed === "number") {
      lines.push(
        "",
        `Previous attempt: ${feedback.previousPassed} tests passed, ${feedback.previousFailed ?? 0} failed.`,
        "**Do not regress** — whatever you change, preserve the tests that",
        "were already passing. If a previously-passing test now fails,",
        "your new body broke something that was working.",
      );
      // W2 — progress trend. Include up to 4 most-recent prior counts
      // (+ the current "previous") so the model can see whether its
      // work is converging. A stalled trend is a strong signal to
      // change approach, not to tweak.
      const trend = renderFailureTrend(
        feedback.failureHistory,
        feedback.previousPassed,
        feedback.previousFailed ?? 0,
      );
      if (trend) lines.push("", trend);
    }
    // Body-size advisory — a large body usually means the function is
    // doing more than the ~30-line budget admits, which itself causes
    // stuck-retry loops (Implementer can't hold the whole thing in
    // view). Not blocking, just a nudge.
    if (feedback.previousBody.length > 2000) {
      lines.push(
        "",
        `**Body size warning** — your previous body was ${feedback.previousBody.length} chars.`,
        "Proc-ts targets ~30-line functions. If this body is already",
        "large, the spec is likely under-decomposed: split the logic",
        "into smaller pieces (inline helpers at the top of the body,",
        "or explicitly note in your response that this function should",
        "have been decomposed so the Architect can re-plan).",
      );
    }
    if (feedback.analyzerFeedback) {
      // W1 — take the FIRST slice of violations, not the last. Violations
      // tend to be in source order (top of file down), and violation #1
      // is usually the root cause — later ones cascade. Truncating from
      // the end drops the most actionable message.
      lines.push(
        "",
        "Static-analysis violation (tests were NOT run — the body failed",
        "a structural proc-ts check):",
        "```",
        truncateHead(feedback.analyzerFeedback, 2000),
        "```",
        "",
        "Fix the listed violation(s) and resubmit. This is a structural",
        "check, not a test failure.",
      );
    } else if (feedback.architectFeedback) {
      lines.push(
        "",
        "Architect review feedback (tests PASSED — the Architect rejected",
        "the body against the SPEC; this is NOT a test failure):",
        "```",
        truncateHead(feedback.architectFeedback, 2000),
        "```",
        "",
        "Revise the body (and/or tests) to address the Architect's concerns.",
      );
    } else {
      // W5 — compile-stage failure: the test file didn't even load
      // (0 passed / 0 failed). Route the model to fix imports,
      // syntax, or missing type declarations BEFORE thinking about
      // assertions. Common causes: TS2304 Cannot find name,
      // TS2307 Cannot find module, TS2503 Cannot find namespace,
      // ERR_MODULE_NOT_FOUND.
      if (feedback.loadFailure) {
        lines.push(
          "",
          "**COMPILE / LOAD FAILURE** — no tests ran. The test file or",
          "your body has a syntax error, a bad import, or references",
          "an undeclared type/symbol. Fix the compile error first, then",
          "resubmit; assertion-level revisions are pointless until the",
          "file loads.",
          "",
          "Common causes and fixes:",
          "  - `TS2304: Cannot find name 'X'` — add an `import` for X,",
          "    or declare the type inline (`interface X { ... }`).",
          "  - `TS2307: Cannot find module './y.js'` — only sibling",
          "    function files exist (`./<fn>.js`). The harness does NOT",
          "    create `./types.js` or shared helpers. Inline what you need.",
          "  - `ERR_MODULE_NOT_FOUND` — same as TS2307 at runtime; the",
          "    import target doesn't exist on disk.",
          "  - `SyntaxError` — parse failed; check braces/brackets/",
          "    template-string escaping.",
        );
      }
      // W4 — structured failure digest. The raw TAP/vitest dump still
      // follows but the model sees the shaped version first: which
      // tests failed, and what the first one's error was. Avoids
      // forcing a `request-info stack-trace` round trip for the
      // common "what went wrong" question.
      if (feedback.failingTestNames && feedback.failingTestNames.length > 0) {
        lines.push(
          "",
          `Failed tests (${feedback.failingTestNames.length}):`,
        );
        for (const n of feedback.failingTestNames.slice(0, 20)) {
          lines.push(`  - ${n}`);
        }
        if (feedback.failingTestNames.length > 20) {
          lines.push(
            `  …(${feedback.failingTestNames.length - 20} more — fix the listed ones first)`,
          );
        }
      }
      if (feedback.firstFailureMessage) {
        lines.push(
          "",
          "First failure (full assertion message):",
          "```",
          truncateHead(feedback.firstFailureMessage, 1200),
          "```",
        );
      }
      lines.push(
        "",
        "Raw test output (tail):",
        "```",
        feedback.testOutput.slice(-2000),
        "```",
        "",
        "Revise whatever is wrong — the body, the tests, or both.",
      );
      if (feedback.allTestsFailed) {
        lines.push(
          "",
          "**Every test failed.** That's a strong signal the tests",
          "themselves may be wrong — you wrote both body and tests",
          "from the same reading of the SPEC, and if that reading was",
          "off, they'll fail together. Before changing the body, re-read",
          "the SPEC and check: do your TESTS' expectations match what",
          "the spec actually requires? If not, fix the tests first.",
        );
      }
      if (feedback.stagnating) {
        lines.push(
          "",
          "**Stagnation detected** — your recent attempts have produced",
          "nearly identical bodies and the same failure count. Cosmetic",
          "tweaks aren't converging. Try a **materially different**",
          "approach: re-read the SPEC from the top, reconsider your",
          "data flow and algorithm, and rewrite the body from scratch",
          "rather than patching the previous one.",
        );
      }
    }
  }

  return lines.join("\n");
}
