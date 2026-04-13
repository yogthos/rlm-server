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
import { promptMetadata, stdoutMetadata, guessContentType } from "./metadata.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { z3Solve, Z3_IMPL } from "./z3-bridge.js";
import { prologQuery, PROLOG_IMPL } from "./prolog-bridge.js";
import { createGraphBridge, GRAPH_IMPL } from "./graph-bridge.js";
import { debug } from "./debug.js";
import { compactHistory, shouldCompact } from "./history.js";

const MAX_NO_CODE_RETRIES = 3;
/** If the same error appears this many times in a row, force final answer. */
const MAX_REPEATED_ERRORS = 3;

/** Compaction thresholds. When history exceeds either, we summarize.
 *  If the model is decomposing properly, top-level context should stay
 *  small regardless of total work — compaction is a safety net, not
 *  the primary bound. Looser thresholds reduce compaction overhead and
 *  let the model keep more rich context per turn. */
const COMPACT_MAX_MESSAGES = 20;
const COMPACT_MAX_CHARS = 48_000;
/** Always keep the last N messages verbatim even when compacting. */
const COMPACT_KEEP_RECENT = 6;

// ─── FSM State Handlers ───────────────────────────────────────────────

async function initHandler(ctx: RLMContext): Promise<RLMContext> {
  const indent = "  ".repeat(ctx.subRLMDepth);
  debug(
    "rlm",
    `init depth=${ctx.subRLMDepth}/${ctx.maxSubRLMDepth} prompt=${ctx.prompt.length}ch maxIter=${ctx.maxIterations}`,
  );
  debug(
    "tree",
    `${indent}├─ SPAWN d=${ctx.subRLMDepth} prompt="${ctx.prompt.slice(0, 60).replace(/\n/g, " ")}..."`,
  );
  const handleStore = createHandleStore();

  // Track fan-out: how many sub-calls this context has dispatched.
  // Use existing ctx.spawnStats if already set (handlers preserve it),
  // otherwise create new. The object is mutated by llmQueryBridge below.
  const spawnStats = ctx.spawnStats ?? { dispatched: 0, completed: 0 };

  // Build sub-RLM bridge for llm_query
  const llmQueryBridge = async (prompt: string): Promise<string> => {
    spawnStats.dispatched++;
    const myIdx = spawnStats.dispatched;
    const indent = "  ".repeat(ctx.subRLMDepth + 1);
    debug(
      "tree",
      `${indent}→ dispatched #${myIdx} from d=${ctx.subRLMDepth} (total dispatched=${spawnStats.dispatched}, returned=${spawnStats.completed})`,
    );

    if (ctx.subRLMDepth >= ctx.maxSubRLMDepth) {
      // At max depth, do a single-shot LLM call
      debug("tree", `${indent}  (single-shot at max depth)`);
      const resp = await ctx.llmClient.chat([
        {
          role: "system",
          content: "Answer the following query concisely. Provide only the answer as plain text.",
        },
        { role: "user", content: prompt },
      ]);
      spawnStats.completed++;
      debug(
        "tree",
        `${indent}← #${myIdx} returned ${resp.content.length}ch (completed=${spawnStats.completed}/${spawnStats.dispatched})`,
      );
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
    spawnStats.completed++;
    debug(
      "tree",
      `${indent}← #${myIdx} returned ${subResult.answer.length}ch (completed=${spawnStats.completed}/${spawnStats.dispatched})`,
    );
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
      __graphBridge: createGraphBridge(process.cwd()),
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
  // Log context-size growth at the ROOT level so we can see whether
  // decomposition is actually keeping the root small. If root history
  // grows linearly with iterations, the model isn't delegating.
  if (ctx.subRLMDepth === 0) {
    const chars = ctx.history.reduce((s, m) => s + m.content.length, 0);
    debug(
      "tree",
      `ROOT iter=${ctx.iteration} history=${ctx.history.length}msg/${chars}ch handles=${ctx.handleStore.size}`,
    );
  }
  // Compact history if it has grown too large. This may trigger an
  // extra LLM call to produce a summary, but saves tokens on subsequent
  // iterations and keeps the active handle references visible.
  let workingHistory = ctx.history;
  if (
    shouldCompact(workingHistory, {
      maxMessages: COMPACT_MAX_MESSAGES,
      maxChars: COMPACT_MAX_CHARS,
    })
  ) {
    debug(
      "rlm",
      `compacting history (${workingHistory.length}msg, ${workingHistory.reduce((s, m) => s + m.content.length, 0)}ch)`,
    );
    const compactStart = Date.now();
    workingHistory = await compactHistory(workingHistory, ctx.llmClient, {
      maxMessages: COMPACT_MAX_MESSAGES,
      maxChars: COMPACT_MAX_CHARS,
      keepRecent: COMPACT_KEEP_RECENT,
      signal: ctx.signal,
    });
    debug(
      "rlm",
      `compacted in ${Date.now() - compactStart}ms → ${workingHistory.length}msg`,
    );
  }

  const totalHistoryChars = workingHistory.reduce(
    (s, m) => s + m.content.length,
    0,
  );
  debug(
    "rlm",
    `generate iter=${ctx.iteration} history=${workingHistory.length}msg/${totalHistoryChars}ch`,
  );
  const chatStart = Date.now();
  const response = await ctx.llmClient.chat(
    workingHistory,
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  const chatMs = Date.now() - chatStart;
  const llmOutput = response.content;
  debug(
    "rlm",
    `generate completed in ${chatMs}ms, response ${llmOutput.length}ch`,
  );

  const extraction = extractCode(llmOutput);
  debug(
    "rlm",
    `extraction: code=${extraction.code ? extraction.code.length + "ch" : "none"} final=${!!extraction.finalAnswer} finalVar=${extraction.finalVar ?? "none"}`,
  );

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

  debug("rlm", `execute iter=${ctx.iteration} code=${ctx.lastCode.length}ch`);
  const startMs = Date.now();
  const result = await ctx.sandbox.execute(ctx.lastCode, ctx.sandboxTimeoutMs);
  const durationMs = Date.now() - startMs;
  debug(
    "rlm",
    `execute completed in ${durationMs}ms, logs=${result.logs.length}, error=${result.error ?? "none"}`,
  );

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

  // Track repeated-error streaks — same error message twice in a row
  // means the model's self-correction is failing. We bail after N.
  const isRepeat = error !== null && error === ctx.lastError;
  const repeatedErrorCount = isRepeat ? ctx.repeatedErrorCount + 1 : 0;
  if (isRepeat) {
    debug("rlm", `repeated error (${repeatedErrorCount}): ${error?.slice(0, 80)}`);
  }

  return {
    ...ctx,
    history,
    trace,
    lastError: error,
    lastCode: null,
    repeatedErrorCount,
  };
}

async function checkFinalHandler(ctx: RLMContext): Promise<RLMContext> {
  if (ctx.finalAnswer) return ctx;

  const nextIteration = ctx.iteration + 1;

  // Abort signal from outside (e.g. client disconnected) → terminate loop
  if (ctx.signal?.aborted) {
    debug("rlm", "loop aborted by signal");
    return {
      ...ctx,
      iteration: nextIteration,
      finalAnswer: "Request aborted.",
    };
  }

  // Decomposition nudge: only fires on real stagnation, not just iter
  // count. Conditions:
  //   - at root (sub-RLMs don't nudge)
  //   - haven't already nudged
  //   - no sub-RLMs dispatched yet
  //   - 5+ iterations done
  //   - root context has genuinely grown past a threshold (> 20KB)
  //     — this is what distinguishes "model solving efficiently in 3
  //     iterations" from "model struggling and accumulating work"
  const rootChars = ctx.history.reduce((s, m) => s + m.content.length, 0);
  if (
    ctx.subRLMDepth === 0 &&
    !ctx.decompositionNudged &&
    ctx.spawnStats.dispatched === 0 &&
    nextIteration >= 5 &&
    rootChars > 20_000
  ) {
    debug(
      "tree",
      `ROOT has iterated ${nextIteration} times without delegating and history is ${rootChars}ch — injecting decomposition directive`,
    );
    const history = [
      ...ctx.history,
      {
        role: "user" as const,
        content: [
          "STOP. You have iterated 5 times at the root without delegating any work.",
          "The RLM pattern requires DECOMPOSITION. Do the following on your next turn:",
          "",
          "1. Identify the remaining sub-questions needed to answer the task.",
          "2. Dispatch them all in ONE call to `batch_llm_query(subTasks)`.",
          "3. When the results return, aggregate them and provide FINAL(answer).",
          "",
          "Do NOT write more analysis code directly at the root. Each sub-query",
          "should be atomic (e.g. \"Compute graph impact for function X in files Y\").",
          "Write only the minimal orchestration code to build the sub-task list",
          "and combine the results.",
        ].join("\n"),
      },
    ];
    return {
      ...ctx,
      history,
      iteration: nextIteration,
      decompositionNudged: true,
    };
  }

  // Stuck in a loop — same error repeating. Force final with error context.
  if (ctx.repeatedErrorCount >= MAX_REPEATED_ERRORS) {
    debug(
      "rlm",
      `forcing final after ${ctx.repeatedErrorCount} repeated errors`,
    );
    const history = [
      ...ctx.history,
      {
        role: "user" as const,
        content: `The same error has occurred ${ctx.repeatedErrorCount + 1} times in a row: ${ctx.lastError}. You are clearly stuck. Provide your FINAL(answer) based on what you've learned so far, or admit you cannot solve the task. Do not write more code.`,
      },
    ];
    return { ...ctx, history, iteration: nextIteration, repeatedErrorCount: 0 };
  }

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
  const indent = "  ".repeat(ctx.subRLMDepth);
  debug(
    "rlm",
    `done depth=${ctx.subRLMDepth} iter=${ctx.iteration} answer=${ctx.finalAnswer?.length ?? 0}ch`,
  );
  debug(
    "tree",
    `${indent}└─ RETURN d=${ctx.subRLMDepth} iter=${ctx.iteration} ans=${ctx.finalAnswer?.length ?? 0}ch`,
  );
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
  /** Aborts the entire loop — current generation AND subsequent iterations. */
  signal?: AbortSignal;
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
    signal,
  } = options;

  const initialCtx: RLMContext = {
    prompt,
    systemPrompt: "",
    maxIterations,
    llmClient,
    sandboxTimeoutMs,
    maxSubRLMDepth,
    subRLMDepth,
    signal,
    sandbox: null,
    handleStore: createHandleStore(),
    history: [],
    iteration: 0,
    finalAnswer: null,
    lastCode: null,
    lastLLMOutput: null,
    lastError: null,
    noCodeCount: 0,
    repeatedErrorCount: 0,
    spawnStats: { dispatched: 0, completed: 0 },
    decompositionNudged: false,
    trace: [],
  };

  const spec = buildRLMSpec();
  const engine = new FSMEngine<RLMContext>();

  const finalCtx = await engine.run(spec, initialCtx, {
    onTransition: (from, to) => {
      debug("rlm", `transition: ${from} → ${to}`);
      options.onIteration?.(initialCtx.iteration, `${from} → ${to}`);
    },
  });

  return {
    answer: finalCtx.finalAnswer ?? "No answer produced.",
    iterations: finalCtx.iteration,
    trace: finalCtx.trace,
  };
}
