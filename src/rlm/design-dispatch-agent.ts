/**
 * Per-function dispatch as an interactive tool-use loop.
 *
 * Replaces the single-shot "dump 20KB of context, ask for body+tests"
 * prompt pattern with a conversational loop: the model emits ONE tool
 * call per turn, the harness runs it, result becomes history, loop
 * repeats until the model calls `done()`, `give_up()`, or we exhaust
 * the turn budget.
 *
 * Tool surface (P1 scaffolding — backends land in P2):
 *   - get_spec(), get_decisions(), list_siblings(), get_sibling(name),
 *     get_callers(), get_callees()           — graph-derived context
 *   - read_file(path), list_files()           — project assets
 *   - write_body(content), patch_body(search, replace)        — edits
 *   - write_test_file(content), patch_test_file(search, replace)
 *   - typecheck(), run_tests()                — execution
 *   - done(), give_up(reason)                 — control
 *
 * Tool call protocol: the model emits a ```tool-call fenced JSON
 * object `{"name": "<tool>", "args"?: {...}}`. The harness parses the
 * FIRST fence (one tool per turn), runs it, and injects the result
 * into the next prompt as conversation history. A response with no
 * fence counts as a wasted turn and decrements the budget; after
 * exhaustion the dispatch returns `status: stagnated` so the outer
 * reflect/decompose path can take over.
 *
 * Turn budget: default 15, overridable via `RLM_AGENT_TURN_BUDGET`
 * env var and the per-call `turnBudget` option.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult, ChatFn } from "./dispatch-types.js";
import type { TestRunResult, CandidateBody } from "./test-runner.js";
import { debug } from "./debug.js";

/** Injection points for the exec tools. The legacy test-runner is the
 *  production backend; tests pass stubs to keep the tool suite fast
 *  and deterministic. */
export type AgentTestFn = (
  graph: DesignGraph,
  candidate: CandidateBody,
) => Promise<TestRunResult>;
export type AgentTypecheckFn = (
  graph: DesignGraph,
  candidate: CandidateBody,
) => Promise<{ ran: boolean; ok: boolean; diagnostics: string }>;

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** When the ```tool-call fence contained JSON we couldn't parse,
   *  this carries the error message. The caller surfaces it back to
   *  the model as a tool result so it can try again with valid JSON
   *  instead of silently burning a turn. */
  parseError?: string;
}

export interface AgentRunOptions {
  chat: ChatFn;
  /** Max turns before the harness bails. Defaults to
   *  `RLM_AGENT_TURN_BUDGET` env var, else 15. */
  turnBudget?: number;
  /** External failure context (e.g., integration-loop feedback) primed
   *  into the opening user message like the legacy dispatcher. */
  externalFeedback?: string;
  /** Top-level user task — surfaced in the system prompt so the model
   *  can reconnect single-function work to the overall goal. */
  task?: string;
  /** Production path runs the real test-runner; tests inject a stub. */
  runTests?: AgentTestFn;
  /** Production path runs the real tsc pre-pass; tests inject a stub. */
  runTypecheck?: AgentTypecheckFn;
  /** projectDir is forwarded to the real test-runner so scenarios run
   *  inside the overlay shared with leaf-up-build. Unused when stubs
   *  are injected. */
  projectDir?: string;
}

/** Per-dispatch session state. Held across tool-call turns. */
export interface AgentSession {
  graph: DesignGraph;
  module: string;
  name: string;
  task?: string;
  externalFeedback?: string;
  runTests?: AgentTestFn;
  runTypecheck?: AgentTypecheckFn;
  projectDir?: string;
}

export function createAgentSession(
  graph: DesignGraph,
  module: string,
  name: string,
  options: {
    task?: string;
    externalFeedback?: string;
    runTests?: AgentTestFn;
    runTypecheck?: AgentTypecheckFn;
    projectDir?: string;
  } = {},
): AgentSession {
  return {
    graph,
    module,
    name,
    task: options.task,
    externalFeedback: options.externalFeedback,
    runTests: options.runTests,
    runTypecheck: options.runTypecheck,
    projectDir: options.projectDir,
  };
}

/** Extract the FIRST `tool-call` fence from a model response and parse
 *  its JSON body. Returns null when no fence exists; returns an object
 *  with `parseError` set when the fence is present but invalid JSON.
 *  Strict name check: the `name` field must be a non-empty string. */
export function parseToolCall(response: string): ToolCall | null {
  const m = response.match(/```tool-call\s*\r?\n([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return {
      name: "__parse_error__",
      args: {},
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { name?: unknown }).name !== "string" ||
    ((parsed as { name: string }).name as string).length === 0
  ) {
    return {
      name: "__parse_error__",
      args: {},
      parseError:
        "tool-call body must be a JSON object with a non-empty `name` string",
    };
  }
  const obj = parsed as { name: string; args?: unknown };
  const args =
    obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : {};
  return { name: obj.name, args };
}

