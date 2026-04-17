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
  return `## ROLE: ARCHITECT (depth 0)

You own the top level. Your job:

1. Author **acceptance tests** that define user-facing success for the whole task.
2. Produce a **high-level decomposition** — 2–5 subtasks, each with its own target module, exports, and unit tests.
3. Self-review the tests before locking.
4. Dispatch children. Assemble their artifacts. Run acceptance tests.

You do NOT write implementation code yourself. Your output is tests + decomposition + orchestration.

${envelopeSummary(env)}

${COMMON_TERMINATION}`;
}

function dispatcherPrompt(env: TaskEnvelope): string {
  const nearLeaf = env.depth >= env.maxDepth - 1;
  const leafWarning = nearLeaf
    ? `\n**You are one level above maxDepth — any children you dispatch will be forced Implementers (leaf) and cannot decompose further.** Split only if each subtask is directly implementable.`
    : "";

  return `## ROLE: DISPATCHER (depth ${env.depth} of ${env.maxDepth})

You received a task with tests already authored by your parent. Your job:

1. Decide **split vs. implement** for this task.
2. If **split**: decompose into 2–5 subtasks. For each child, author unit tests, pick a targetModule and targetExports, dispatch. Then assemble and run integration tests.
3. If **implement**: degrade to Implementer behavior for this turn — write code at targetModule that satisfies the incoming tests.

The incoming tests are a **locked contract** — your implementation (or your children's) must satisfy them.${leafWarning}

${envelopeSummary(env)}

${COMMON_TERMINATION}`;
}

function implementerPrompt(env: TaskEnvelope): string {
  return `## ROLE: IMPLEMENTER (leaf, depth ${env.depth})

You received a task with tests. Your single job: **write code at targetModule that passes those tests.** No sub-dispatch. Do not decompose. Do not author new tests.

If you cannot satisfy the tests, return a ResultEnvelope with status "failed" and a full trace of what you tried. The parent decides what to do.

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
