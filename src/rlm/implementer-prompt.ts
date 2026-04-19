/**
 * Build the focused brief an Implementer agent sees for a single function.
 * Pure function over the DesignGraph — no I/O, no file reads. Decision
 * making happens against the graph; files exist only for test execution.
 */

import type {
  DesignGraph,
  FunctionNode,
  ParamSpec,
  Signature,
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


function renderTests(fn: FunctionNode): string {
  if (fn.tests.length === 0) return "(no tests declared for this function yet)";
  const lines: string[] = [];
  for (const t of fn.tests) {
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
    ? ["", "Purpose (read carefully before writing code):", fn.description].join(
        "\n",
      )
    : "";

  const existingBlock: string[] = [];
  if (fn.implementation !== null) {
    existingBlock.push(
      "",
      "Current implementation (already saved for this function):",
      "```",
      fn.implementation,
      "```",
      "",
      "Your task is to MODIFY this body so the declared tests pass.",
      "Preserve any behavior not contradicted by the tests. Prefer the",
      "smallest change that satisfies the contract.",
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
  // Non-child relevant functions: signature-only. Descriptions are
  // dropped here because they repeat information the LLM doesn't need
  // to write THIS function — knowing how to CALL each one is enough.
  const otherAvailable = relevant
    .filter((f) => f.name !== fn.name && !childSet.has(f.name))
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return `  - ctx.fns.${f.name}(ctx${params.length > 0 ? ", " + params : ""}): ${f.signature.returnType}`;
    })
    .join("\n");
  const lines = [
    `You are the Implementer of \`${fn.name}\` in the proc-ts project.`,
    "",
    `Signature: ${renderSignature(fn.name, fn.signature)}`,
    descriptionBlock,
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
    "Tests this function must pass:",
    renderTests(fn),
    ...existingBlock,
    "",
    "Task:",
    `- Return the body of \`${fn.name}\` — statements only, no surrounding`,
    "  `function` declaration and no signature line — inside a single",
    "  fenced block tagged ```ts.",
    "- Do not narrate, do not call test_run, do not call design_implement.",
    "  The harness runs the tests and saves the body on your behalf.",
    "- If the tests fail, you will be called again with the failure output.",
    "",
    "**Tests CAN have bugs.** If a test is wrong (e.g. expects a sync",
    "return from an async API, uses a wrong matcher, hard-codes a race),",
    "you can fix it. In a SECOND fenced block tagged ```tests, emit a",
    "JSON array of replacement tests for THIS function only:",
    "",
    "```tests",
    "[",
    '  {"name": "<same name as an existing test to override>", "code": "<new test body>"},',
    '  {"name": "<a brand new test name>", "code": "<new test body>"}',
    "]",
    "```",
    "",
    "Rules for modifying tests:",
    "- Only modify this function's OWN tests. Siblings and project-level",
    "  tests are out of scope.",
    "- Patches must preserve the function's observable contract. If the",
    "  original test was asserting behavior X and the right API is async,",
    "  fix the ASSERTION to be async-correct — don't weaken the contract.",
    "- If you don't need to modify tests, omit the ```tests block.",
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
      "",
      "That body failed the tests. Output:",
      "```",
      feedback.testOutput.slice(-2000),
      "```",
      "",
      "Revise the body and return a fresh attempt in a single fenced block.",
    );
  }

  return lines.join("\n");
}