function resolveTurnBudget(opt?: number): number {
  if (typeof opt === "number" && opt > 0) return opt;
  const env = process.env.RLM_AGENT_TURN_BUDGET;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 15;
}

/**
 * Run the interactive dispatch loop for one function. In P1 this is
 * a thin skeleton: it handles the control tools (`done`, `give_up`)
 * and the turn budget, but every other tool name just comes back as
 * a "not yet implemented" tool-result. P2 wires the real backends.
 */
export async function runDispatchAgent(
  graph: DesignGraph,
  module: string,
  name: string,
  options: AgentRunOptions,
): Promise<DispatchResult> {
  const budget = resolveTurnBudget(options.turnBudget);
  const key = `${module}#${name}`;
  let turn = 0;
  // Conversation history is built fresh each turn from the accumulated
  // tool-call + result records; see P3 for the real prompt assembler.
  // For P1 we pass a stub prompt so the chat function can be exercised.
  const history: Array<{ toolCall: ToolCall; result: string }> = [];
  const session: AgentSession = createAgentSession(graph, module, name, {
    task: options.task,
    externalFeedback: options.externalFeedback,
    runTests: options.runTests,
    runTypecheck: options.runTypecheck,
    projectDir: options.projectDir,
  });
  while (turn < budget) {
    turn++;
    const prompt = renderAgentPrompt(session, history);
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      debug(
        "dispatch-agent",
        `${key} chat threw turn ${turn}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        module,
        name,
        status: "failed",
        implementation: null,
        attempts: turn,
        testOutput: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const call = parseToolCall(response);
    if (!call) {
      // No tool call emitted this turn. Treat as a wasted turn and
      // let the budget run down; don't terminate immediately — the
      // model might correct course on the next turn.
      history.push({
        toolCall: { name: "__no_call__", args: {} },
        result:
          "Your previous response contained no ```tool-call fence. Emit exactly one tool call per turn.",
      });
      continue;
    }
    if (call.parseError) {
      history.push({
        toolCall: call,
        result: `Your tool-call JSON was invalid: ${call.parseError}`,
      });
      continue;
    }
    if (call.name === "done") {
      debug("dispatch-agent", `${key} done at turn ${turn}`);
      return {
        module,
        name,
        status: "tests-green",
        implementation: graph.getFunction(module, name)?.implementation ?? null,
        attempts: turn,
        testOutput: "",
      };
    }
    if (call.name === "give_up") {
      const reason =
        typeof call.args.reason === "string"
          ? call.args.reason
          : "model called give_up with no reason";
      debug("dispatch-agent", `${key} give_up at turn ${turn}: ${reason}`);
      return {
        module,
        name,
        status: "stagnated",
        implementation: graph.getFunction(module, name)?.implementation ?? null,
        attempts: turn,
        testOutput: "",
        error: reason,
      };
    }
    // Route through the P2 tool registry. Unknown tools come back with
    // a clear error listing valid names, so the model can correct on
    // the next turn instead of spinning.
    const result = await runTool(session, call.name, call.args);
    history.push({ toolCall: call, result });
  }
  debug(
    "dispatch-agent",
    `${key} turn budget exhausted (${budget})`,
  );
  return {
    module,
    name,
    status: "stagnated",
    implementation: graph.getFunction(module, name)?.implementation ?? null,
    attempts: turn,
    testOutput: "",
    error: `turn budget exhausted (${budget} turns)`,
  };
}

