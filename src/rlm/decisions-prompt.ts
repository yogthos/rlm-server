/**
 * Shared helper: render the architect's phase-0 decisions as a block
 * of prompt lines. Injected into every code-gen prompt (implementer,
 * walkthrough, integration tests, repair) so every LLM call speaks
 * the stack the architect committed to — runtime, test framework,
 * test command, imports, mocking strategy, testing notes.
 *
 * Returns an array of strings ready to be spread into a prompt line
 * array. Empty array when no projectConfig is set (legacy graphs).
 */

import type { DesignGraph } from "./design-graph.js";

export function renderDecisionsBlock(graph: DesignGraph): string[] {
  const cfg = graph.getProjectConfig();
  if (!cfg) return [];
  const lines: string[] = [
    "",
    "Project decisions (committed at phase 0 — do not deviate):",
    `  runtime:         ${cfg.runtime}`,
    `  moduleSystem:    ${cfg.moduleSystem}`,
    `  testFramework:   ${cfg.testFramework}`,
    `  testCommand:     ${cfg.testCommand}`,
    ...(cfg.singleTestCommand
      ? [`  singleTestCommand: ${cfg.singleTestCommand}`]
      : []),
    `  testImports:     ${cfg.testImports}`,
  ];
  if (cfg.packageManager) {
    lines.push(`  packageManager:  ${cfg.packageManager}`);
  }
  if (cfg.mockingStrategy) {
    lines.push(`  mockingStrategy: ${cfg.mockingStrategy.slice(0, 400)}`);
  }
  if (cfg.testingNotes) {
    lines.push("  testingNotes:");
    for (const l of cfg.testingNotes.split("\n")) lines.push(`    ${l}`);
  }
  lines.push("");
  return lines;
}
