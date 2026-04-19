/**
 * Response templates — per-role / per-step expected output shape. When
 * the model's turn doesn't match the active template, we inject the
 * template back as a nudge so the next turn has a concrete form to fill.
 *
 * These are FORMAT checks, not semantic. They fire every turn (until the
 * per-template cap) so the model sees the expected shape repeatedly
 * rather than only at FINAL time. The deeper semantic gates (dispatch,
 * structural, spec) still run afterward.
 */

import type { RLMContext } from "./types.js";
import type { ExtractionResult } from "./code-extractor.js";
import { Role } from "./roles.js";

export type TemplateCheck = { ok: true } | { ok: false; nudge: string };

export interface ResponseTemplate {
  name: string;
  /** How many times this template may fire per run. Protects against spam. */
  maxFires: number;
  /** Only invoke when the context is in a state this template governs. */
  applies(ctx: RLMContext): boolean;
  /** Check the extracted output against the template. */
  validate(ctx: RLMContext, extraction: ExtractionResult): TemplateCheck;
}

const ARCHITECT_DISPATCH_NUDGE = [
  "Your turn did not fit the ARCHITECT format.",
  "",
  "Your sandbox code must call `design_plan(taskDescription)` and",
  "nothing else until the report comes back. Do NOT write the",
  "implementation inline. Do NOT call design_module / design_function /",
  "design_test / design_build by hand.",
  "",
  "Template:",
  "",
  "```repl",
  "const report = await design_plan(<taskDescription as string>);",
  "```",
  "",
  "When the report returns:",
  "  - report.ok === true   → `FINAL_FILES(report)` (the variable, not an",
  "                           inline object literal).",
  "  - otherwise inspect report.phase and call design_build() or",
  "    design_plan() again with the fix.",
  "",
  "No prose-only turns. No writing implementation bodies yourself.",
].join("\n");

export const ARCHITECT_DISPATCH_SHAPE: ResponseTemplate = {
  name: "architect-dispatch-shape",
  maxFires: 3,
  applies(ctx) {
    return (
      ctx.subRLMDepth === 0 &&
      ctx.roleBinding?.role === Role.Architect &&
      ctx.iteration >= 1 &&
      ctx.spawnStats.dispatched === 0
    );
  },
  validate(_ctx, extraction) {
    // If the agent decided IMPLEMENT-directly or already hit FINAL_FILES,
    // let it through; the structural-repair gate downstream handles the
    // rest.
    if (extraction.finalAnswer || extraction.finalVar || extraction.finalFiles) {
      return { ok: true };
    }
    const code = extraction.code ?? "";
    if (code.length === 0) {
      return { ok: false, nudge: ARCHITECT_DISPATCH_NUDGE };
    }
    // Graph-first primitives — the new workflow.
    if (
      /\bdesign_(module|function|import|test|dispatch|consistency|finalize|build|query|implement|load|plan)\s*\(/.test(
        code,
      )
    ) {
      return { ok: true };
    }
    // Legacy batch_llm_query path — still valid for generic recursion
    // (chunked analysis, non-code tasks).
    if (/\bbatch_llm_query\s*\(/.test(code)) return { ok: true };
    return { ok: false, nudge: ARCHITECT_DISPATCH_NUDGE };
  },
};

const PLANNER_DISPATCH_NUDGE = [
  "Your turn did not fit the PLANNER format.",
  "",
  "For multi-item coding tasks, your next repl block must do one of:",
  "  (a) state the plan as numbered JS comments, then",
  "  (b) turn each step into a sub-task prompt and dispatch them all",
  "      via `await batch_llm_query(tasks)`.",
  "",
  "Template:",
  "",
  "```repl",
  "// 1. <3-5 word step>",
  "// 2. <3-5 word step>",
  "// 3. <3-5 word step>",
  'const tasks = ["<expanded prompt for step 1>", "<for step 2>", "<for step 3>"];',
  "const results = await batch_llm_query(tasks);",
  "console.log(JSON.stringify(results));",
  "```",
  "",
  "Do not solve the task inline — decompose and dispatch.",
].join("\n");

export const PLANNER_DISPATCH_SHAPE: ResponseTemplate = {
  name: "planner-dispatch-shape",
  maxFires: 3,
  applies(ctx) {
    return (
      ctx.subRLMDepth === 0 &&
      !ctx.roleBinding &&
      ctx.requiresPlan &&
      ctx.iteration >= 1 &&
      ctx.spawnStats.dispatched === 0
    );
  },
  validate(_ctx, extraction) {
    const code = extraction.code ?? "";
    if (/\bbatch_llm_query\s*\(/.test(code)) return { ok: true };
    // Skeleton plan with at least two numbered-comment lines is an
    // acceptable intermediate step.
    const planLines = (code.match(/^\s*\/\/\s*\d+\./gm) ?? []).length;
    if (planLines >= 2) return { ok: true };
    return { ok: false, nudge: PLANNER_DISPATCH_NUDGE };
  },
};

const DISPATCHER_NUDGE = [
  "Your turn did not fit the AGENT format.",
  "",
  "At every internal depth, apply the decide heuristic FIRST:",
  "  - IMPLEMENT: ≲100 LOC, one module, one coherent concern, you know",
  "    exactly what to write → write the code and FINAL(source).",
  "  - DISPATCH: multi-file / multi-concern / unsure → build subtasks",
  "    and call batch_llm_query.",
  "",
  "Prose-only turns are not productive. Your next turn must be either:",
  "",
  "    ```repl",
  '    const r = await batch_llm_query([/* focused sub-task prompts */]);',
  "    ```",
  "",
  "OR a FINAL with your complete module source.",
].join("\n");

/**
 * Dispatcher format template — mirrors Architect at non-root depth. A
 * per-turn nudge toward the decide heuristic: either batch_llm_query OR a
 * FINAL with code. Prose-only turns and non-progressive code blocks fail.
 */
export const DISPATCHER_SHAPE: ResponseTemplate = {
  name: "dispatcher-shape",
  maxFires: 3,
  applies(ctx) {
    return (
      ctx.roleBinding?.role === Role.Dispatcher &&
      ctx.iteration >= 1 &&
      ctx.spawnStats.dispatched === 0
    );
  },
  validate(_ctx, extraction) {
    // IMPLEMENT path: FINAL (text or var) — structural gate handles the rest.
    if (extraction.finalAnswer || extraction.finalVar) return { ok: true };
    const code = extraction.code ?? "";
    if (code.length === 0) return { ok: false, nudge: DISPATCHER_NUDGE };
    if (/\bbatch_llm_query\s*\(/.test(code)) return { ok: true };
    return { ok: false, nudge: DISPATCHER_NUDGE };
  },
};

const TEMPLATES: ResponseTemplate[] = [
  ARCHITECT_DISPATCH_SHAPE,
  DISPATCHER_SHAPE,
  PLANNER_DISPATCH_SHAPE,
];

export function runTemplates(
  ctx: RLMContext,
  extraction: ExtractionResult,
): { template: ResponseTemplate; nudge: string } | null {
  for (const t of TEMPLATES) {
    if (!t.applies(ctx)) continue;
    const fires = ctx.formatNudges[t.name] ?? 0;
    if (fires >= t.maxFires) continue;
    const result = t.validate(ctx, extraction);
    if (!result.ok) return { template: t, nudge: result.nudge };
  }
  return null;
}
