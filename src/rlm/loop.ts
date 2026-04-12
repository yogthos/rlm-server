/**
 * Core RLM (Recursive Language Model) loop.
 *
 * Implements Algorithm 1 from arXiv-2512.24601v2 using FSMEngine:
 *   init → generate → execute → check_final → done
 *
 * Key improvements over the paper:
 * - JavaScript sandbox instead of Python REPL
 * - Descriptive handle system (Matryoshka) for token savings
 * - Z3 and Tau Prolog available as sandbox tools
 */

import { FSMEngine } from "../fsm.js";
import type { FSMSpec } from "../fsm.js";
import { createSandbox } from "../sandbox.js";
import {
  GREP_IMPL,
  FUZZY_SEARCH_IMPL,
  COUNT_TOKENS_IMPL,
  LOCATE_LINE_IMPL,
  LLM_QUERY_IMPL,
} from "../builtins/index.js";

import type { RLMContext, RLMResult, LLMClient, ChatMessage } from "./types.js";
import { createHandleStore } from "./handles.js";
import { extractCode } from "./code-extractor.js";
import { promptMetadata, stdoutMetadata } from "./metadata.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { z3Solve, Z3_IMPL } from "./z3-bridge.js";
import { prologQuery, PROLOG_IMPL } from "./prolog-bridge.js";
import { graphAnalyze, GRAPH_IMPL } from "./graph-bridge.js";

const MAX_NO_CODE_RETRIES = 3;
const MAX_HISTORY_ENTRIES = 40;

function guessContentType(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "JSON document";
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) return "HTML document";
  if (trimmed.startsWith("#") || /^#{1,6}\s/m.test(trimmed)) return "Markdown document";
  return "text document";
}

/** Trim history to stay within context window budget. */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_HISTORY_ENTRIES) return history;

  // Keep system prompt (first) and most recent messages
  const system = history[0];
  const keep = MAX_HISTORY_ENTRIES - 1;
  return [system, ...history.slice(-keep)];
}

// ─── FSM State Handlers ───────────────────────────────────────────────

async function initHandler(ctx: RLMContext): Promise<RLMContext> {
  const handleStore = createHandleStore();

  // Build sub-RLM bridge for llm_query
  const llmQueryBridge = async (prompt: string): Promise<string> => {
    if (ctx.subRLMDepth >= ctx.maxSubRLMDepth) {
      // At max depth, do a single-shot LLM call
      const resp = await ctx.llmClient.chat([
        {
          role: "system",
          content: "Answer the following query concisely. Provide only the answer as plain text.",
        },
        { role: "user", content: prompt },
      ]);
      return resp.content;
    }

    // Spawn a nested RLM loop
    const subResult = await runRLMLoop({
      prompt,
      llmClient: ctx.llmClient,
      maxIterations: Math.max(3, Math.floor(ctx.maxIterations / 2)),
      sandboxTimeoutMs: ctx.sandboxTimeoutMs,
      maxSubRLMDepth: ctx.maxSubRLMDepth,
      subRLMDepth: ctx.subRLMDepth + 1,
    });
    return subResult.answer;
  };

  const sandbox = createSandbox(ctx.prompt, {
    builtins: [
      GREP_IMPL,
      FUZZY_SEARCH_IMPL,
      COUNT_TOKENS_IMPL,
      LOCATE_LINE_IMPL,
      LLM_QUERY_IMPL,
      Z3_IMPL,
      PROLOG_IMPL,
      GRAPH_IMPL,
    ],
    globals: {
      __llmQueryBridge: llmQueryBridge,
      __z3Bridge: z3Solve,
      __prologBridge: prologQuery,
      __graphBridge: graphAnalyze,
    },
    timeoutMs: ctx.sandboxTimeoutMs,
    maxVariables: 200,
  });

  const lines = ctx.prompt.split("\n");
  const systemPrompt = buildSystemPrompt({
    contextLength: ctx.prompt.length,
    contextLineCount: lines.length,
    contextPreview: ctx.prompt.slice(0, 200),
    contextType: guessContentType(ctx.prompt),
  });

  const meta = promptMetadata(ctx.prompt);
  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: meta },
  ];

  return {
    ...ctx,
    sandbox,
    handleStore,
    systemPrompt,
    history,
    iteration: 0,
  };
}