// ─── Tool backends (Phase P2) ───────────────────────────────────────
//
// Each tool maps (session, args) → string result. Return strings that
// read cleanly when injected as "tool result" history into the next
// prompt — compact, deterministic, actionable. Tools never throw to
// the caller: errors become a result string the model can learn from.

function toolGetTask(session: AgentSession): string {
  return session.task ?? "(no task available — project decisions only)";
}

function toolGetSpec(session: AgentSession): string {
  const fn = session.graph.getFunction(session.module, session.name);
  if (!fn) return `[error] function ${session.module}#${session.name} missing from graph`;
  if (!fn.spec) return "[error] spec not attached yet (phase 2 hasn't run)";
  return JSON.stringify(fn.spec, null, 2);
}

function toolGetDecisions(session: AgentSession): string {
  const cfg = session.graph.getProjectConfig();
  if (!cfg) return "[error] no project decisions set (phase 0 hasn't run)";
  // Strip large asset blobs so the model isn't reading package.json
  // via this channel; use read_file for that.
  const { packageJson: _pkg, tsconfig: _tsc, ...rest } = cfg;
  return JSON.stringify(rest, null, 2);
}

function toolListSiblings(session: AgentSession): string {
  const siblings = session.graph
    .listFunctions()
    .filter((f) => f.name !== session.name);
  if (siblings.length === 0) return "(no siblings)";
  return siblings
    .map((f) => `- ${f.name} (${f.module}) — ${f.description || "(no description)"}`)
    .join("\n");
}

function toolGetSibling(session: AgentSession, args: Record<string, unknown>): string {
  const wanted = typeof args.name === "string" ? args.name : "";
  if (!wanted) return "[error] get_sibling requires {name: string}";
  const fn = session.graph
    .listFunctions()
    .find((f) => f.name === wanted && f.name !== session.name);
  if (!fn) return `[error] no function named "${wanted}" in the graph`;
  const parts: string[] = [
    `# Sibling: ${fn.name} (${fn.module})`,
    `description: ${fn.description || "(none)"}`,
    `signature: ${renderSignature(fn.name, fn.signature)}`,
  ];
  if (fn.spec) {
    parts.push(`spec:\n${JSON.stringify(fn.spec, null, 2)}`);
  }
  if (fn.implementation) {
    parts.push(`body:\n${fn.implementation}`);
  } else {
    parts.push("body: (not yet implemented)");
  }
  if (fn.unitTestFile) {
    parts.push(`tests:\n${fn.unitTestFile}`);
  }
  return parts.join("\n\n");
}

function renderSignature(name: string, sig: {
  params: Array<{ name: string; type: string }>;
  returnType: string;
  isAsync?: boolean;
}): string {
  const prefix = sig.isAsync ? "async " : "";
  const params = sig.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  return `${prefix}function ${name}(${params}): ${sig.returnType}`;
}

function toolGetCallers(session: AgentSession, args: Record<string, unknown>): string {
  const target =
    typeof args.name === "string" && args.name.length > 0
      ? args.name
      : session.name;
  const all = session.graph.listFunctions();
  const callers = all.filter((f) => f.analyzedCallees.includes(target));
  if (callers.length === 0) return `(no known callers of ${target})`;
  return callers.map((f) => `- ${f.name}`).join("\n");
}

