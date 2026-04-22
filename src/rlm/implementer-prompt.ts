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
    "",
    ...existingTestsBlock,
    ...existingBlock,
    ...decisionsBlock,
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
    if (typeof feedback.previousPassed === "number") {
      lines.push(
        "",
        `Previous attempt: ${feedback.previousPassed} tests passed, ${feedback.previousFailed ?? 0} failed.`,
        "**Do not regress** — whatever you change, preserve the tests that",
        "were already passing. If a previously-passing test now fails,",
        "your new body broke something that was working.",
      );
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
      lines.push(
        "",
        "Static-analysis violation (tests were NOT run — the body failed",
        "a structural proc-ts check):",
        "```",
        feedback.analyzerFeedback.slice(-2000),
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
        feedback.architectFeedback.slice(-2000),
        "```",
        "",
        "Revise the body (and/or tests) to address the Architect's concerns.",
      );
    } else {
      lines.push(
        "",
        "Test output:",
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