async function generateHandler(ctx: RLMContext): Promise<RLMContext> {
  const trimmed = trimHistory(ctx.history);
  const response = await ctx.llmClient.chat(trimmed);
  const llmOutput = response.content;

  const extraction = extractCode(llmOutput);

  // Append assistant message to history
  const history = [...ctx.history, { role: "assistant" as const, content: llmOutput }];

  // Check for FINAL_VAR — resolve from sandbox
  if (extraction.finalVar && !extraction.code) {
    // Try to resolve the variable from a previous execution
    const resolved = ctx.handleStore.resolve(`$${extraction.finalVar}`)
      ?? ctx.handleStore.resolve(extraction.finalVar);

    if (resolved !== undefined) {
      const answer = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
      return { ...ctx, history, lastLLMOutput: llmOutput, lastCode: null, finalAnswer: answer };
    }

    // Variable not in handles — try resolving via sandbox execution
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: extraction.finalVar,
      finalAnswer: null,
    };
  }

  return {
    ...ctx,
    history,
    lastLLMOutput: llmOutput,
    lastCode: extraction.code,
    finalAnswer: extraction.finalAnswer,
    lastError: null,
    noCodeCount: extraction.code ? 0 : ctx.noCodeCount + 1,
  };
}

async function executeHandler(ctx: RLMContext): Promise<RLMContext> {
  if (!ctx.sandbox || !ctx.lastCode) return ctx;

  const startMs = Date.now();
  const result = await ctx.sandbox.execute(ctx.lastCode, ctx.sandboxTimeoutMs);
  const durationMs = Date.now() - startMs;

  const stdout = result.logs.join("\n");
  const error = result.error ?? null;

  // Store result as handle
  const handle = ctx.handleStore.set(
    result.error ? { error: result.error } : result.result,
    ctx.lastCode,
  );

  // Build feedback for the LLM — metadata only, never full results
  const parts: string[] = [];
  if (error) {
    parts.push(`Execution error: ${error}`);
  }
  if (stdout) {
    parts.push(stdoutMetadata(stdout));
  }
  if (!error) {
    parts.push(`Result stored as ${handle.name}`);
  }
  const bindings = ctx.handleStore.buildContext();
  if (bindings) {
    parts.push("", bindings);
  }

  const feedback = parts.join("\n");

  const trace: RLMContext["trace"] = [
    ...ctx.trace,
    {
      iteration: ctx.iteration,
      code: ctx.lastCode,
      stdout: stdout.slice(0, 500),
      handlesSummary: `${ctx.handleStore.size} handles`,
      error: error ?? undefined,
      durationMs,
    },
  ];

  // Append REPL output as "user" message (environment response)
  const history = [
    ...ctx.history,
    { role: "user" as const, content: feedback },
  ];

  return {
    ...ctx,
    history,
    trace,
    lastError: error,
    lastCode: null,
  };
}

async function checkFinalHandler(ctx: RLMContext): Promise<RLMContext> {
  if (ctx.finalAnswer) return ctx;

  const nextIteration = ctx.iteration + 1;

  // Force final answer on last iteration
  if (nextIteration >= ctx.maxIterations) {
    const history = [
      ...ctx.history,
      {
        role: "user" as const,
        content: "You have reached the maximum number of iterations. You MUST now provide your final answer using FINAL(your answer) or FINAL_VAR(variableName). Do not write any more code.",
      },
    ];
    return { ...ctx, history, iteration: nextIteration };
  }

  // Nudge if too many iterations without code
  if (ctx.noCodeCount >= MAX_NO_CODE_RETRIES) {
    const history = [
      ...ctx.history,
      {
        role: "user" as const,
        content:
          "Please either write code in a ```repl block to continue analysis, or provide your final answer with FINAL(answer) or FINAL_VAR(variableName).",
      },
    ];
    return {
      ...ctx,
      history,
      iteration: nextIteration,
      noCodeCount: 0,
    };
  }

  return { ...ctx, iteration: nextIteration };
}

