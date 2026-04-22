/**
 * Model-facing request-info channel.
 *
 * The Implementer can emit a ```request-info fence in its response
 * when it needs more context than the default feedback provides:
 *
 *   ```request-info
 *   stack-trace
 *   sibling:parseFormData
 *   spec:validateEntry
 *   ```
 *
 * The dispatcher detects the fence BEFORE extracting body/tests,
 * resolves each request against the graph + last test state, and
 * re-prompts with the answers appended. No attempt is consumed (to
 * encourage the model to ask) but total rounds per attempt are
 * bounded so a confused model can't loop forever.
 *
 * Adding a new request kind: call `registerInfoHandler(kind, fn)`
 * at module load. Handlers receive `InfoContext` and return a
 * formatted string for inclusion in the prompt.
 */

import type { DesignGraph } from "./design-graph.js";
import type { TestSpec } from "./design-graph.js";

export interface InfoRequest {
  /** Leading token of the request line, e.g. "stack-trace" or "sibling". */
  kind: string;
  /** Everything after the first colon (if any). */
  args: string;
  /** The original line text, for error messages. */
  raw: string;
}

export interface InfoContext {
  graph: DesignGraph;
  /** Module + name of the function the Implementer is dispatching. */
  module: string;
  fnName: string;
  /** Full text of the most recent test run's output (digest + stderr). */
  lastTestOutput?: string;
  /** Map of test name → full failureMessages[0] (stack trace included).
   *  Populated only when a prior test run ran and had failures. */
  lastFailureMessages?: Map<string, string>;
  /** Top-level user task text, if known. Useful for "task" requests. */
  task?: string;
}

export type InfoHandler = (
  req: InfoRequest,
  ctx: InfoContext,
) => Promise<string> | string;

const registry = new Map<string, InfoHandler>();

export function registerInfoHandler(kind: string, handler: InfoHandler): void {
  registry.set(kind, handler);
}

export function listInfoHandlers(): string[] {
  return [...registry.keys()].sort();
}

export function extractRequestInfo(response: string): InfoRequest[] | null {
  // Match ALL request-info fences (not just the first). Models
  // occasionally scatter requests across separate fences with
  // narration in between; silently dropping the tail fences would
  // confuse the model when its second question got no answer.
  const re = /```request-info\s*\r?\n([\s\S]*?)```/g;
  const requests: InfoRequest[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    for (const rawLine of m[1].split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf(":");
      const kind = idx === -1 ? line : line.slice(0, idx);
      const args = idx === -1 ? "" : line.slice(idx + 1);
      requests.push({ kind: kind.trim(), args: args.trim(), raw: line });
    }
  }
  return requests.length > 0 ? requests : null;
}

