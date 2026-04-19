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

function renderParam(p: ParamSpec): string {
  const q = p.optional ? "?" : "";
  const def = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : "";
  return `${p.name}${q}: ${p.type}${def}`;
}

/**
 * Render the proc-ts-shape signature shown in the prompt. The
 * `ctx: Ctx` first param is implicit — the harness injects it at
 * emission time — but we still display it here so the Implementer
 * knows ctx is in scope.
 */
function renderSignature(name: string, sig: Signature): string {
  const async = sig.isAsync ? "async " : "";
  const userParams = sig.params.map(renderParam).join(", ");
  const paramList =
    userParams.length > 0 ? `ctx: Ctx, ${userParams}` : "ctx: Ctx";
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
    lines.push("Depends on (call via ctx.fns):");
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
}

export async function buildImplementerPrompt(
  graph: DesignGraph,
  module: string,
  name: string,
  feedback?: ImplementerFeedback,
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
          return `  - ctx.fns.${c}(ctx${params.length > 0 ? ", " + params : ""}): ${cfn.signature.returnType} — ${cfn.description}`;
        })
        .join("\n")
    : "";
  // All project functions are wired into ctx.fns — the body can call
  // ANY of them, not just its formal children. List them as "other
  // available" so the LLM sees the full ctx.fns surface.
  const childSet = new Set(fn.children);
  const otherAvailable = relevant
    .filter((f) => f.name !== fn.name && !childSet.has(f.name))
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return `  - ctx.fns.${f.name}(ctx${params.length > 0 ? ", " + params : ""}): ${f.signature.returnType}`;
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

  const lines = [
    `You are the Implementer of \`${fn.name}\` in the proc-ts project.`,
    "You own BOTH the body AND the tests for this function.",
    "",
    `Signature: ${renderSignature(fn.name, fn.signature)}`,
    descriptionBlock,
    ...specBlock,
    "",
    ...(hasChildren
      ? [
          "This function has ALREADY been DECOMPOSED into children. The",
          "children have been implemented and are green. Your job is to",
          "write the ASSEMBLY body that orchestrates them:",
          "",
          childList,
          "",
          "Call each child via `ctx.fns.<name>(ctx, …)`. The body you write",
          "is the glue code that composes these into this function's",
          "observable behavior.",
          "",
        ]
      : []),
    "PROC-TS CONVENTIONS (mandatory):",
    "- The emitted function has signature",
    `  \`export default function ${fn.name}(ctx: Ctx, ...params)\`.`,
    "  `ctx: Ctx` is ALREADY in scope as the first parameter. You do not",
    "  declare it — you USE it.",
    "- Call sibling functions via `ctx.fns.<name>(ctx, ...args)`. Do NOT",
    "  write `import` statements. Do NOT call siblings by bare name.",
    "  ",
    "  // good:  const db = ctx.fns.connect(ctx, path);",
    "  // bad:   const db = connect(ctx, path);          // ReferenceError",
    "  // bad:   const db = ctx.fns.connect(path);       // missing ctx arg",
    "",
    "- If you need external npm/Node APIs (`fs`, `http`, etc.), use a",
    "  dynamic `require(...)` or `await import(...)` inside the body.",
    "- Runtime data goes on `ctx.state.<key>` (object keyed by string).",
    "",
    ...(otherAvailable.length > 0
      ? [
          hasChildren
            ? "Other project functions also wired into ctx.fns (use when useful):"
            : "All other project functions wired into ctx.fns (call them as needed):",
          otherAvailable,
          "",
        ]
      : []),
    ...existingTestsBlock,
    ...existingBlock,
    "",
    "Task — emit THREE fenced blocks in your response:",
    "",
    "1. ```ts — the function body (statements only, no signature, no",
    `   surrounding \`function\` declaration). This is what \`${fn.name}\``,
    "   does when called.",
    "",
    "2. ```unit-tests — JSON array of tests that exercise THIS function",
    "   in isolation. Each entry is `{\"name\": \"...\", \"code\": \"...\"}`.",
    "   The test `code` runs inside a vitest `it(...)` body — you can",
    `   call the function under test as \`${fn.name}(ctx, ...)\` (it is`,
    "   imported for you). Cover every edge case from the spec and at",
    "   least one example. Unit tests should NOT depend on siblings —",
    "   stub `ctx.fns.<name>` if needed.",
    "",
    integrationNeeded
      ? "3. ```integration-tests — REQUIRED. JSON array, same shape."
      : "3. ```integration-tests — MUST be an empty array `[]` for this function.",
    integrationNeeded
      ? "   Integration tests run with real siblings wired via `ctx.fns`."
      : "   This function has no children to assemble, so integration tests",
    integrationNeeded
      ? "   Because this function assembles children, you MUST include at"
      : "   would not run (the harness only materializes integration test",
    integrationNeeded
      ? "   least one integration test that exercises the full wire-up."
      : "   files for branches). Emit `[]` and put behavior coverage in unit tests.",
    "",
    "Fence shape:",
    "```ts",
    "// body statements",
    "```",
    "```unit-tests",
    "[",
    '  {"name": "...", "code": "..."}',
    "]",
    "```",
    "```integration-tests",
    "[",
    '  {"name": "...", "code": "..."}',
    "]",
    "```",
    "",
    "Rules:",
    "- Do not narrate, do not call test_run, do not call design_implement.",
    "  The harness runs the tests and saves the body on your behalf.",
    "- If the tests fail, you will be called again with the failure output.",
    "  You can revise BOTH the body and the tests on each retry — whichever",
    "  you believe is wrong. Emitting a `unit-tests` or `integration-tests`",
    "  block on retry patches the stored tests (same-name overwrites,",
    "  new-name appends). Omit the block to keep existing tests unchanged.",
    "- Tests are YOURS. Siblings' tests and project-level tests are out",
    "  of scope for you.",
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
    }
  }

  return lines.join("\n");
}
