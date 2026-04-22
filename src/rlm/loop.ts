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
  DESIGN_IMPL,
  TEST_RUN_IMPL,
} from "../builtins/index.js";
import { createDesignBridge } from "./design-bridge.js";
import { createDesignDispatchBridge } from "./design-dispatch.js";
import { runTests } from "./test-runner.js";
import { finalizeProject } from "./finalize.js";
import type { FinalizeOptions } from "./finalize.js";
import { renderFileSet } from "./final-files.js";
import { designBuild } from "./design-build.js";
import { designLoad } from "./design-load.js";
import { designPlan } from "./design-plan.js";
import { designPlanIntegration } from "./design-plan-integration.js";
import { reflectOnStagnation } from "./design-reflect.js";
import { createIntegrationRunner } from "./design-integration-runner.js";

import type { RLMContext, RLMResult, LLMClient, ChatMessage } from "./types.js";
import { createHandleStore } from "./handles.js";
import { extractCode, detectMisplacedDirective } from "./code-extractor.js";
import { runTemplates } from "./response-templates.js";
import { promptMetadata, stdoutMetadata, guessContentType } from "./metadata.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { RoleBinding } from "./system-prompt.js";
import { z3Solve, Z3_IMPL } from "./z3-bridge.js";
import { prologQuery, PROLOG_IMPL } from "./prolog-bridge.js";
import { createGraphBridge, GRAPH_IMPL } from "./graph-bridge.js";
import { debug } from "./debug.js";
import { compactHistory, shouldCompact } from "./history.js";
import { shouldPlanFirst } from "./routing.js";
import {
  parseSpec,
  renderChecklist,
  markSatisfied,
} from "./spec-checklist.js";
import {
  createLedger,
  appendLedger,
  renderRecent,
} from "./action-ledger.js";
import {
  createFailureMemoryStore,
  renderHints,
} from "./failure-memory.js";
import { createProjectGraph } from "./project-graph.js";
import { createDesignGraph } from "./design-graph.js";
import { Role, selectRole, buildRolePrompt } from "./roles.js";
import type { TaskEnvelope } from "./envelopes.js";
import { detectCodeArtifact } from "./code-artifact.js";
import { validateArtifact } from "./structural-validator.js";
import { buildFixPrompt } from "./fix-prompts.js";
import { feedbackLoop } from "./feedback-loop.js";

/** Max structural-repair cycles before we let a bad FINAL through. */
const MAX_REPAIR_ATTEMPTS = 3;

/**
 * If a sub-RLM's answer contains a code artifact:
 *  - add it to the project graph so later validations see it,
 *  - validate the MERGED project (not just this file) so orphan /
 *    unresolved-call / arity violations surface relative to sibling files,
 *  - append a structured [STRUCTURAL VIOLATIONS] footer to the answer when
 *    validation fails, so the parent Architect can see the verdict.
 *
 * When the artifact has no discoverable path, we fall back to single-file
 * validation (no graph merge) — path-less artifacts can't be placed in
 * the accumulating project without synthetic names.
 */
async function augmentWithStructuralReport(
  answer: string,
  projectGraph: import("./project-graph.js").ProjectGraph,
): Promise<string> {
  const artifact = detectCodeArtifact(answer);
  if (!artifact) return answer;
  const path = artifact.path;

  // Accumulate into the project graph when we know where it goes.
  if (path) {
    await projectGraph.addOrUpdate(path, artifact.content);
  }

  const projectFiles = path ? projectGraph.snapshot() : undefined;
  const report = await validateArtifact({
    artifact: { [path ?? "src/artifact.ts"]: artifact.content },
    projectFiles,
    mode: "fast",
  });
  if (report.ok) return answer;
  const lines = [
    "",
    "[STRUCTURAL VIOLATIONS] sub-RLM returned code that failed validation:",
    ...report.violations.slice(0, 10).map((v) => {
      const loc = v.file ? (v.line ? `${v.file}:${v.line}` : v.file) : "";
      return `  - [${v.layer}] ${loc ? loc + " " : ""}${v.message}`;
    }),
    "If this child returned unusable code, dispatch a replacement or patch it.",
  ];
  return `${answer}\n${lines.join("\n")}`;
}

/** How many recent ledger entries to inject into the next generate prompt. */
const LEDGER_WINDOW = 10;

/**
 * Given a parent agent's roleBinding and the prompt of a child sub-task,
 * build a focused roleBinding for the child. The child sees:
 *   - its own goal (the sub-task prompt, truncated),
 *   - the parent's goal as `parentContext` (narrow upstream cone),
 *   - depth incremented by 1 (maxDepth inherited),
 *   - a role picked by `selectRole` — internal depths get the decide
 *     heuristic (Dispatcher / "Agent" prompt), leaf depth is forced
 *     to the Implementer prompt.
 * Returns `undefined` when the parent isn't role-bound (non-hierarchical
 * run) so sub-spawns inherit the plain path.
 */
function buildChildRoleBinding(
  parent: import("./system-prompt.js").RoleBinding | undefined,
  childPrompt: string,
  childDepth: number,
  forceRole?: Role,
): import("./system-prompt.js").RoleBinding | undefined {
  if (!parent) return undefined;
  const childGoal = childPrompt.slice(0, 800);
  // Try to lift a target module path from the prompt text — Dispatchers
  // typically hand off sub-tasks like "Implement src/db.ts exporting …".
  const pathHint =
    childPrompt.match(/\b(?:src|tests?|lib)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs)\b/)?.[0];
  const envelope: TaskEnvelope = {
    goal: childGoal,
    parentContext: parent.envelope.goal.slice(0, 400),
    tests: { framework: "vitest", files: {} },
    targetModule: pathHint ?? "<agent-child>",
    targetExports: ["<agent-child>"],
    depth: childDepth,
    maxDepth: parent.envelope.maxDepth,
    budgetHint: parent.envelope.budgetHint,
  };
  return { role: forceRole ?? selectRole(envelope), envelope };
}

const MAX_NO_CODE_RETRIES = 3;
/** Characters of content to include in io-category preview logs. */
const IO_PREVIEW_CHARS = 400;

/**
 * Single-line, readable preview of a (possibly multi-line) string for logs.
 * Newlines → `⏎`, runs of whitespace collapsed, truncated with ellipsis.
 */
function preview(s: string | null | undefined, limit = IO_PREVIEW_CHARS): string {
  if (!s) return "(empty)";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit) + `…(+${flat.length - limit}ch)`;
}
/** If the same error appears this many times in a row, force final answer. */
const MAX_REPEATED_ERRORS = 3;
/** Total no-code responses across the loop before we give up. */
const MAX_TOTAL_NO_CODE = 6;
/** Identical response prefixes in a row before we give up. */
const MAX_REPEATED_RESPONSES = 2;
/** Prefix length used for "same response" detection (chars). */
const RESPONSE_FINGERPRINT_LEN = 200;

