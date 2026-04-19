/**
 * Roles for the hierarchical agent system.
 * See docs/hierarchical-agents.md §3.1.
 *
 * Same recursive agent, different system-prompt header depending on tree position.
 */

import type { TaskEnvelope } from "./envelopes.js";

export const Role = {
  Architect: "architect",
  Dispatcher: "dispatcher",
  Implementer: "implementer",
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * Pick role from envelope position:
 *   depth 0           → Architect
 *   0 < depth < max   → Dispatcher
 *   depth >= max      → Implementer (auto-degrade at max depth)
 */
export function selectRole(env: TaskEnvelope): Role {
  if (env.depth === 0) return Role.Architect;
  if (env.depth >= env.maxDepth) return Role.Implementer;
  return Role.Dispatcher;
}

const COMMON_TERMINATION = `
When finished, return a \`ResultEnvelope\` as JSON inside FINAL_VAR(result). Do NOT return prose via FINAL(); the envelope is the contract with the parent.
`.trim();

/**
 * The adaptive decide heuristic that every non-leaf agent applies every
 * turn. Leaves (Implementers) skip this — they always implement.
 */
const DECIDE_HEURISTIC = `
### Decide FIRST: IMPLEMENT or DISPATCH

Before any code, decide which mode you're in for this task.

**IMPLEMENT** yourself if ALL of these are true:
  - The task fits in ≲100 LOC of a single module
  - You know exactly what to write (no "let me research how X works")
  - It's one coherent concern (one file / one function / one type)

**DISPATCH** via \`design_dispatch(module, name)\` if ANY of these are true:
  - Multi-file scope
  - Multiple distinct concerns (types + pure-logic + I/O + wiring)
  - ≥3 distinct spec items
  - You are unsure how to start

If IMPLEMENT: declare the function on the graph with \`design_function\`,
attach tests with \`design_test\`, then fill the body directly with
\`design_implement\` and close via \`design_finalize\`.

If DISPATCH: declare every module/function/test on the DesignGraph first,
validate with \`design_consistency()\`, then call \`design_dispatch\` for
each function (in parallel via \`Promise.all\`). Implementers iterate
\`test_run\` → \`design_implement\` in their own sandbox. Close with
\`design_finalize({ typecheck: true })\` and return \`FINAL_FILES(report)\`.
`.trim();

function envelopeSummary(env: TaskEnvelope): string {
  const parts = [
    `Goal: ${env.goal}`,
    `Parent context: ${env.parentContext}`,
    `Target module: ${env.targetModule}`,
    `Target exports: ${env.targetExports.join(", ")}`,
    `Depth: ${env.depth} / ${env.maxDepth}`,
    `Budget: ${env.budgetHint}`,
  ];
  if (env.siblingSummaries && env.siblingSummaries.length > 0) {
    parts.push(`Siblings:\n${env.siblingSummaries.map((s) => `  - ${s}`).join("\n")}`);
  }
  if (env.structuralContract) {
    parts.push(`Structural contract (extra Prolog rules):\n${env.structuralContract}`);
  }
  return parts.join("\n");
}

function architectPrompt(env: TaskEnvelope): string {
  const goalLiteral = JSON.stringify(env.goal).replace(/\\/g, "\\\\");
  return `## ROLE: ARCHITECT (depth 0)

The harness handles everything mechanically. Your entire first turn is
one line of code.

If the task is greenfield:

\`\`\`repl
const report = await design_plan(${goalLiteral});
\`\`\`

If the task modifies existing code, load those files first:

\`\`\`repl
await design_load("src/<existing>.js");
const report = await design_plan(${goalLiteral});
\`\`\`

\`design_plan\` runs a RECURSIVE multi-turn pipeline:
1. Fresh turn, narrowly scoped: list the top-level functions needed.
2. For each function: write a rich description + INTEGRATION tests —
   tests that exercise how this function contributes to the assembly.
3. Dispatch each function. The dispatched agent decides:
   - **IMPLEMENT** directly (writes a short body + unit-level assertions), OR
   - **DECOMPOSE** into children (becomes a mini-Architect for its own
     subtree; the harness recursively plans + dispatches the children,
     then comes back to assemble them into this function's body).
4. Each subtree is a self-contained assembly. Children become green
   first; parents are written as glue code calling \`ctx.fns.<child>(ctx, …)\`.
5. Finalize — vitest + tsc — returns a BuildReport.

**Do not declare \`design_module\`, \`design_function\`, \`design_test\`, or
call \`design_build\`/\`design_dispatch\` by hand.** The pipeline owns those
— you only get to correct course if it comes back with \`ok: false\`.

After \`design_plan\` returns:

- \`report.ok\` true → \`FINAL_FILES(report)\`.
- \`report.phase === "plan"\` → call \`design_plan(...)\` again with a clearer task description.
- \`report.phase === "consistency"\` → the generated design has a broken import/export; fix with \`design_import\` or re-plan and call \`design_build()\`.
- \`report.phase === "dispatch"\` → inspect \`report.failed[i].testOutput\`; add or rewrite tests via \`design_test\`, then \`design_build()\` (green functions are remembered, not re-dispatched).
- \`report.phase === "finalize"\` → \`report.finalize.testOutput\` or \`.typecheckOutput\` carry the failure; patch and call \`design_build()\`.

${envelopeSummary(env)}

${COMMON_TERMINATION}`;
}

function dispatcherPrompt(env: TaskEnvelope): string {
  const nearLeaf = env.depth >= env.maxDepth - 1;
  const leafWarning = nearLeaf
    ? `\n**You are one level above maxDepth — any children you dispatch will be forced Implementers (leaf) and cannot decompose further.** Dispatch only if each subtask is directly implementable.`
    : "";

  return `## ROLE: AGENT (depth ${env.depth} of ${env.maxDepth})

You received a task with tests already authored by your parent. The tests
are a **locked contract** — whatever you produce (directly or via children)
must satisfy them.${leafWarning}

${DECIDE_HEURISTIC}

${envelopeSummary(env)}

${COMMON_TERMINATION}`;
}

function implementerPrompt(env: TaskEnvelope): string {
  return `## ROLE: IMPLEMENTER (leaf, depth ${env.depth})

You received a task with tests. Your single job: **write a function body that passes those tests.** No sub-dispatch. Do not decompose. Do not author new tests. Do not re-declare signatures — the graph already has them.

### Your tool loop

1. Draft a candidate body as a JS string (statements only, no wrapping \`function\` declaration).
2. Call \`test_run(module, name, body)\` — it materializes the graph with your body substituted, runs vitest, and returns \`{ok, passed, failed, output}\`.
3. If \`ok\` is false, read the output, revise the body, and call \`test_run\` again. Repeat until green.
4. When green, call \`design_implement(module, name, body)\` to persist the body in the shared DesignGraph.
5. Return \`FINAL_VAR(body)\`.

If you exhaust a reasonable number of attempts (≈5) without going green, return a ResultEnvelope with status "failed" and the last test output. The parent decides what to do next.

${envelopeSummary(env)}

${COMMON_TERMINATION}`;
}

/**
 * Build the role-specific system-prompt header.
 * Composed above the shared tool/REPL body produced by buildSystemPrompt().
 */
export function buildRolePrompt(role: Role, env: TaskEnvelope): string {
  switch (role) {
    case Role.Architect:
      return architectPrompt(env);
    case Role.Dispatcher:
      return dispatcherPrompt(env);
    case Role.Implementer:
      return implementerPrompt(env);
  }
}