export async function resolveRequests(
  reqs: readonly InfoRequest[],
  ctx: InfoContext,
): Promise<string> {
  const sections: string[] = [];
  for (const req of reqs) {
    const handler = registry.get(req.kind);
    if (!handler) {
      sections.push(
        `### [${req.raw}]\nUnknown request kind "${req.kind}". Available: ${listInfoHandlers().join(", ")}`,
      );
      continue;
    }
    try {
      const out = await handler(req, ctx);
      sections.push(`### ${req.raw}\n${out}`);
    } catch (e) {
      sections.push(
        `### [${req.raw}]\nHandler threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return sections.join("\n\n");
}

// ─── Built-in handlers ──────────────────────────────────────────────

function renderTests(tests: readonly TestSpec[]): string {
  if (tests.length === 0) return "  (none)";
  return tests
    .map((t) => `  - ${t.name}\n    ${t.code.split("\n").join("\n    ")}`)
    .join("\n");
}

registerInfoHandler("stack-trace", (_req, ctx) => {
  const msgs = ctx.lastFailureMessages;
  if (!msgs || msgs.size === 0) {
    return "No prior test run with failures on record.";
  }
  const lines: string[] = [];
  for (const [name, full] of msgs) {
    lines.push(`--- ${name} ---`);
    lines.push(full.slice(0, 2000));
  }
  return cap(lines.join("\n"), "stack traces");
});

/** Cap on bytes emitted by a single handler, so a huge function body
 *  or test set can't single-handedly blow the Implementer's prompt
 *  budget. Truncated with a visible marker. */
const MAX_HANDLER_CHARS = 4000;

function cap(text: string, tag: string): string {
  if (text.length <= MAX_HANDLER_CHARS) return text;
  return (
    text.slice(0, MAX_HANDLER_CHARS) +
    `\n[... truncated, ${text.length - MAX_HANDLER_CHARS} more chars of ${tag} ...]`
  );
}

registerInfoHandler("sibling", (req, ctx) => {
  const name = req.args;
  if (!name) return "Usage: sibling:<function-name>";
  const fn = ctx.graph.listFunctions().find((f) => f.name === name);
  if (!fn) return `No function named "${name}" in the graph.`;
  const lines: string[] = [];
  lines.push(`Function: ${fn.name}`);
  lines.push(
    `Signature: (${fn.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${fn.signature.returnType}`,
  );
  if (fn.spec) {
    lines.push(`Purpose: ${fn.spec.purpose}`);
  }
  if (fn.implementation) {
    lines.push("Body:", "```", fn.implementation, "```");
  } else {
    lines.push("Body: (not yet implemented)");
  }
  if (fn.tests.length > 0) {
    lines.push("Unit tests:", renderTests(fn.tests));
  }
  return cap(lines.join("\n"), `sibling ${name}`);
});

registerInfoHandler("spec", (req, ctx) => {
  const name = req.args || ctx.fnName;
  const fn = ctx.graph.listFunctions().find((f) => f.name === name);
  if (!fn) return `No function named "${name}" in the graph.`;
  if (!fn.spec) return `Function "${name}" has no spec attached.`;
  const s = fn.spec;
  return [
    `Purpose: ${s.purpose}`,
    `Inputs:`,
    ...s.inputs.map((i) => `  - ${i.name}: ${i.type} — ${i.description}`),
    `Output: ${s.output.type} — ${s.output.description}`,
    `Side effects: ${s.sideEffects.length === 0 ? "(none)" : s.sideEffects.join("; ")}`,
    `Dependencies: ${s.dependencies.length === 0 ? "(none)" : s.dependencies.join(", ")}`,
    `Edge cases:`,
    ...s.edgeCases.map((e) => `  - ${e}`),
    `Examples:`,
    ...s.examples.map((e) => `  - in: ${e.input} -> out: ${e.output}`),
  ].join("\n");
});

/** Phase N6 — graph-backed "who calls me?" lookup.
 *  Prefers analyzer-observed edges (analyzedCallees); falls back to
 *  architect-declared deps for functions that haven't been dispatched
 *  yet. `callers:<target>` scopes to any function; plain `callers`
 *  uses the current dispatch target. */
registerInfoHandler("callers", (req, ctx) => {
  const target = req.args || ctx.fnName;
  const all = ctx.graph.listFunctions();
  const callers = all
    .filter((f) =>
      f.analyzedCallees.includes(target) ||
      (f.analyzedCallees.length === 0 &&
        f.spec?.dependencies?.includes(target)),
    )
    .map((f) => f.name);
  if (callers.length === 0) return `No function lists "${target}" as a callee.`;
  return `Functions that call ${target}: ${callers.join(", ")}`;
});

/** Phase N6 — "what does this function call?" lookup. */
registerInfoHandler("callees", (req, ctx) => {
  const target = req.args || ctx.fnName;
  const fn = ctx.graph.listFunctions().find((f) => f.name === target);
  if (!fn) return `No function named "${target}" in the graph.`;
  const callees =
    fn.analyzedCallees.length > 0
      ? fn.analyzedCallees
      : (fn.spec?.dependencies ?? []);
  if (callees.length === 0) return `${target} calls no known siblings.`;
  return `${target} calls: ${callees.join(", ")}`;
});

registerInfoHandler("related", (_req, ctx) => {
  const me = ctx.graph.listFunctions().find((f) => f.name === ctx.fnName);
  if (!me) return `Function ${ctx.fnName} not found.`;
  const callees =
    me.analyzedCallees.length > 0
      ? me.analyzedCallees
      : (me.spec?.dependencies ?? []);
  const callers = ctx.graph
    .listFunctions()
    .filter(
      (f) =>
        f.analyzedCallees.includes(ctx.fnName) ||
        (f.analyzedCallees.length === 0 &&
          f.spec?.dependencies?.includes(ctx.fnName)),
    )
    .map((f) => f.name);
  return [
    `${ctx.fnName}:`,
    `  calls: ${callees.length === 0 ? "(none)" : callees.join(", ")}`,
    `  called by: ${callers.length === 0 ? "(none)" : callers.join(", ")}`,
    `  decomposition children: ${me.children.length === 0 ? "(none)" : me.children.join(", ")}`,
  ].join("\n");
});

/** Phase N6 — dump the analyzer-observed import list for a function. */
registerInfoHandler("imports", (req, ctx) => {
  const target = req.args || ctx.fnName;
  const fn = ctx.graph.listFunctions().find((f) => f.name === target);
  if (!fn) return `No function named "${target}" in the graph.`;
  if (fn.analyzedImports.length === 0) {
    return `${target} has no observed imports yet (body not analyzed, or no imports).`;
  }
  const lines = fn.analyzedImports.map((i) =>
    `  line ${i.line}: ${i.isDefault ? "default" : "named"} "${i.name}" from "${i.source}"`,
  );
  return [`${target} imports:`, ...lines].join("\n");
});

/** Phase N6 — just the declared signature, for quick lookup. */
registerInfoHandler("signature", (req, ctx) => {
  const target = req.args || ctx.fnName;
  const fn = ctx.graph.listFunctions().find((f) => f.name === target);
  if (!fn) return `No function named "${target}" in the graph.`;
  const async = fn.signature.isAsync ? "async " : "";
  const params = fn.signature.params
    .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
    .join(", ");
  return `${async}function ${target}(${params}): ${fn.signature.returnType}`;
});

/** Phase N6 — just the stored body, no prose. Useful when the
 *  implementer wants to re-read a sibling concisely. */
registerInfoHandler("body", (req, ctx) => {
  const target = req.args || ctx.fnName;
  const fn = ctx.graph.listFunctions().find((f) => f.name === target);
  if (!fn) return `No function named "${target}" in the graph.`;
  if (!fn.implementation) return `${target} is not implemented yet.`;
  return cap(fn.implementation, `body ${target}`);
});

/** Phase N6 — compact ±1-hop neighborhood around the current function.
 *  Lists direct callers (inverted analyzed edges) and direct callees
 *  (this function's own analyzed edges). Unrelated functions are
 *  omitted to keep the response focused. */
registerInfoHandler("graph", (_req, ctx) => {
  const me = ctx.graph.listFunctions().find((f) => f.name === ctx.fnName);
  if (!me) return `Function ${ctx.fnName} not found.`;
  const callees =
    me.analyzedCallees.length > 0
      ? me.analyzedCallees
      : (me.spec?.dependencies ?? []);
  const callers = ctx.graph
    .listFunctions()
    .filter(
      (f) =>
        f.analyzedCallees.includes(ctx.fnName) ||
        (f.analyzedCallees.length === 0 &&
          f.spec?.dependencies?.includes(ctx.fnName)),
    )
    .map((f) => f.name);
  const lines = [
    `Graph neighborhood (±1 hop from ${ctx.fnName}):`,
    `  callers: ${callers.length === 0 ? "(none)" : callers.join(", ")}`,
    `  callees: ${callees.length === 0 ? "(none)" : callees.join(", ")}`,
  ];
  if (me.children.length > 0) {
    lines.push(`  children: ${me.children.join(", ")}`);
  }
  if (me.parent) lines.push(`  parent:   ${me.parent}`);
  return lines.join("\n");
});

registerInfoHandler("task", (_req, ctx) => {
  return ctx.task ?? "Top-level task not available in context.";
});

// ─── Phase E: model-owned asset access ──────────────────────────────

/** Read any asset by project-relative path. Covers `package.json`,
 *  `tsconfig.json`, and anything else stored via `setAsset`. Also
 *  accepts pseudo-paths the harness materializes on-demand:
 *    - `<fn>.ts`                 → source file
 *    - `<fn>.test.ts`            → unit test file
 *    - `<fn>.integration.test.ts`→ integration test file
 *    - `project.integration.test.ts`
 *    - `ctx.ts` / `ctx_fns.d.ts` → scaffolding
 *  The model can inspect any file it will eventually write. */
registerInfoHandler("file", (req, ctx) => {
  const path = req.args;
  if (!path) return "Usage: file:<project-relative-path>";
  // First preference: explicit asset (package.json / tsconfig / …).
  const asset = ctx.graph.getAsset(path);
  if (asset !== null) return cap(asset, `file ${path}`);
  // Fall through: materialize to resolve on-demand files (function
  // source, test files, ctx scaffolding, project integration test).
  let files: Record<string, string>;
  try {
    files = ctx.graph.materialize();
  } catch (e) {
    return `materialize failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const hit = files[path];
  if (typeof hit === "string") return cap(hit, `file ${path}`);
  const keys = [...Object.keys(files), ...Object.keys(ctx.graph.listAssets())]
    .sort();
  return `No file "${path}". Available:\n  - ${keys.join("\n  - ")}`;
});

/** List every file path the harness will write (assets + generated). */
registerInfoHandler("files", (_req, ctx) => {
  const set = new Set<string>();
  for (const k of Object.keys(ctx.graph.listAssets())) set.add(k);
  try {
    for (const k of Object.keys(ctx.graph.materialize())) set.add(k);
  } catch {
    /* empty graph — still list assets */
  }
  if (set.size === 0) return "(no assets yet)";
  return [...set].sort().map((k) => `  - ${k}`).join("\n");
});

/** Echo the current ProjectDecisions block — lets the model read back
 *  the stack it committed to. Distinct from the prompt's decisions
 *  block: the model asks for this if it's been instructed to revise. */
registerInfoHandler("decisions", (_req, ctx) => {
  const cfg = ctx.graph.getProjectConfig();
  if (!cfg) return "No projectConfig set.";
  const lines = [
    `runtime:         ${cfg.runtime}`,
    `moduleSystem:    ${cfg.moduleSystem}`,
    `testFramework:   ${cfg.testFramework}`,
    `testCommand:     ${cfg.testCommand}`,
    ...(cfg.singleTestCommand
      ? [`singleTestCommand: ${cfg.singleTestCommand}`]
      : []),
    `testImports:     ${cfg.testImports}`,
  ];
  if (cfg.packageManager) lines.push(`packageManager:  ${cfg.packageManager}`);
  if (cfg.mockingStrategy) lines.push(`mockingStrategy: ${cfg.mockingStrategy}`);
  if (cfg.testingNotes) lines.push(`testingNotes:\n${cfg.testingNotes}`);
  return cap(lines.join("\n"), "decisions");
});

registerInfoHandler("help", () => {
  return `Available request kinds:\n${listInfoHandlers()
    .filter((k) => k !== "help")
    .map((k) => `  - ${k}`)
    .join("\n")}\n\nUsage: put one request per line inside a \`\`\`request-info fence. Arguments use colon syntax, e.g. "sibling:foo" or "spec:bar".`;
});