/** Compaction thresholds. When history exceeds either, we summarize.
 *  If the model is decomposing properly, top-level context should stay
 *  small regardless of total work — compaction is a safety net, not
 *  the primary bound. Looser thresholds reduce compaction overhead and
 *  let the model keep more rich context per turn. */
const COMPACT_MAX_MESSAGES = 20;
const COMPACT_MAX_CHARS = 48_000;
/** Always keep the last N messages verbatim even when compacting. */
const COMPACT_KEEP_RECENT = 6;

/** Max depth of recursive DECOMPOSE calls before we refuse further
 *  sub-planning. Above this, ask the Implementer to implement or fail
 *  rather than endlessly splitting. Override via RLM_MAX_DECOMPOSE_DEPTH
 *  env var when a task's complexity genuinely needs a deeper call tree. */
const MAX_DECOMPOSE_DEPTH = (() => {
  const raw = process.env.RLM_MAX_DECOMPOSE_DEPTH;
  if (!raw) return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

function buildChat(ctx: RLMContext) {
  return async (prompt: string): Promise<string> => {
    const resp = await ctx.llmClient.chat(
      [{ role: "user", content: prompt }],
      ctx.signal ? { signal: ctx.signal } : undefined,
    );
    return resp.content;
  };
}

function parentDepth(graph: RLMContext["designGraph"], parentName: string): number {
  let depth = 0;
  let cursor: string | null = parentName;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const fn = graph.listFunctions().find((f) => f.name === cursor);
    if (!fn || fn.parent === null) break;
    cursor = fn.parent;
    depth++;
  }
  return depth;
}

function buildBridgeHelpers(ctx: RLMContext) {
  const chat = buildChat(ctx);
  const decompose = async (
    g: RLMContext["designGraph"],
    parentName: string,
  ): Promise<boolean> => {
    // Depth guard: refuse to recurse past MAX_DECOMPOSE_DEPTH.
    const depth = parentDepth(g, parentName);
    if (depth >= MAX_DECOMPOSE_DEPTH) {
      debug(
        "bridge",
        `decompose refused for ${parentName} — depth ${depth} ≥ ${MAX_DECOMPOSE_DEPTH}`,
      );
      debug(
        "progress",
        `decompose: REFUSED for ${parentName} — max depth reached`,
      );
      return false;
    }

    // Build an ancestor-aware subtask string.
    const parent = g.listFunctions().find((f) => f.name === parentName);
    const ancestors: string[] = [];
    const seenAnc = new Set<string>();
    let cursor = parent?.parent ?? null;
    while (cursor && !seenAnc.has(cursor)) {
      seenAnc.add(cursor);
      const up = g.listFunctions().find((f) => f.name === cursor);
      if (!up) break;
      ancestors.unshift(`${up.name}: ${up.description}`);
      cursor = up.parent;
    }
    const subtask = parent
      ? [
          `Decompose function \`${parent.name}\`: ${parent.description}`,
          "",
          `Top-level application goal:`,
          ctx.prompt.slice(0, 400),
          "",
          ancestors.length > 0
            ? `Ancestor chain (root → direct parent):\n${ancestors.map((a, i) => `  ${"  ".repeat(i)}${i + 1}. ${a}`).join("\n")}`
            : `This function is a top-level root.`,
        ].join("\n")
      : ctx.prompt;

    const subDispatch = (
      gg: RLMContext["designGraph"],
      mod: string,
      nm: string,
      pd?: string,
    ) =>
      createDesignDispatchBridge(gg, chat, {
        projectDir: pd,
        decompose,
        maxReviewCycles: ctx.maxReviewCycles,
      }).dispatch(mod, nm);
    const subFinalize = (
      gg: RLMContext["designGraph"],
      opts?: FinalizeOptions,
    ) => finalizeProject(gg, opts ?? {});

    const result = await designPlan(g, subtask, {
      chat,
      parent: parentName,
      dispatch: subDispatch,
      finalize: subFinalize,
    });
    // Propagate the plan's outcome. `ok: false` (phase "plan") means
    // the LLM couldn't produce a valid children list or tests — the
    // caller will mark the parent failed loud rather than leave it in
    // a half-planned limbo.
    return result.ok;
  };

  const dispatch = (
    graph: RLMContext["designGraph"],
    module: string,
    name: string,
    projectDir?: string,
  ) =>
    createDesignDispatchBridge(graph, chat, {
      projectDir,
      decompose,
      maxReviewCycles: ctx.maxReviewCycles,
    }).dispatch(module, name);
  const reflect = async (
    graph: RLMContext["designGraph"],
    module: string,
    name: string,
    failureContext: { testOutput: string; attempts: number },
  ) =>
    reflectOnStagnation(
      graph,
      module,
      name,
      { ...failureContext, task: ctx.prompt },
      chat,
    );
  const finalize = (
    graph: RLMContext["designGraph"],
    options?: FinalizeOptions,
  ) => finalizeProject(graph, options ?? {});
  return { chat, dispatch, finalize, decompose, reflect };
}

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
  const llmQueryBridge = async (
    prompt: string,
    spawnOptions?: { forceRole?: Role },
  ): Promise<string> => {
    spawnStats.dispatched++;
    const myIdx = spawnStats.dispatched;
    const indent = "  ".repeat(ctx.subRLMDepth + 1);
    debug(
      "tree",
      `${indent}→ dispatched #${myIdx} from d=${ctx.subRLMDepth} (total dispatched=${spawnStats.dispatched}, returned=${spawnStats.completed})`,
    );

    debug("io", `${indent}sub-prompt #${myIdx} d=${ctx.subRLMDepth}: ${preview(prompt)}`);

    if (ctx.subRLMDepth >= ctx.maxSubRLMDepth) {
      // At max depth we can't recurse, so drive repair via a feedbackLoop
      // directly around the single-shot chat: when the response is a code
      // artifact that fails structural validation, issue graduated fix
      // prompts in the same conversation until the model produces clean
      // code or the retry budget exhausts.
      //
      // System prompt: Implementer role, synthesized from the parent's
      // envelope so the leaf knows it's producing CODE and must not try
      // to decompose further. Without this the leaf would see "answer
      // concisely" and have no role discipline.
      const leafDepth = ctx.subRLMDepth + 1;
      const parentMax = ctx.roleBinding?.envelope.maxDepth ?? ctx.maxSubRLMDepth;
      const leafEnvelope: TaskEnvelope = {
        goal: prompt.slice(0, 800),
        parentContext: ctx.roleBinding?.envelope.goal.slice(0, 400) ?? "(root sub-task)",
        tests: { framework: "vitest", files: {} },
        targetModule:
          prompt.match(/\b(?:src|tests?|lib)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs)\b/)?.[0]
          ?? "<leaf>",
        targetExports: ["<leaf>"],
        depth: Math.max(leafDepth, parentMax),
        maxDepth: parentMax,
        budgetHint: "minutes",
      };
      const leafSystem = buildRolePrompt(Role.Implementer, leafEnvelope);
      debug("tree", `${indent}  (single-shot at max depth, with repair)`);
      const messages: ChatMessage[] = [
        { role: "system", content: leafSystem },
      ];
      let lastArtifact: { content: string; path?: string } | null = null;
      let lastViolations: Array<{ layer: string; message: string; file?: string; line?: number }> = [];

      // Snapshot the project graph BEFORE the repair loop so every attempt
      // validates this child against the same sibling set. Without this,
      // arity / unresolved-call mismatches against siblings are invisible
      // until the outer augmentWithStructuralReport runs.
      const projectFilesAtDispatch = ctx.projectGraph.snapshot();

      const sendPrompt = async (p: string): Promise<string> => {
        messages.push({ role: "user", content: p });
        const resp = await ctx.llmClient.chat(
          messages,
          ctx.signal ? { signal: ctx.signal } : undefined,
        );
        messages.push({ role: "assistant", content: resp.content });
        return resp.content;
      };

      const loopResult = await feedbackLoop({
        initialPrompt: prompt,
        sendPrompt,
        validate: async (raw: string) => {
          const art = detectCodeArtifact(raw);
          lastArtifact = art;
          if (!art) return { ok: true as const, value: raw };
          const path = art.path ?? "src/artifact.ts";
          const report = await validateArtifact({
            artifact: { [path]: art.content },
            projectFiles: projectFilesAtDispatch,
            mode: "fast",
          });
          lastViolations = report.violations;
          if (report.ok) return { ok: true as const, value: raw };
          return {
            ok: false as const,
            error: report.violations
              .map((v) => `[${v.layer}] ${v.message}`)
              .join("\n  - "),
          };
        },
        buildFixPrompt: (attempt) =>
          buildFixPrompt({
            attempt,
            maxAttempts: 3,
            targetModule: lastArtifact?.path ?? "src/artifact.ts",
            targetExports: [],
            currentCode: lastArtifact?.content ?? "",
            errors: lastViolations,
            spec: prompt,
          }),
        maxAttempts: 3,
        onAttempt: (info) => {
          debug(
            "tree",
            `${indent}  sub-RLM repair attempt ${info.attempt}/3 ok=${info.ok}${info.error ? ` err=${info.error.slice(0, 60)}` : ""}`,
          );
        },
      });

      spawnStats.completed++;
      const output = loopResult.status === "ok" ? loopResult.result : loopResult.lastValue;
      debug(
        "tree",
        `${indent}← #${myIdx} returned ${output.length}ch in ${loopResult.attempts} attempt(s) (completed=${spawnStats.completed}/${spawnStats.dispatched})`,
      );
      debug("io", `${indent}sub-reply #${myIdx}: ${preview(output)}`);
      // On success the artifact already passed fast validation inside the
      // loop, but we still thread it through the project graph so later
      // children can see it as part of the accumulating set.
      if (loopResult.status === "ok") {
        const art = detectCodeArtifact(output);
        if (art?.path) await ctx.projectGraph.addOrUpdate(art.path, art.content);
        return output;
      }
      return await augmentWithStructuralReport(output, ctx.projectGraph);
    }

    // Spawn a nested RLM loop. Pass the parent's signal through so
    // when the parent (or the request itself) is aborted, all in-flight
    // sub-RLMs see it and bail out — preventing orphan work after the
    // root response has been delivered.
    //
    // When the parent has an active roleBinding (hierarchical mode),
    // build a focused child roleBinding with depth+1 so the child sees
    // the right role prompt — Dispatcher/Agent at internal depths,
    // Implementer at the leaf. Without this, every child would re-run
    // Architect-level decomposition and the tree multiplies work.
    const childRoleBinding = buildChildRoleBinding(
      ctx.roleBinding,
      prompt,
      ctx.subRLMDepth + 1,
      spawnOptions?.forceRole,
    );
    const subResult = await runRLMLoop({
      prompt,
      llmClient: ctx.llmClient,
      maxIterations: Math.max(3, Math.floor(ctx.maxIterations / 2)),
      sandboxTimeoutMs: ctx.sandboxTimeoutMs,
      maxSubRLMDepth: ctx.maxSubRLMDepth,
      subRLMDepth: ctx.subRLMDepth + 1,
      signal: ctx.signal,
      roleBinding: childRoleBinding,
      // Share the project graph so the child's own structural repair
      // loop sees siblings that have already been added — arity /
      // unresolved-call mismatches against sibling files surface in the
      // child's validator instead of only after bubble-up.
      projectGraph: ctx.projectGraph,
      // Share failure memory so a pattern a sub-RLM hit (e.g. repeated
      // `require is not defined` from trying to run its code) surfaces
      // to the root as well.
      failureMemory: ctx.failureMemory,
      // Share the DesignGraph so Architect's design is visible to every
      // child Implementer, and each child's setImplementation flows
      // back to the shared state the root Architect assembles from.
      designGraph: ctx.designGraph,
    });
    spawnStats.completed++;
    debug(
      "tree",
      `${indent}← #${myIdx} returned ${subResult.answer.length}ch (completed=${spawnStats.completed}/${spawnStats.dispatched})`,
    );
    debug("io", `${indent}sub-reply #${myIdx}: ${preview(subResult.answer)}`);
    return await augmentWithStructuralReport(subResult.answer, ctx.projectGraph);
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
      DESIGN_IMPL,
      TEST_RUN_IMPL,
    ],
    globals: {
      __llmQueryBridge: llmQueryBridge,
      __z3Bridge: z3Solve,
      __prologBridge: prologQuery,
      __graphBridge: createGraphBridge(process.cwd()),
      __designBridge: createDesignBridge(ctx.designGraph),
      __designDispatchBridge: (module: string, name: string) => {
        // Host-driven Implementer loop: the chat primitive is a bare
        // single-turn call (no recursion, no sub-sandbox). The harness
        // extracts the body, runs tests, and saves on green. The LLM
        // can't skip test_run or call design_implement at the wrong
        // time — those are done mechanically.
        debug("bridge", `design_dispatch called directly: ${module}#${name}`);
        const chat = async (prompt: string): Promise<string> => {
          const resp = await ctx.llmClient.chat(
            [{ role: "user", content: prompt }],
            ctx.signal ? { signal: ctx.signal } : undefined,
          );
          return resp.content;
        };
        return createDesignDispatchBridge(ctx.designGraph, chat).dispatch(
          module,
          name,
        );
      },
      __testRunBridge: (module: string, name: string, body: string) =>
        runTests(ctx.designGraph, { module, name, body }),
      __designFinalizeBridge: (options?: FinalizeOptions) =>
        finalizeProject(ctx.designGraph, options ?? {}),
      __designLoadBridge: (modulePath: string) => {
        debug("bridge", `design_load: ${modulePath}`);
        return designLoad(ctx.designGraph, modulePath);
      },
      __designPlanBridge: (task: string) => {
        debug("bridge", `design_plan invoked task=${task.slice(0, 60)}...`);
        const { decompose, reflect, finalize } = buildBridgeHelpers(ctx);
        const chat = buildChat(ctx);
        // Pass 2 (leaf-up) and Pass 3 (integration fix) are pure-TDD:
        // Implementer writes body + tests, runs them, iterates.
        // Architect is NOT involved per-function for CODE review, but
        // is allowed for STRUCTURAL recovery — when the Implementer
        // stagnates (can't converge), leaf-up calls the architect via
        // `decompose` to split the function into smaller children,
        // then retries once the children land green.
        const leafDispatch = (
          g: RLMContext["designGraph"],
          module: string,
          name: string,
          opts?: { projectDir?: string; feedback?: string },
        ) =>
          createDesignDispatchBridge(g, chat, {
            projectDir: opts?.projectDir,
            maxReviewCycles: 0,
          }).dispatch(module, name, {
            externalFeedback: opts?.feedback,
            task,
          });
        return designPlanIntegration(ctx.designGraph, task, {
          chat,
          leafDispatch,
          fixDispatch: leafDispatch,
          decompose,
          reflect,
          integrationRunner: createIntegrationRunner(),
          finalize,
        });
      },
      __designBuildBridge: () => {
        debug("bridge", `design_build invoked`);
        const { dispatch, finalize } = buildBridgeHelpers(ctx);
        return designBuild(ctx.designGraph, { dispatch, finalize });
      },
    },
    timeoutMs: ctx.sandboxTimeoutMs,
    maxVariables: 200,
  });

  const lines = ctx.prompt.split("\n");
  const systemPrompt = buildSystemPrompt(
    {
      contextLength: ctx.prompt.length,
      contextLineCount: lines.length,
      contextPreview: ctx.prompt.slice(0, 200),
      contextType: guessContentType(ctx.prompt),
    },
    ctx.roleBinding,
  );

  const meta = promptMetadata(ctx.prompt);

  // For tasks that look like they should decompose (multi-item, code
  // analysis, ranking, etc.), inject a planning directive in the
  // initial user message. This is the Plan-Then-Execute pattern from
  // ReWOO — front-load the decomposition decision so the model never
  // gets a chance to silently iterate at the root.
  //
  // Skip when a roleBinding is present: the hierarchical Architect/Dispatcher
  // prompts already instruct the model to plan + decompose, and stacking the
  // ReWOO template on top produces conflicting instructions.
  const requiresPlan =
    ctx.subRLMDepth === 0 && !ctx.roleBinding && shouldPlanFirst(ctx.prompt);
  let userContent = meta;
  if (requiresPlan) {
    debug("tree", "task requires planning — injecting plan-first directive");
    userContent = [
      meta,
      "",
      "PLAN PHASE — your FIRST response must be a skeleton plan only:",
      "  // 1. <3-5 word step>",
      "  // 2. <3-5 word step>",
      "  // 3. <3-5 word step>",
      "",
      "Then in the SAME code block, dispatch the steps via batch_llm_query:",
      "  const tasks = [\"<expanded prompt for step 1>\", ...];",
      "  const results = await batch_llm_query(tasks);",
      "  console.log(JSON.stringify(results));",
      "",
      "Each sub-task must be self-contained (it runs in a fresh sandbox).",
      "Do NOT try to solve this task directly at the root level.",
    ].join("\n");
  }

  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  // Parse enumerated requirements from the user prompt once. The checklist
  // re-enters context on every environment-feedback message so the model
  // cannot silently drop items as the original spec ages out of its window.
  const specItems = ctx.subRLMDepth === 0 ? parseSpec(ctx.prompt) : [];
  if (specItems.length > 0) {
    debug("tree", `parsed ${specItems.length} spec items from prompt`);
  }

  return {
    ...ctx,
    sandbox,
    handleStore,
    systemPrompt,
    history,
    iteration: 0,
    requiresPlan,
    specItems,
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
  debug("io", `LLM said: ${preview(llmOutput)}`);

  const extraction = extractCode(llmOutput);
  debug(
    "rlm",
    `extraction: code=${extraction.code ? extraction.code.length + "ch" : "none"} final=${!!extraction.finalAnswer} finalVar=${extraction.finalVar ?? "none"}`,
  );
  if (extraction.code) {
    debug("io", `code: ${preview(extraction.code)}`);
  }
  if (extraction.finalAnswer) {
    debug("io", `FINAL: ${preview(extraction.finalAnswer)}`);
  }
  if (extraction.finalVar) {
    debug("io", `FINAL_VAR: ${extraction.finalVar}`);
  }

  // Append assistant message to history
  let history = [...ctx.history, { role: "assistant" as const, content: llmOutput }];

  // Format gate — the model occasionally writes FINAL / FINAL_VAR as a
  // function call inside a ```repl block. Those directives are parsed
  // OUTSIDE code blocks; placing them inside the fence makes the sandbox
  // execute `FINAL_VAR(...)` as code and throw ReferenceError. Intercept
  // once, explain the format, and loop back instead of burning an execute
  // cycle on the broken code.
  const misplaced = detectMisplacedDirective(extraction.code);
  if (
    misplaced &&
    !extraction.finalAnswer &&
    !extraction.finalVar &&
    !ctx.directiveMisplacementNudged
  ) {
    debug("tree", `format-gate: ${misplaced.kind} inside code block — nudging`);
    const nudge = [
      `\`${misplaced.kind}\` is a directive, not a function. Writing it`,
      "inside a ```repl block makes the sandbox try to call it as code",
      "and throws ReferenceError. The directive must appear OUTSIDE any",
      "code fence, on its own line.",
      "",
      "Correct format:",
      "",
      "```repl",
      "const answer = <produce your value here>;",
      "```",
      "",
      `${misplaced.kind}(answer)`,
      "",
      "Try again: store the value in a repl block, then put the directive",
      "on its own line after the closing fence.",
    ].join("\n");
    history = [...history, { role: "user" as const, content: nudge }];
    debug("io", `format-gate nudge→LLM: ${preview(nudge)}`);
    const ledger = appendLedger(ctx.ledger, {
      iter: ctx.iteration,
      state: "generate",
      summary: `format-gate: ${misplaced.kind} in code block`,
    });
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: null,
      finalAnswer: null,
      lastError: null,
      noCodeCount: 0,
      directiveMisplacementNudged: true,
      ledger,
    };
  }

  // Response-template gate — every turn, check the output against the
  // active per-role format template (architect-dispatch-shape,
  // planner-dispatch-shape, …). Mismatches get an explicit template back
  // as a nudge, so the model sees the expected shape concretely each
  // turn until it matches (capped per template to avoid spam).
  const templateHit = runTemplates(ctx, extraction);
  if (templateHit) {
    debug(
      "tree",
      `format template [${templateHit.template.name}] did not match — nudging`,
    );
    debug("io", `response-template nudge→LLM: ${preview(templateHit.nudge)}`);
    history = [
      ...history,
      { role: "user" as const, content: templateHit.nudge },
    ];
    const ledger = appendLedger(ctx.ledger, {
      iter: ctx.iteration,
      state: "generate",
      summary: `format template [${templateHit.template.name}] fired`,
    });
    const formatNudges = {
      ...ctx.formatNudges,
      [templateHit.template.name]: (ctx.formatNudges[templateHit.template.name] ?? 0) + 1,
    };
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: null,
      finalAnswer: null,
      lastError: null,
      noCodeCount: 0,
      formatNudges,
      ledger,
    };
  }

  // FINAL() gating — for tasks that we determined should be planned/decomposed,
  // reject a premature FINAL() if no sub-RLMs were dispatched. Only one
  // rejection per request to avoid loops.
  const isFinalAttempt = !!(extraction.finalAnswer || extraction.finalVar);
  if (
    ctx.subRLMDepth === 0 &&
    ctx.requiresPlan &&
    isFinalAttempt &&
    ctx.spawnStats.dispatched === 0 &&
    ctx.premateFinalRejections < 1
  ) {
    debug("tree", "rejecting premature FINAL — task requires decomposition but none happened");
    history = [
      ...history,
      {
        role: "user" as const,
        content: [
          "REJECTED. Your final answer is not acceptable because you did not",
          "decompose this task. The task requires sub-question delegation via",
          "batch_llm_query — see the planning instructions in the original prompt.",
          "",
          "Restart: write ONLY a code block that (1) builds a list of sub-task",
          "prompts (one per item to analyze) and (2) calls",
          "  const results = await batch_llm_query(tasks);",
          "  console.log(JSON.stringify(results));",
          "",
          "Do not write FINAL() until batch_llm_query results are available.",
        ].join("\n"),
      },
    ];
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: null,
      finalAnswer: null,
      lastError: null,
      noCodeCount: 0,
      premateFinalRejections: ctx.premateFinalRejections + 1,
    };
  }

  // Architect dispatch gate — if the root is running under an Architect
  // roleBinding, FINAL is only acceptable once at least one sub-RLM has
  // been dispatched (via llm_query / batch_llm_query). Reject once to
  // nudge the model out of "accumulate-in-variables" behavior.
  if (
    ctx.subRLMDepth === 0 &&
    ctx.roleBinding?.role === Role.Architect &&
    isFinalAttempt &&
    ctx.spawnStats.dispatched === 0 &&
    ctx.architectDispatchRejections < 1
  ) {
    debug("tree", "rejecting Architect FINAL — zero dispatches");
    const nudge = [
      "REJECTED. You are the ARCHITECT and must dispatch children before",
      "finalizing — your dispatch count is 0.",
      "",
      "Stop writing implementation code yourself. Build a `subtasks` list per",
      "the template in your system prompt and call `batch_llm_query(...)`",
      "with the sub-task prompts. Only FINAL once children have returned.",
    ].join("\n");
    history = [...history, { role: "user" as const, content: nudge }];
    debug("io", `architect-dispatch-gate nudge→LLM: ${preview(nudge)}`);
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: null,
      finalAnswer: null,
      lastError: null,
      noCodeCount: 0,
      architectDispatchRejections: ctx.architectDispatchRejections + 1,
    };
  }

  // FINAL-as-identifier gate: the model commonly confuses FINAL(x) with
  // FINAL_VAR(x). When finalAnswer is a bare identifier AND a handle by
  // that name exists in the store, they almost certainly meant FINAL_VAR.
  // Reject once with an explicit nudge. One rejection cap — if the
  // repeat shows the same shape, we accept (maybe the literal was
  // intentional).
  if (
    isFinalAttempt &&
    extraction.finalAnswer &&
    !extraction.code &&
    ctx.finalLiteralRejections < 1
  ) {
    const candidate = extraction.finalAnswer.trim();
    if (/^[a-zA-Z_$][\w$]*$/.test(candidate)) {
      const resolves =
        ctx.handleStore.resolve(`$${candidate}`) !== undefined ||
        ctx.handleStore.resolve(candidate) !== undefined;
      if (resolves) {
        debug(
          "tree",
          `rejecting FINAL(${candidate}) — looks like a FINAL_VAR confusion (handle exists)`,
        );
        const nudge = [
          `You wrote \`FINAL(${candidate})\` but \`${candidate}\` is a variable`,
          "you stored earlier, not the literal text you want to return.",
          "",
          "  FINAL(x)       → returns the exact string \"x\"",
          "  FINAL_VAR(x)   → resolves the variable x and returns its value",
          "",
          `Did you mean \`FINAL_VAR(${candidate})\`? If yes, re-emit with`,
          "that directive. If you really did want the literal string,",
          "quote it explicitly — e.g. FINAL(\"the answer\").",
        ].join("\n");
        history = [...history, { role: "user" as const, content: nudge }];
        debug("io", `final-literal nudge→LLM: ${preview(nudge)}`);
        return {
          ...ctx,
          history,
          lastLLMOutput: llmOutput,
          lastCode: null,
          finalAnswer: null,
          lastError: null,
          noCodeCount: 0,
          finalLiteralRejections: ctx.finalLiteralRejections + 1,
        };
      }
    }
  }

  // Structural repair loop — if the FINAL attempt carries a code artifact,
  // run it through the parse + structural (+ typecheck at full) validator
  // before accepting. Blocking violations get fed back via graduated fix
  // prompts (standard → narrowed → fresh) until `MAX_REPAIR_ATTEMPTS`
  // iterations pass clean. Automatic and mechanical — no model opt-in.
  if (ctx.subRLMDepth === 0 && isFinalAttempt) {
    // Prefer the FINAL body as the artifact. Only fall back to scanning
    // the full response when there is no prose FINAL to validate (empty
    // finalAnswer or FINAL_VAR referencing code elsewhere) — otherwise a
    // sketch code block paired with a prose FINAL would false-trigger the
    // gate on code the model never shipped.
    const artifact =
      detectCodeArtifact(extraction.finalAnswer ?? "") ??
      (!extraction.finalAnswer || extraction.finalVar
        ? detectCodeArtifact(llmOutput)
        : null);
    if (artifact) {
      const path = artifact.path ?? "src/artifact.ts";
      // Validate against the CANDIDATE merge of (existing project + this
      // artifact) but don't commit to the graph yet — committing before
      // validation means a failed attempt pollutes the graph for all
      // subsequent validations and sub-RLM spawns. We commit only on
      // success, after this pass accepts the artifact.
      const pgSnapshot = ctx.projectGraph.snapshot();
      const projectFiles: Record<string, string> = { ...pgSnapshot, [path]: artifact.content };
      const report = await validateArtifact({
        artifact: { [path]: artifact.content },
        projectFiles,
        mode: "full",
      });
      if (!report.ok) {
        if (ctx.repairAttempts < MAX_REPAIR_ATTEMPTS) {
          const nextAttempt = ctx.repairAttempts + 1;
          // Use the envelope's targetExports only when they're meaningful.
          // The root Architect envelope carries a sentinel placeholder
          // (see architect-auto.ts) which would turn into visible noise
          // in the fix prompt's "Required exports" line.
          const envExports = ctx.roleBinding?.envelope.targetExports ?? [];
          const targetExports = envExports.filter(
            (e) => !e.startsWith("<") || !e.endsWith(">"),
          );
          const fixPrompt = buildFixPrompt({
            attempt: nextAttempt,
            maxAttempts: MAX_REPAIR_ATTEMPTS,
            targetModule: path,
            targetExports,
            currentCode: artifact.content,
            errors: report.violations,
            spec: ctx.roleBinding?.envelope.goal,
          });
          debug(
            "tree",
            `structural-repair nudge fired — attempt ${nextAttempt}/${MAX_REPAIR_ATTEMPTS}, ${report.violations.length} violation(s)`,
          );
          debug("io", `structural-repair nudge→LLM: ${preview(fixPrompt)}`);
          history = [...history, { role: "user" as const, content: fixPrompt }];
          const ledger = appendLedger(ctx.ledger, {
            iter: ctx.iteration,
            state: "generate",
            summary: `FINAL rejected — ${report.violations.length} structural violation(s) at attempt ${nextAttempt}/${MAX_REPAIR_ATTEMPTS}`,
          });
          return {
            ...ctx,
            history,
            lastLLMOutput: llmOutput,
            lastCode: null,
            finalAnswer: null,
            lastError: null,
            noCodeCount: 0,
            repairAttempts: nextAttempt,
            ledger,
          };
        }
        // Budget exhausted — accept, but make the failure visible in logs.
        debug(
          "tree",
          `WARNING: accepting FINAL with ${report.violations.length} unresolved structural violation(s) after ${MAX_REPAIR_ATTEMPTS} repair attempts`,
        );
        for (const v of report.violations.slice(0, 5)) {
          debug("tree", `  unresolved: [${v.layer}] ${v.message}`);
        }
        // We still commit on exhaustion so downstream tooling sees the
        // final-but-imperfect file. The WARNING above is the signal.
        await ctx.projectGraph.addOrUpdate(path, artifact.content);
      } else {
        // Validation passed — commit the artifact to the project graph
        // so later spawns and FINALs see it as canonical.
        await ctx.projectGraph.addOrUpdate(path, artifact.content);
      }
    }
  }

  // Catch the common anti-pattern: `FINAL_FILES({...inline object...})`.
  // The directive takes a VARIABLE NAME, not an inline value — surface a
  // focused error message so the next turn stops guessing.
  if (extraction.finalFilesInline && !extraction.finalFiles) {
    debug("rlm", `FINAL_FILES called with inline value — nudging`);
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastError:
        "FINAL_FILES takes a VARIABLE NAME, not an inline object or string. " +
        "Your sandbox code should be `const report = await design_plan(...)` " +
        "followed by `FINAL_FILES(report)` on a later turn once the report is in scope. " +
        "Do not write the implementation inline.",
      lastCode: null,
    };
  }

  // Check for FINAL_FILES — resolve a Record<string, string> from sandbox
  // and render as a labeled multi-file payload. Takes precedence over
  // FINAL_VAR because it's the structurally richer shape.
  if (extraction.finalFiles && !extraction.code) {
    const resolved = ctx.handleStore.resolve(`$${extraction.finalFiles}`)
      ?? ctx.handleStore.resolve(extraction.finalFiles);
    if (resolved !== undefined) {
      try {
        const answer = renderFileSet(resolved);
        return { ...ctx, history, lastLLMOutput: llmOutput, lastCode: null, finalAnswer: answer };
      } catch (e) {
        debug("rlm", `FINAL_FILES rejected: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Fall through — let the sandbox evaluate the variable, then
    // executeHandler will promote whatever it resolves to. We reuse the
    // pendingFinalVar path but remember the files intent.
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: extraction.finalFiles,
      finalAnswer: null,
      pendingFinalVar: true,
      pendingFinalFiles: true,
    };
  }

  // Check for FINAL_VAR — resolve from sandbox
  if (extraction.finalVar && !extraction.code) {
    // Try to resolve the variable from a previous execution
    const resolved = ctx.handleStore.resolve(`$${extraction.finalVar}`)
      ?? ctx.handleStore.resolve(extraction.finalVar);

    if (resolved !== undefined) {
      const answer = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
      return { ...ctx, history, lastLLMOutput: llmOutput, lastCode: null, finalAnswer: answer };
    }

    // Variable not in handles — try resolving via sandbox execution.
    // Mark `pendingFinalVar` so executeHandler promotes the evaluated
    // value directly to `finalAnswer` instead of just storing a handle
    // and running another whole generate turn to re-emit FINAL_VAR.
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: extraction.finalVar,
      finalAnswer: null,
      pendingFinalVar: true,
    };
  }

  // Track repeated near-identical responses (degenerate hallucination loop).
  // Compare the prefix of the model's output to the previous turn's output.
  const fp = llmOutput.slice(0, RESPONSE_FINGERPRINT_LEN);
  const prevFp = (ctx.lastLLMOutput ?? "").slice(0, RESPONSE_FINGERPRINT_LEN);
  const sameAsPrev = fp.length > 0 && fp === prevFp;
  const repeatedResponseCount = sameAsPrev ? ctx.repeatedResponseCount + 1 : 0;
  if (sameAsPrev) {
    debug(
      "rlm",
      `repeated response detected (${repeatedResponseCount + 1}x same prefix ${fp.length}ch)`,
    );
  }

  // Update spec item status ONLY from actually-produced work (code +
  // FINAL body), not reasoning/prose. Otherwise the model saying "I will
  // implement POST /sign" ticks the item done before any code exists.
  const producedArtifact = `${extraction.code ?? ""}\n${extraction.finalAnswer ?? ""}`;
  const specItems = ctx.specItems.length > 0
    ? markSatisfied(ctx.specItems, producedArtifact)
    : ctx.specItems;
  const openItems = specItems.filter((i) => i.status === "open");

  // Gate premature FINALs that leave spec items open. One rejection per
  // request (analogous to premateFinalRejections) — on the second pass we
  // accept whatever the model returns to avoid ping-pong.
  if (
    ctx.subRLMDepth === 0 &&
    isFinalAttempt &&
    openItems.length > 0 &&
    ctx.specRejections < 1
  ) {
    debug(
      "tree",
      `rejecting FINAL — ${openItems.length} spec item(s) still open: ${openItems.map((i) => i.id).join(", ")}`,
    );
    const nudge = [
      renderChecklist(specItems),
      "",
      "Your FINAL answer does not satisfy every requirement. Address the",
      "REMAINING SPEC ITEMS above and return a new FINAL. Do not re-emit",
      "anything the previous answer already had right — just extend/fix it.",
    ].join("\n");
    history = [
      ...history,
      { role: "user" as const, content: nudge },
    ];
    debug("io", `spec-rejection nudge→LLM: ${preview(nudge)}`);
    const ledger = appendLedger(ctx.ledger, {
      iter: ctx.iteration,
      state: "generate",
      summary: `FINAL rejected — ${openItems.length} open spec item(s): ${openItems.map((i) => i.id).join(",")}`,
    });
    return {
      ...ctx,
      history,
      lastLLMOutput: llmOutput,
      lastCode: null,
      finalAnswer: null,
      lastError: null,
      noCodeCount: 0,
      specItems,
      specRejections: ctx.specRejections + 1,
      repeatedResponseCount,
      ledger,
    };
  }

  const ledger = appendLedger(ctx.ledger, {
    iter: ctx.iteration,
    state: "generate",
    summary: [
      `llm→${llmOutput.length}ch`,
      `code=${extraction.code ? "yes" : "no"}`,
      extraction.finalAnswer ? "final=text" : extraction.finalVar ? `final=var(${extraction.finalVar})` : "final=no",
    ].join(" "),
  });

  return {
    ...ctx,
    history,
    lastLLMOutput: llmOutput,
    lastCode: extraction.code,
    finalAnswer: extraction.finalAnswer,
    lastError: null,
    noCodeCount: extraction.code ? 0 : ctx.noCodeCount + 1,
    totalNoCodeCount: extraction.code ? ctx.totalNoCodeCount : ctx.totalNoCodeCount + 1,
    repeatedResponseCount,
    specItems,
    ledger,
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
  if (error) {
    debug("io", `stderr: ${preview(error)}`);
  } else if (stdout) {
    debug("io", `stdout: ${preview(stdout)}`);
  }

  // Store result as handle
  const handle = ctx.handleStore.set(
    result.error ? { error: result.error } : result.result,
    ctx.lastCode,
  );

  // FINAL_VAR fallthrough: generateHandler set `pendingFinalVar` when the
  // model asked for a variable not yet in the handle store. The sandbox
  // just evaluated it; promote the result to `finalAnswer` directly so
  // the loop terminates in the SAME generate cycle rather than looping
  // another iteration just to re-emit FINAL_VAR.
  if (ctx.pendingFinalVar && !error) {
    let answer: string | null = null;
    let shapeError: string | null = null;
    if (ctx.pendingFinalFiles) {
      try {
        answer = renderFileSet(result.result);
        debug(
          "rlm",
          `FINAL_FILES resolved via sandbox fallthrough (${answer.length}ch)`,
        );
      } catch (e) {
        shapeError = e instanceof Error ? e.message : String(e);
        debug(
          "rlm",
          `FINAL_FILES rejected shape (${shapeError}); looping back for repair`,
        );
      }
    } else {
      answer =
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result);
      debug("rlm", `FINAL_VAR resolved via sandbox fallthrough (${answer.length}ch)`);
    }
    if (answer !== null) {
      return {
        ...ctx,
        trace: [
          ...ctx.trace,
          {
            iteration: ctx.iteration,
            code: ctx.lastCode,
            stdout: stdout.slice(0, 500),
            handlesSummary: `${ctx.handleStore.size} handles`,
            durationMs,
          },
        ],
        lastError: null,
        lastCode: null,
        finalAnswer: answer,
        pendingFinalVar: false,
        pendingFinalFiles: false,
      };
    }
    // Shape rejection on FINAL_FILES — surface the error so the next
    // generate turn prompts the model to fix (e.g. `await` the promise,
    // pick a non-empty result). Do NOT silently stringify; that would
    // terminate the run with a bogus answer.
    return {
      ...ctx,
      trace: [
        ...ctx.trace,
        {
          iteration: ctx.iteration,
          code: ctx.lastCode,
          stdout: stdout.slice(0, 500),
          handlesSummary: `${ctx.handleStore.size} handles`,
          durationMs,
        },
      ],
      lastError: `FINAL_FILES shape rejected: ${shapeError}`,
      lastCode: null,
      pendingFinalVar: false,
      pendingFinalFiles: false,
    };
  }

  // Record + look up error against the SHARED failure-memory store. All
  // recursion levels hold the same instance, so a pattern a grandchild
  // observed surfaces here too. On the 2nd+ occurrence of the same
  // error shape, inject a "you've hit this before" hint.
  if (error) {
    ctx.failureMemory.record(error, { hint: error.slice(0, 160) });
  }
  const hints = error ? ctx.failureMemory.findHints(error) : [];

  // Build feedback for the LLM — metadata only, never full results
  const parts: string[] = [];
  if (error) {
    parts.push(`Execution error: ${error}`);
  }
  const hintBlock = renderHints(hints);
  if (hintBlock) {
    parts.push("", hintBlock, "Try a different approach — the same fix has not worked twice in a row.");
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
  // Re-inject the checklist so open items stay visible every turn.
  const checklist = renderChecklist(ctx.specItems);
  if (checklist) {
    parts.push("", checklist);
  }
  // Re-inject a compact ledger window so the model remembers its own
  // recent actions even after history compaction. Append the current
  // execute entry first so it appears in the window this very turn.
  const ledgerWithExecute = appendLedger(ctx.ledger, {
    iter: ctx.iteration,
    state: "execute",
    summary: [
      `code=${ctx.lastCode.length}ch`,
      `dur=${durationMs}ms`,
      `stdout=${stdout.length}ch`,
      error ? `err=${error.slice(0, 60)}` : `handle=${handle.name}`,
    ].join(" "),
  });
  const ledgerBlock = renderRecent(ledgerWithExecute, LEDGER_WINDOW);
  if (ledgerBlock) {
    parts.push("", ledgerBlock);
  }

  const feedback = parts.join("\n");
  debug("io", `feedback→LLM: ${preview(feedback)}`);

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
    ledger: ledgerWithExecute,
    // Always clear pendingFinalVar on exit — the flag was set by the
    // preceding generate's FINAL_VAR fallthrough for THIS execute only,
    // and it shouldn't leak into the next turn.
    pendingFinalVar: false,
    pendingFinalFiles: false,
    // failureMemory is mutated in-place (shared store), no need to
    // overwrite on return — `...ctx` already carries the same reference.
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

  // Degenerate response loop: model is repeating itself verbatim.
  // Force termination using the last LLM output as the answer (best
  // effort — at least the user gets something).
  if (ctx.repeatedResponseCount >= MAX_REPEATED_RESPONSES) {
    debug(
      "rlm",
      `forcing final after ${ctx.repeatedResponseCount + 1} identical responses`,
    );
    return {
      ...ctx,
      iteration: nextIteration,
      finalAnswer: ctx.lastLLMOutput ?? "Model produced no usable answer.",
    };
  }

  // Total no-code accumulation: model has had many chances to write
  // code or FINAL but keeps producing prose. Force termination.
  if (ctx.totalNoCodeCount >= MAX_TOTAL_NO_CODE) {
    debug(
      "rlm",
      `forcing final after ${ctx.totalNoCodeCount} total no-code iterations`,
    );
    return {
      ...ctx,
      iteration: nextIteration,
      finalAnswer: ctx.lastLLMOutput ?? "Model produced no FINAL answer.",
    };
  }

  // Decomposition nudge with TWO triggers:
  //   1. EARLY (struggling): iter ≥ 3 AND (recent error OR repeated errors)
  //      — catches "model is broken" before it cascades into garbage
  //   2. LATE (bloated): iter ≥ 5 AND history > 20KB
  //      — catches "model is making progress but accumulating too much"
  //
  // Both gated by: root level, not already nudged, no sub-RLMs yet.
  const rootChars = ctx.history.reduce((s, m) => s + m.content.length, 0);
  const strugglingEarly =
    nextIteration >= 3 &&
    (ctx.lastError !== null || ctx.repeatedErrorCount > 0);
  const bloatedLate = nextIteration >= 5 && rootChars > 20_000;

  if (
    ctx.subRLMDepth === 0 &&
    !ctx.roleBinding &&
    !ctx.decompositionNudged &&
    ctx.spawnStats.dispatched === 0 &&
    (strugglingEarly || bloatedLate)
  ) {
    const reason = strugglingEarly
      ? `errors at iter ${nextIteration} (lastError=${!!ctx.lastError}, repeated=${ctx.repeatedErrorCount})`
      : `bloated at iter ${nextIteration} (${rootChars}ch)`;
    debug("tree", `ROOT nudge fired — ${reason}`);
    const history = [
      ...ctx.history,
      {
        role: "user" as const,
        content: [
          "STOP. Abandon your current approach — it is not converging.",
          "",
          "You MUST decompose this task. Your next response must follow",
          "this exact pattern, nothing else:",
          "",
          "Step 1 — write a SKELETON plan as JS comments. Each step is",
          "3-5 words. NO prose. NO explanation.",
          "Example skeleton:",
          "  // 1. list all function names",
          "  // 2. compute impact per function",
          "  // 3. rank top 5",
          "",
          "Step 2 — turn each skeleton item into a self-contained sub-task",
          "prompt and dispatch them ALL at once via batch_llm_query.",
          "Each sub-task must be answerable independently with no shared state.",
          "",
          "Step 3 — when batch_llm_query returns, parse the results and",
          "provide FINAL(answer).",
          "",
          "Write a SINGLE code block that does steps 1-2 in one go. Do NOT",
          "write any more direct-analysis code at the root level.",
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
  /** Max Architect-review cycles per dispatched function. 0 disables. */
  maxReviewCycles?: number;
  onIteration?: (iteration: number, state: string) => void;
  /** Aborts the entire loop — current generation AND subsequent iterations. */
  signal?: AbortSignal;
  /** Hierarchical agent mode — role header gets composed into the system prompt. */
  roleBinding?: RoleBinding;
  /**
   * Accumulating project graph shared across the recursion. When set, the
   * child uses the same instance as the parent — artifacts added by
   * siblings become visible to this child's own structural validator
   * during its repair loop. Omit to start fresh (root-only use).
   */
  projectGraph?: import("./project-graph.js").ProjectGraph;
  /**
   * Shared failure-memory store across the recursion. Every level's
   * `record` is visible to every other level, so repeat-failure hints
   * surface even when the pattern crosses parent/child boundaries.
   */
  failureMemory?: import("./failure-memory.js").FailureMemoryStore;
  /**
   * Shared DesignGraph reference across the recursion. Root creates
   * one; children use the same instance so they see the full design
   * state and mutations propagate upward.
   */
  designGraph?: import("./design-graph.js").DesignGraph;
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
    // See config.ts for the rationale behind this default — covers a
    // serialized batch_llm_query fan-out on local inference.
    sandboxTimeoutMs = 600_000,
    maxSubRLMDepth = 3,
    subRLMDepth = 0,
    maxReviewCycles = 3,
    signal: externalSignal,
    roleBinding,
    projectGraph,
    failureMemory,
    designGraph,
  } = options;

  // Internal abort controller that we ALWAYS abort when this loop ends.
  // Sub-RLMs spawned during this loop see this signal via ctx.signal,
  // so any in-flight sub-RLM work — including async work the model
  // started without awaiting (unawaited batch_llm_query) — is cancelled
  // when the parent finishes. The external signal (if provided) chains
  // into this one so client disconnects also propagate.
  const internalController = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) {
      internalController.abort();
    } else {
      externalSignal.addEventListener("abort", () => internalController.abort(), {
        once: true,
      });
    }
  }
  const signal = internalController.signal;

  const initialCtx: RLMContext = {
    prompt,
    systemPrompt: "",
    maxIterations,
    llmClient,
    sandboxTimeoutMs,
    maxSubRLMDepth,
    subRLMDepth,
    maxReviewCycles,
    signal,
    roleBinding,
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
    requiresPlan: false,
    premateFinalRejections: 0,
    specItems: [],
    specRejections: 0,
    architectDispatchRejections: 0,
    repairAttempts: 0,
    directiveMisplacementNudged: false,
    formatNudges: {},
    pendingFinalVar: false,
    pendingFinalFiles: false,
    finalLiteralRejections: 0,
    ledger: createLedger(),
    failureMemory: failureMemory ?? createFailureMemoryStore(),
    projectGraph: projectGraph ?? createProjectGraph(),
    designGraph: designGraph ?? createDesignGraph(),
    totalNoCodeCount: 0,
    repeatedResponseCount: 0,
    trace: [],
  };

  const spec = buildRLMSpec();
  const engine = new FSMEngine<RLMContext>();

  try {
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
  } finally {
    // ALWAYS abort the internal controller. This kills any sub-RLMs
    // the model started but didn't await (unawaited batch_llm_query
    // is the common offender). The signal chain reaches them via
    // ctx.signal → their internal controllers → their chat() calls.
    if (!signal.aborted) {
      debug("rlm", `runRLMLoop done at depth=${subRLMDepth}, aborting internal signal`);
      internalController.abort();
    }
  }
}
