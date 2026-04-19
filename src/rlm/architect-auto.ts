/**
 * Auto-enable the Architect role for coding tasks.
 *
 * When a chat request comes in, the server consults this helper to decide
 * whether to wrap the loop in a hierarchical-agent roleBinding with an
 * Architect at depth 0. The default is heuristic-driven (coding-task
 * prompts opt in) but the client can force either direction.
 */

import { Role } from "./roles.js";
import type { RoleBinding } from "./system-prompt.js";
import type { TaskEnvelope } from "./envelopes.js";
import { detectCodingTask } from "./routing.js";

const GOAL_MAX_CHARS = 800;

function buildRootEnvelope(prompt: string, maxDepth: number): TaskEnvelope {
  return {
    goal: prompt.slice(0, GOAL_MAX_CHARS),
    parentContext: "(root)",
    tests: { framework: "vitest", files: {} },
    // The Architect determines the real module/exports per child;
    // validator requires non-empty placeholders at the root.
    targetModule: "<architect-root>",
    targetExports: ["<architect-root>"],
    depth: 0,
    maxDepth,
    budgetHint: "hours",
  };
}

/**
 * Decide whether to attach an Architect role to the root loop.
 *
 *   explicit === true       → always attach
 *   explicit === false      → never attach
 *   explicit === undefined  → attach iff the prompt looks like a coding task
 */
export function maybeArchitectBinding(
  prompt: string,
  explicit: boolean | undefined,
  maxDepth: number,
): RoleBinding | undefined {
  if (explicit === false) return undefined;
  const enabled = explicit === true || detectCodingTask(prompt);
  if (!enabled) return undefined;
  return {
    role: Role.Architect,
    envelope: buildRootEnvelope(prompt, maxDepth),
  };
}
