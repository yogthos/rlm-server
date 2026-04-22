/**
 * Reflect step — called on stagnation instead of jumping straight to
 * decompose. The LLM diagnoses the failure and chooses:
 *
 *   - retry:         fresh attempt with a new hypothesis (e.g. "the
 *                    body misread the input shape — here's the actual
 *                    shape"). Attempt counter resets; hint is surfaced
 *                    to the implementer's next prompt as external
 *                    feedback.
 *   - rewrite-tests: the body may be right; the test suite encodes a
 *                    contract stricter than the spec. Implementer
 *                    rewrites tests on next attempt.
 *   - decompose:     split into children (existing path).
 *   - give-up:       spec is impossible / something further upstream
 *                    is broken — mark blocked, stop burning cycles.
 *
 * Fail-open: unparseable response → give-up, on the principle that
 * reflect burning cycles is worse than calling it early.
 *
 * Decomposition under reflect is opt-in, not automatic. Run 9's
 * pathology was "stagnation → automatic 4-child decompose → children
 * stagnate → repeat." Making decompose a deliberate choice (along
 * with retry / rewrite-tests / give-up) collapses the cascade.
 */

import type { DesignGraph } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { renderDecompositionHints } from "./decomposition-rules.js";
import { debug } from "./debug.js";

export type ReflectDecision =
  | { kind: "retry"; rationale: string; hint: string }
  | { kind: "rewrite-tests"; rationale: string; hint: string }
  | { kind: "decompose"; rationale: string }
  | {
      kind: "revise-child";
      childName: string;
      rationale: string;
      hint: string;
    }
  | { kind: "give-up"; rationale: string };

export interface FailureContext {
  testOutput: string;
  attempts: number;
  /** Top-level user task — helps reflect judge intent when a deep-tree
   *  function stagnates. Optional; omit if unknown. */
  task?: string;
}

export type ChatFn = (prompt: string) => Promise<string>;

/**
 * Parse the reflect LLM's decision JSON. Accepts both ```reflect ...```
 * fenced and bare JSON. Returns null on anything malformed.
 */
