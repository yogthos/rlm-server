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

registerInfoHandler("callers", (_req, ctx) => {
  const callers = ctx.graph
    .listFunctions()
    .filter((f) => f.spec?.dependencies?.includes(ctx.fnName))
    .map((f) => f.name);
  if (callers.length === 0) return `No function lists "${ctx.fnName}" in spec.dependencies.`;
  return `Functions that depend on ${ctx.fnName}: ${callers.join(", ")}`;
});

registerInfoHandler("related", (_req, ctx) => {
  const me = ctx.graph.listFunctions().find((f) => f.name === ctx.fnName);
  if (!me) return `Function ${ctx.fnName} not found.`;
  const callees = me.spec?.dependencies ?? [];
  const callers = ctx.graph
    .listFunctions()
    .filter((f) => f.spec?.dependencies?.includes(ctx.fnName))
    .map((f) => f.name);
  return [
    `${ctx.fnName}:`,
    `  calls: ${callees.length === 0 ? "(none)" : callees.join(", ")}`,
    `  called by: ${callers.length === 0 ? "(none)" : callers.join(", ")}`,
    `  decomposition children: ${me.children.length === 0 ? "(none)" : me.children.join(", ")}`,
  ].join("\n");
});

registerInfoHandler("task", (_req, ctx) => {
  return ctx.task ?? "Top-level task not available in context.";
});

registerInfoHandler("help", () => {
  return `Available request kinds:\n${listInfoHandlers()
    .filter((k) => k !== "help")
    .map((k) => `  - ${k}`)
    .join("\n")}\n\nUsage: put one request per line inside a \`\`\`request-info fence. Arguments use colon syntax, e.g. "sibling:foo" or "spec:bar".`;
});