function toolGetCallees(session: AgentSession, args: Record<string, unknown>): string {
  const target =
    typeof args.name === "string" && args.name.length > 0
      ? args.name
      : session.name;
  const fn = session.graph
    .listFunctions()
    .find((f) => f.name === target);
  if (!fn) return `[error] no function named "${target}"`;
  if (fn.analyzedCallees.length === 0) return `(no callees of ${target})`;
  return fn.analyzedCallees.map((n) => `- ${n}`).join("\n");
}

function toolListFiles(session: AgentSession): string {
  const files = session.graph.materialize();
  return Object.keys(files).sort().join("\n");
}

function toolReadFile(session: AgentSession, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return "[error] read_file requires {path: string}";
  const files = session.graph.materialize();
  const content = files[path];
  if (content === undefined) {
    // Give the model a hint by suggesting nearby names.
    const available = Object.keys(files);
    const similar = available.filter((n) => n.includes(path) || path.includes(n));
    return `[error] "${path}" not found. Available files:\n${available.join("\n")}${
      similar.length > 0 ? `\n\nSimilar names: ${similar.join(", ")}` : ""
    }`;
  }
  return content;
}

function toolWriteBody(session: AgentSession, args: Record<string, unknown>): string {
  const content = typeof args.content === "string" ? args.content : null;
  if (content === null) return "[error] write_body requires {content: string}";
  session.graph.setImplementation(session.module, session.name, content);
  return `ok — wrote body (${content.length} chars)`;
}

function toolWriteTestFile(session: AgentSession, args: Record<string, unknown>): string {
  const content = typeof args.content === "string" ? args.content : null;
  if (content === null) return "[error] write_test_file requires {content: string}";
  session.graph.setUnitTestFile(session.module, session.name, content);
  return `ok — wrote unit test file (${content.length} chars)`;
}

function applyPatch(original: string, search: string, replace: string):
  | { ok: true; next: string }
  | { ok: false; reason: string } {
  if (!search) return { ok: false, reason: "search string is empty" };
  const first = original.indexOf(search);
  if (first === -1) {
    return {
      ok: false,
      reason: "search string not found in current content",
    };
  }
  const second = original.indexOf(search, first + 1);
  if (second !== -1) {
    return {
      ok: false,
      reason:
        "search string appears multiple times — ambiguous, not unique. Narrow it with more surrounding context.",
    };
  }
  return { ok: true, next: original.slice(0, first) + replace + original.slice(first + search.length) };
}

function toolPatchBody(session: AgentSession, args: Record<string, unknown>): string {
  const search = typeof args.search === "string" ? args.search : "";
  const replace = typeof args.replace === "string" ? args.replace : "";
  const fn = session.graph.getFunction(session.module, session.name);
  if (!fn) return `[error] function missing from graph`;
  const current = fn.implementation ?? "";
  const patched = applyPatch(current, search, replace);
  if (!patched.ok) return `[error] patch_body: ${patched.reason}`;
  session.graph.setImplementation(session.module, session.name, patched.next);
  return `ok — applied patch (${patched.next.length} chars)`;
}

function toolPatchTestFile(session: AgentSession, args: Record<string, unknown>): string {
  const search = typeof args.search === "string" ? args.search : "";
  const replace = typeof args.replace === "string" ? args.replace : "";
  const fn = session.graph.getFunction(session.module, session.name);
  if (!fn) return `[error] function missing from graph`;
  const current = fn.unitTestFile ?? "";
  const patched = applyPatch(current, search, replace);
  if (!patched.ok) return `[error] patch_test_file: ${patched.reason}`;
  session.graph.setUnitTestFile(session.module, session.name, patched.next);
  return `ok — applied patch (${patched.next.length} chars)`;
}