export function parseReflectDecision(response: string): ReflectDecision | null {
  // Try fenced first (```reflect { ... } ```), fall through to bare.
  const fenced = response.match(/```[a-zA-Z-]*\r?\n([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : response;
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;
  const decision = typeof r.decision === "string" ? r.decision : null;
  const rationale = typeof r.rationale === "string" ? r.rationale : "";
  const hint = typeof r.hint === "string" ? r.hint : "";
  switch (decision) {
    case "retry":
      return { kind: "retry", rationale, hint };
    case "rewrite-tests":
      return { kind: "rewrite-tests", rationale, hint };
    case "decompose":
      return { kind: "decompose", rationale };
    case "revise-child": {
      const childName =
        typeof r.childName === "string" && r.childName.length > 0
          ? r.childName
          : null;
      if (!childName) return null;
      return { kind: "revise-child", childName, rationale, hint };
    }
    case "give-up":
      return { kind: "give-up", rationale };
    default:
      return null;
  }
}

function buildReflectPrompt(
  graph: DesignGraph,
  module: string,
  name: string,
  failureContext: FailureContext,
): string {
  const fn = graph.getFunction(module, name);
  if (!fn) throw new Error(`reflect: function not found: ${module}#${name}`);
  const spec = fn.spec;
  const specBlock = spec
    ? [
        `Spec:`,
        `  purpose: ${spec.purpose}`,
        `  sideEffects: ${spec.sideEffects.join("; ") || "(none)"}`,
        `  edgeCases:`,
        ...spec.edgeCases.map((e) => `    - ${e}`),
      ]
    : [`(no spec attached)`];
  const body = fn.implementation ?? "(no body — dispatch gave up before writing one)";
  // Show test CODE (not just names) so reflect can judge whether the
  // tests themselves encode a wrong contract — which is the whole
  // point of the `rewrite-tests` decision. Cap per-test and total to
  // keep the prompt bounded on functions with lots of tests.
  const MAX_TESTS_SHOWN = 6;
  const MAX_TEST_CODE_CHARS = 400;
  const testsBlock =
    fn.tests.length > 0
      ? [
          "",
          `Unit tests currently on the function (showing ${Math.min(fn.tests.length, MAX_TESTS_SHOWN)} of ${fn.tests.length}):`,
          ...fn.tests.slice(0, MAX_TESTS_SHOWN).flatMap((t) => {
            const code = t.code.length > MAX_TEST_CODE_CHARS
              ? t.code.slice(0, MAX_TEST_CODE_CHARS) + "…(truncated)"
              : t.code;
            return [
              `  - ${t.name}:`,
              ...code.split("\n").map((l) => `      ${l}`),
            ];
          }),
        ]
      : [];
  // Callers = functions whose spec.dependencies includes this one.
  // Callees = this function's declared spec.dependencies.
  // Sporulator-inspired: showing BOTH directions with their
  // signatures lets reflect see "what shape do my callers send me?"
  // and "what shape do I expect from my callees?" — often the real
  // source of a mismatch stagnation, more useful than a flat sibling
  // list.
  const allFns = graph.listFunctions();
  const renderFnLine = (f: typeof allFns[number]): string => {
    const params = f.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    const purpose = f.spec?.purpose?.slice(0, 90) ?? "";
    return `  - ${f.name}(${params}): ${f.signature.returnType}${purpose ? ` — ${purpose}` : ""}`;
  };
  const callerNames = allFns
    .filter(
      (f) => f.name !== name && (f.spec?.dependencies ?? []).includes(name),
    );
  const calleeNames = new Set(fn.spec?.dependencies ?? []);
  const callees = allFns.filter(
    (f) => f.name !== name && calleeNames.has(f.name),
  );
  const callersBlock =
    callerNames.length > 0
      ? [
          "",
          `Called BY (what these functions pass into ${name}):`,
          ...callerNames.slice(0, 10).map(renderFnLine),
        ]
      : [];
  const calleesBlock =
    callees.length > 0
      ? [
          "",
          `Calls (what ${name} expects back from these):`,
          ...callees.slice(0, 10).map(renderFnLine),
        ]
      : [];
  // Other siblings — listed tersely, to show full surface without
  // drowning the callers/callees signal.
  const otherSiblings = allFns.filter(
    (f) =>
      f.name !== name &&
      f.spec !== null &&
      !callerNames.some((c) => c.name === f.name) &&
      !calleeNames.has(f.name),
  );
  const siblingsBlock =
    otherSiblings.length > 0
      ? [
          "",
          "Other functions in the project (importable directly):",
          ...otherSiblings
            .slice(0, 20)
            .map((s) => `  - ${s.name}: ${s.spec?.purpose?.slice(0, 80) ?? ""}`),
        ]
      : [];
  const children = graph.listChildren(name);
  const childrenBlock =
    children.length > 0
      ? [
          "",
          `This function's DIRECT CHILDREN (from decomposition):`,
          ...children.map((c) => {
            const params = c.signature.params
              .map((p) => `${p.name}: ${p.type}`)
              .join(", ");
            return `  - ${c.name}(${params}): ${c.signature.returnType} — ${c.description}`;
          }),
        ]
      : [];
  const reviseChildClause =
    children.length > 0
      ? [
          "",
          `  "revise-child" — one of this function's CHILDREN came back`,
          `    with a shape that doesn't let the parent compose. Pick`,
          `    this ONLY when the fix belongs in a specific child, not`,
          `    in the parent. Include "childName" and a "hint" for the`,
          `    child (e.g. "return a Map<string,string>, not an array`,
          `    of tuples"). The child will be un-greened and re-dispatched`,
          `    with your hint; the parent waits and re-runs after.`,
        ]
      : [];
  const taskBlock = failureContext.task
    ? [
        "",
        `Top-level user task (what the whole project is building):`,
        failureContext.task.slice(0, 500),
      ]
    : [];
  return [
    `You are reflecting on a stagnated function. The Implementer ran`,
    `${failureContext.attempts} attempts; the last few had identical`,
    `failing-test sets. Something is wrong, but the automatic "split`,
    `into 4 children" reflex is often the WRONG move — it compounds`,
    `confusion when the real issue is a test, sibling, or hypothesis.`,
    ...taskBlock,
    "",
    `Function: ${name}`,
    ...specBlock,
    "",
    "Current body (what the Implementer settled on before stagnating):",
    "```ts",
    body,
    "```",
    ...testsBlock,
    ...callersBlock,
    ...calleesBlock,
    ...childrenBlock,
    ...siblingsBlock,
    "",
    "Test output (last 2000 chars):",
    "```",
    failureContext.testOutput.slice(-2000),
    "```",
    "",
    "Choose ONE decision:",
    "",
    `  "retry" — you see a NEW hypothesis the implementer hasn't`,
    `    tried. Give a concrete "hint" (e.g. "the input is a Buffer,`,
    `    not a string"; "the sibling returns an array of objects,`,
    `    not a Map"). DO NOT pick this if the hint would just repeat`,
    `    earlier advice — that would re-cause stagnation.`,
    "",
    `  "rewrite-tests" — the tests assert stricter behavior than the`,
    `    spec promises, or they reference nonexistent helpers, or`,
    `    they disagree with the spec. "hint" explains which tests`,
    `    are wrong and why.`,
    "",
    `  "decompose" — the function genuinely coordinates multiple`,
    `    distinct concerns that would each be 15+ lines. DON'T pick`,
    `    this if the function wraps a single Node built-in, is <30`,
    `    lines, or the failure is test/sibling-shaped. If you do`,
    `    pick decompose, the same rules apply to any children:`,
    ...renderDecompositionHints().map((l) => `    ${l}`),
    ...reviseChildClause,
    "",
    `  "give-up" — the spec demands behavior impossible with the`,
    `    available siblings, or the stagnation is downstream of a`,
    `    bug nothing here can fix. Mark blocked; move on.`,
    "",
    "Reply with EXACTLY one fenced JSON block:",
    "```reflect",
    '{"decision": "retry|rewrite-tests|decompose|revise-child|give-up",',
    ' "rationale": "<1–2 sentences — WHY this decision>",',
    ' "hint": "<concrete advice for retry / rewrite-tests / revise-child;',
    '   omit for decompose / give-up>",',
    ' "childName": "<target child name; REQUIRED for revise-child>"}',
    "```",
  ].join("\n");
}

/**
 * Ask the LLM to choose a recovery action for a stagnated function.
 * Fail-open to give-up on chat errors or unparseable output — we'd
 * rather mark blocked than burn further cycles.
 */
export async function reflectOnStagnation(
  graph: DesignGraph,
  module: string,
  name: string,
  failureContext: FailureContext,
  chat: ChatFn,
): Promise<ReflectDecision> {
  const prompt = buildReflectPrompt(graph, module, name, failureContext);
  let response: string;
  try {
    response = await chat(prompt);
  } catch (e) {
    debug(
      "reflect",
      `chat threw for ${name}: ${e instanceof Error ? e.message : String(e)}; giving up`,
    );
    return { kind: "give-up", rationale: "reflect chat call errored" };
  }
  const decision = parseReflectDecision(response);
  if (!decision) {
    debug("reflect", `unparseable response for ${name}; giving up`);
    return { kind: "give-up", rationale: "reflect response unparseable" };
  }
  debug(
    "reflect",
    `${name} → ${decision.kind}: ${decision.rationale.slice(0, 120)}`,
  );
  return decision;
}
