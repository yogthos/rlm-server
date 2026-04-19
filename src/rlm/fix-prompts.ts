/**
 * Graduated fix prompts for the structural repair loop.
 * Ported from sporulator/src/sporulator/prompts.clj (lines 110–198).
 *
 * Three tiers escalate as the model fails to repair:
 *   1. standard  — full context, general instruction ("fix it")
 *   2. narrowed  — FIRST failing error only + step-by-step trace
 *   3. fresh     — discard prior approach, restart from spec
 *
 * Keep each prompt strictly generic (no project-specific vocabulary).
 */

export type FixTier = "standard" | "narrowed" | "fresh";

export interface StructuralError {
  layer: string;
  message: string;
  file?: string;
  line?: number;
}

export interface FixContext {
  attempt: number;      // 1-based
  maxAttempts: number;
  targetModule: string;
  targetExports: string[];
  currentCode: string;
  errors: StructuralError[];
  /** Short spec/docstring for the module (from the envelope goal). */
  spec?: string;
}

export function fixTier(attempt: number, maxAttempts: number): FixTier {
  if (attempt <= 1) return "standard";
  if (attempt < maxAttempts) return "narrowed";
  return "fresh";
}

function formatError(e: StructuralError): string {
  const loc = e.file ? (e.line ? `${e.file}:${e.line}` : e.file) : "";
  return loc ? `[${e.layer}] ${loc}: ${e.message}` : `[${e.layer}] ${e.message}`;
}

function header(ctx: FixContext): string {
  return [
    `Target module: ${ctx.targetModule}`,
    `Required exports: ${ctx.targetExports.join(", ")}`,
    ctx.spec ? `Spec: ${ctx.spec}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function standard(ctx: FixContext): string {
  return [
    `Structural validation failed (attempt ${ctx.attempt} / ${ctx.maxAttempts}).`,
    "",
    header(ctx),
    "",
    "## Current Implementation",
    "```ts",
    ctx.currentCode,
    "```",
    "",
    "## Errors",
    ctx.errors.map(formatError).join("\n"),
    "",
    "Fix the implementation. Return ONLY the corrected module contents as a",
    "TypeScript code block. Keep every required export. Do not add code that",
    "is unrelated to the reported errors.",
  ].join("\n");
}

function narrowed(ctx: FixContext): string {
  const first = ctx.errors[0];
  const firstMsg = first ? formatError(first) : "(no error details available)";
  return [
    `Validation is STILL failing after ${ctx.attempt - 1} attempts. Focus on`,
    "fixing this ONE error first — ignore the others until this one is gone.",
    "",
    header(ctx),
    "",
    "## First Failing Error",
    firstMsg,
    "",
    "## Current Implementation",
    "```ts",
    ctx.currentCode,
    "```",
    "",
    "Trace through the logic step-by-step:",
    "  1. What input or call site triggers the error?",
    "  2. What does the current code do with that input?",
    "  3. Where does the actual behavior diverge from what's expected?",
    "",
    "Fix ONLY this error. Return ONLY the corrected module contents as a",
    "TypeScript code block.",
  ].join("\n");
}

function fresh(ctx: FixContext): string {
  const first = ctx.errors[0];
  const firstMsg = first ? formatError(first) : "(no error details available)";
  return [
    `After ${ctx.attempt - 1} failed attempts, start over. **Discard your`,
    "previous approach entirely.**",
    "",
    header(ctx),
    "",
    "## Most Recent Error (for reference only)",
    firstMsg,
    "",
    "Implement the module from scratch. Think step by step:",
    "  1. Re-read the spec and required exports above.",
    "  2. Design a clean implementation that satisfies them.",
    "  3. Pay attention to: types, edge cases, argument counts, imports.",
    "",
    "Return ONLY the complete module contents as a TypeScript code block.",
    "Do not reference what you tried before.",
  ].join("\n");
}

export function buildFixPrompt(ctx: FixContext): string {
  const tier = fixTier(ctx.attempt, ctx.maxAttempts);
  switch (tier) {
    case "standard":
      return standard(ctx);
    case "narrowed":
      return narrowed(ctx);
    case "fresh":
      return fresh(ctx);
  }
}