function doneHandler(ctx: RLMContext): RLMContext {
  // Cleanup
  ctx.sandbox?.dispose();
  return {
    ...ctx,
    sandbox: null,
    finalAnswer: ctx.finalAnswer ?? "No answer produced within the iteration limit.",
  };
}

// ─── FSM Spec ─────────────────────────────────────────────────────────

function buildRLMSpec(): FSMSpec<RLMContext> {
  return {
    initial: "init",
    terminal: new Set(["done"]),
    maxIterations: 500, // generous ceiling; real limit is maxIterations in check_final
    states: new Map([
      [
        "init",
        {
          handler: initHandler,
          transitions: [["generate", () => true]],
        },
      ],
      [
        "generate",
        {
          handler: generateHandler,
          transitions: [
            // FINAL found in text (no code to execute)
            ["done", (c: RLMContext) => c.finalAnswer !== null && c.lastCode === null],
            // Code to execute
            ["execute", (c: RLMContext) => c.lastCode !== null],
            // Forced final on last iteration
            [
              "done",
              (c: RLMContext) => c.iteration >= c.maxIterations && c.finalAnswer !== null,
            ],
            // No code, no final — loop back
            ["check_final", () => true],
          ],
        },
      ],
      [
        "execute",
        {
          handler: executeHandler,
          transitions: [["check_final", () => true]],
        },
      ],
      [
        "check_final",
        {
          handler: checkFinalHandler,
          transitions: [
            ["done", (c: RLMContext) => c.finalAnswer !== null],
            // Exceeded max iterations after the forced prompt
            ["done", (c: RLMContext) => c.iteration > c.maxIterations],
            ["generate", () => true],
          ],
        },
      ],
      [
        "done",
        {
          handler: doneHandler,
          transitions: [],
        },
      ],
    ]),
  };
}

// ─── Public API ───────────────────────────────────────────────────────

export interface RunRLMOptions {
  prompt: string;
  llmClient: LLMClient;
  maxIterations?: number;
  sandboxTimeoutMs?: number;
  maxSubRLMDepth?: number;
  subRLMDepth?: number;
  onIteration?: (iteration: number, state: string) => void;
}

/**
 * Run the RLM loop on a prompt.
 *
 * The loop iterates: LLM generates code → sandbox executes → results stored
 * as handles → metadata fed back to LLM → until FINAL() or max iterations.
 */
export async function runRLMLoop(options: RunRLMOptions): Promise<RLMResult> {
  const {
    prompt,
    llmClient,
    maxIterations = 30,
    sandboxTimeoutMs = 30_000,
    maxSubRLMDepth = 3,
    subRLMDepth = 0,
  } = options;

  const initialCtx: RLMContext = {
    prompt,
    systemPrompt: "",
    maxIterations,
    llmClient,
    sandboxTimeoutMs,
    maxSubRLMDepth,
    subRLMDepth,
    sandbox: null,
    handleStore: createHandleStore(),
    history: [],
    iteration: 0,
    finalAnswer: null,
    lastCode: null,
    lastLLMOutput: null,
    lastError: null,
    noCodeCount: 0,
    trace: [],
  };

  const spec = buildRLMSpec();
  const engine = new FSMEngine<RLMContext>();

  const finalCtx = await engine.run(spec, initialCtx, {
    onTransition: (from, to) => {
      options.onIteration?.(initialCtx.iteration, `${from} → ${to}`);
    },
  });

  return {
    answer: finalCtx.finalAnswer ?? "No answer produced.",
    iterations: finalCtx.iteration,
    trace: finalCtx.trace,
  };
}