async function toolRunTests(session: AgentSession): Promise<string> {
  if (!session.runTests) {
    return "[error] run_tests backend not configured (no test-runner injected)";
  }
  const fn = session.graph.getFunction(session.module, session.name);
  const body = fn?.implementation ?? "";
  const result = await session.runTests(session.graph, {
    module: session.module,
    name: session.name,
    body,
  });
  const lines: string[] = [
    `ok: ${result.ok}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
  ];
  if (result.loadFailure) {
    lines.push("loadFailure: true (compile/import error — no assertions ran)");
  }
  if (result.failingTestNames && result.failingTestNames.length > 0) {
    lines.push(`failing tests (${result.failingTestNames.length}):`);
    for (const n of result.failingTestNames.slice(0, 20)) lines.push(`  - ${n}`);
    if (result.failingTestNames.length > 20) {
      lines.push(`  …(${result.failingTestNames.length - 20} more)`);
    }
  }
  if (result.failingTestNames && result.failingTestNames.length > 0 && result.fullFailureMessages) {
    const first = result.failingTestNames[0];
    const msg = result.fullFailureMessages.get(first);
    if (msg) {
      lines.push("first failure:");
      lines.push(msg.length > 1500 ? msg.slice(0, 1500) + "\n…[truncated]" : msg);
    }
  }
  // Include the runner's own output tail so tool-specific signals the
  // harness doesn't surface explicitly still reach the model.
  if (result.output && result.output.length > 0) {
    lines.push("raw output (tail):");
    lines.push(result.output.slice(-800));
  }
  return lines.join("\n");
}

async function toolTypecheck(session: AgentSession): Promise<string> {
  if (!session.runTypecheck) {
    return "[error] typecheck backend not configured";
  }
  const fn = session.graph.getFunction(session.module, session.name);
  const body = fn?.implementation ?? "";
  const result = await session.runTypecheck(session.graph, {
    module: session.module,
    name: session.name,
    body,
  });
  if (!result.ran) return "typecheck skipped (tsconfig missing or not a TS runtime)";
  if (result.ok) return "ok — typecheck passed";
  return `FAILED — typecheck errors:\n${result.diagnostics}`;
}

/** Dispatch a tool call by name. Control tools (`done`, `give_up`) are
 *  handled directly by the agent loop and never reach here. */
export async function runTool(
  session: AgentSession,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "get_task":       return toolGetTask(session);
    case "get_spec":       return toolGetSpec(session);
    case "get_decisions":  return toolGetDecisions(session);
    case "list_siblings":  return toolListSiblings(session);
    case "get_sibling":    return toolGetSibling(session, args);
    case "get_callers":    return toolGetCallers(session, args);
    case "get_callees":    return toolGetCallees(session, args);
    case "list_files":     return toolListFiles(session);
    case "read_file":      return toolReadFile(session, args);
    case "write_body":     return toolWriteBody(session, args);
    case "write_test_file":return toolWriteTestFile(session, args);
    case "patch_body":     return toolPatchBody(session, args);
    case "patch_test_file":return toolPatchTestFile(session, args);
    case "run_tests":      return await toolRunTests(session);
    case "typecheck":      return await toolTypecheck(session);
    default:
      return `[error] unknown tool "${name}". Valid tools: get_task, get_spec, get_decisions, list_siblings, get_sibling, get_callers, get_callees, list_files, read_file, write_body, write_test_file, patch_body, patch_test_file, typecheck, run_tests, done, give_up.`;
  }
}

/**
 * Assemble the per-turn prompt for the agent. The structure mirrors
 * a tool-use conversation: a small system preamble (task + goal +
 * tool catalog + protocol), followed by the accumulated tool calls
 * and their results.
 *
 * Kept deliberately small — a few KB even with full history. The
 * model's attention goes to the latest tool result, not a wall of
 * advisory blocks.
 */
export function renderAgentPrompt(
  session: AgentSession,
  history: Array<{ toolCall: ToolCall; result: string }>,
): string {
  const fn = session.graph.getFunction(session.module, session.name);
  const sig = fn
    ? renderSignature(fn.name, fn.signature)
    : `${session.name} (signature unavailable)`;
  const cfg = session.graph.getProjectConfig();
  const framework = cfg?.testFramework ?? "(unknown)";
  const lines: string[] = [
    "You are implementing ONE function in a TypeScript project,",
    "working TDD-style. Think of it like a small microservice: there is",
    "one function to write, one test file to prove it works, and a",
    "small set of tools to inspect the codebase and run tests.",
    "",
    `Target function: ${session.module}#${session.name}`,
    `Signature:       ${sig}`,
    `Test framework:  ${framework}`,
  ];
  if (session.task) {
    lines.push(
      "",
      "Overall project task:",
      session.task.length > 500 ? session.task.slice(0, 500) + "…" : session.task,
    );
  }
  if (session.externalFeedback) {
    lines.push(
      "",
      "Upstream failure context (the integration phase or a parent",
      "function surfaced this — address it in your implementation):",
      session.externalFeedback.length > 800
        ? session.externalFeedback.slice(0, 800) + "…"
        : session.externalFeedback,
    );
  }
  lines.push(
    "",
    "Goal: tests for this function must PASS. Tests exercise this",
    "function in isolation. You do NOT need to worry about whether",
    "sibling functions already work — they have their own dispatches",
    "and are tested separately.",
    "",
    "Tool-call protocol — on every turn emit exactly ONE fenced",
    "JSON block of the form:",
    "`" + "``tool-call",
    '{"name": "<tool>", "args": {...optional...}}',
    "`" + "``",
    "The harness runs the tool and returns the result in the next",
    "prompt. Keep each turn to one tool call; prose outside the",
    "fence is ignored.",
    "",
    "Available tools:",
    "",
    "  CONTEXT — read project state",
    "    get_task()           the overall user task",
    "    get_spec()           this function's SPEC (purpose + edge cases)",
    "    get_decisions()      project decisions (framework, imports, etc.)",
    "    list_siblings()      names of other functions in the graph",
    "    get_sibling({name})  spec + body + tests of a sibling",
    "    get_callers({name?}) who calls me (or name)",
    "    get_callees({name?}) what I call",
    "",
    "  FILES",
    "    list_files()              every materialized project file",
    "    read_file({path})         full contents of one file",
    "",
    "  EDITS — scoped to this function's body + test file ONLY",
    "    write_body({content})     replace the body file entirely",
    "    write_test_file({content}) replace the unit test file entirely",
    "    patch_body({search, replace})      search must be unique",
    "    patch_test_file({search, replace}) search must be unique",
    "",
    "  EXEC",
    "    typecheck()  run tsc --noEmit, scoped to this function's files",
    "    run_tests()  run the unit test file for this function",
    "",
    "  CONTROL",
    "    done()                 tests are green — end the session",
    "    give_up({reason})      you can't solve this — end with a reason",
    "",
    "Recommended TDD flow:",
    "  1. `get_spec` (and `get_sibling` for any dep you'll use).",
    "  2. `write_test_file` with tests that encode the spec's edge cases.",
    "  3. `run_tests` — expect failures (body is stub/empty).",
    "  4. `write_body` (or `patch_body`) to make the tests pass.",
    "  5. `run_tests` — on green, call `done`.",
    "  If a test file fails to COMPILE (TS error), `typecheck` will",
    "  surface the exact TSxxxx diagnostic.",
  );
  // Conversation history: most recent turns last, same order they
  // happened. Keep the full rolling window so the model sees what
  // it tried and the harness's responses.
  if (history.length > 0) {
    lines.push("", "─────────────── Conversation so far ───────────────");
    for (let i = 0; i < history.length; i++) {
      const turn = history[i];
      lines.push(
        "",
        `Turn ${i + 1} — tool call:`,
        "```json",
        JSON.stringify(turn.toolCall, null, 2),
        "```",
        "Result:",
        "```",
        turn.result.length > 3000 ? turn.result.slice(0, 3000) + "\n…[truncated]" : turn.result,
        "```",
      );
    }
    lines.push(
      "",
      "─────────────────────────────────────────────────────",
      "Your next tool call:",
    );
  } else {
    lines.push("", "(No tool calls yet — begin with your first tool call.)");
  }
  return lines.join("\n");
}
