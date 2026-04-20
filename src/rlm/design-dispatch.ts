/**
 * Dispatch a child Implementer for a declared function in the DesignGraph.
 *
 * The loop is HOST-DRIVEN: the LLM's only job is to emit a candidate
 * function body inside a fenced code block. The harness extracts it,
 * runs the declared tests mechanically (via runTests), and on red hands
 * the failure output back to the LLM for a revision. On green the
 * harness calls `graph.setImplementation` and returns. The LLM never
 * invokes test_run, design_implement, or any other bridge — so it can't
 * skip the test, mis-arg it, or be confused by sandbox handle shadowing.
 */

import type {
  DesignGraph,
  FunctionStatus,
  TestSpec,
} from "./design-graph.js";
import { buildImplementerPrompt } from "./implementer-prompt.js";
import { runTests, type TestRunResult } from "./test-runner.js";
import { debug } from "./debug.js";
import { analyzeBody, type BodyAnalysis } from "./body-analyzer.js";

/**
 * Reconcile `spec.dependencies` with the body's observed `ctx.fns.<X>`
 * call sites. The LLM's phase-2 guess can drift from reality (phantom
 * deps or missing ones); once we have a body we know the truth. Only
 * call after the body has been accepted (green + approved).
 */
function reconcileSpecDependencies(
  graph: DesignGraph,
  module: string,
  name: string,
  analysis: BodyAnalysis,
): void {
  const fn = graph.getFunction(module, name);
  if (!fn?.spec) {
    debug(
      "dispatch",
      `skip reconcile for ${module}#${name} — no spec attached`,
    );
    return;
  }
  const observed = Array.from(
    new Set(analysis.ctxFnsCalls.map((c) => c.name)),
  ).sort();
  const current = [...fn.spec.dependencies].sort();
  if (
    current.length === observed.length &&
    current.every((v, i) => v === observed[i])
  ) {
    return; // no-op
  }
  graph.setSpec(module, name, { ...fn.spec, dependencies: observed });
  debug(
    "dispatch",
    `reconciled spec.dependencies for ${module}#${name}: [${current.join(", ")}] → [${observed.join(", ")}]`,
  );
}

/**
 * Collect structural violations of a proc-ts body.
 *
 * When `requiredChildren` is non-empty, each child must be REACHABLE
 * from the body's `ctx.fns` call chain — either called directly, or
 * called by a function the body calls (transitively). Previous behaviour
 * demanded a direct call to every child; that rejected valid tree-
 * shaped compositions like `parent → buildPage → [form, list, ...]`
 * where an intermediate child assembles the others.
 *
 * Transitive computation requires `graph` so we can pull each
 * intermediate function's body and analyse its outbound calls. Without
 * `graph`, we fall back to direct-call-only semantics (preserves the
 * old behaviour for fixtures that don't need transitivity).
 */
async function analyzeReachableCalls(
  graph: DesignGraph,
  seedNames: readonly string[],
): Promise<Set<string>> {
  const reachable = new Set<string>();
  const queue = [...seedNames];
  const byName = new Map(
    graph.listFunctions().map((f) => [f.name, f] as const),
  );
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const fn = byName.get(name);
    if (!fn || !fn.implementation) continue;
    try {
      const childAnalysis = await analyzeBody(fn.implementation);
      for (const c of childAnalysis.ctxFnsCalls) {
        if (!reachable.has(c.name)) queue.push(c.name);
      }
    } catch {
      // Parse failures on intermediate bodies aren't fatal here — they
      // surface when that function is dispatched.
    }
  }
  return reachable;
}

async function collectBodyViolations(
  analysis: BodyAnalysis,
  knownNames: Set<string>,
  requiredChildren: readonly string[] = [],
  graph?: DesignGraph,
): Promise<string[]> {
  const violations: string[] = [];
  if (analysis.imports.length > 0) {
    const formatted = analysis.imports
      .map((imp) => `  line ${imp.line}: import from "${imp.source}"`)
      .join("\n");
    violations.push(
      `Top-level \`import\` statements are forbidden in proc-ts bodies:\n${formatted}\nUse dynamic \`require(...)\` or \`await import(...)\` inside the body instead.`,
    );
  }
  const seenUndeclared = new Map<string, number>();
  for (const c of analysis.ctxFnsCalls) {
    if (!knownNames.has(c.name) && !seenUndeclared.has(c.name)) {
      seenUndeclared.set(c.name, c.line);
    }
  }
  if (seenUndeclared.size > 0) {
    const formatted = Array.from(seenUndeclared)
      .map(([n, line]) => `  line ${line}: ctx.fns.${n}`)
      .join("\n");
    const available =
      Array.from(knownNames).sort().join(", ") || "(none)";
    violations.push(
      `Call(s) to ctx.fns.<sibling> for functions NOT in the graph:\n${formatted}\nAvailable ctx.fns: ${available}.`,
    );
  }
  if (requiredChildren.length > 0) {
    const directCalls = analysis.ctxFnsCalls.map((c) => c.name);
    const reachable = graph
      ? await analyzeReachableCalls(graph, directCalls)
      : new Set<string>(directCalls);
    const missing = requiredChildren.filter((c) => !reachable.has(c));
    if (missing.length > 0) {
      const chain = directCalls.length > 0
        ? `Your body directly calls: ${directCalls.join(", ")}. Transitive reach: ${[...reachable].join(", ") || "(none)"}.`
        : `Your body calls no siblings at all.`;
      violations.push(
        `This function was decomposed into children — every child must be REACHABLE from your body's call chain (directly, or transitively through another sibling you call). Unreachable: ${missing.map((m) => `ctx.fns.${m}`).join(", ")}. ${chain}`,
      );
    }
  }
  return violations;
}

export interface DispatchResult {
  module: string;
  name: string;
  /** "stagnated" = the semantic failing-test SET repeated across
   *  attempts, so the Implementer is not making progress. Signals the
   *  orchestrator to decompose (if it has that capability) rather than
   *  spending more attempts. Distinct from "failed" which covers other
   *  error paths (exhaustion without stagnation, chat errors, etc.). */
  status: FunctionStatus | "failed" | "stagnated";
  implementation: string | null;
  attempts: number;
  /** Last test output — present whether we finished green or red. */
  testOutput: string;
  /** When dispatch failed to produce a passing implementation. */
  error?: string;
}

export interface DispatchRunOptions {
  /** External feedback threaded into the Implementer's first prompt.
   *  Used by the integration loop to carry test-failure context
   *  ("this project test red'd because X") so the Implementer can
   *  update body AND unit tests coherently, not just iterate on the
   *  body against its current (possibly wrong) unit tests. */
  externalFeedback?: string;
}

export interface DesignDispatchBridge {
  dispatch(
    module: string,
    name: string,
    opts?: DispatchRunOptions,
  ): Promise<DispatchResult>;
}

export type ChatFn = (prompt: string) => Promise<string>;

/**
 * Wrap a ChatFn with abort-retry: on abort-like errors (HTTP signal
 * fired even though the model might have produced a response), retry
 * the same prompt up to 2 times before giving up. Non-abort errors
 * propagate on first occurrence.
 *
 * Applies uniformly to the Implementer dispatch, architect review,
 * and the IMPLEMENT-vs-DECOMPOSE decision. All three go to the same
 * LLM backend and hit the same transport timeout.
 */
const MAX_ABORT_RETRIES = 2;
export function withAbortRetry(chat: ChatFn): ChatFn {
  return async (prompt: string): Promise<string> => {
    let lastAbort: unknown = null;
    for (let i = 0; i <= MAX_ABORT_RETRIES; i++) {
      try {
        return await chat(prompt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isAbort = /abort|AbortError/i.test(msg);
        if (!isAbort || i === MAX_ABORT_RETRIES) throw e;
        lastAbort = e;
        debug(
          "dispatch",
          `chat aborted — abort-retry ${i + 1}/${MAX_ABORT_RETRIES}`,
        );
      }
    }
    throw lastAbort ?? new Error("unreachable");
  };
}

export type TestFn = (
  graph: DesignGraph,
  candidate: { module: string; name: string; body: string },
  options?: { projectDir?: string },
) => Promise<TestRunResult>;

/** Host-provided callback that plans children for a function and
 *  dispatches them before this function's own body is written.
 *  Called when the Implementer agent chooses to DECOMPOSE rather than
 *  IMPLEMENT directly. The host is expected to call designPlan(graph,
 *  task, { parent: fnName }) and then run the child dispatches.
 *  Returns true on success, false when the sub-plan failed (e.g. the
 *  LLM produced garbage JSON across retries). */
export type DecomposeFn = (
  graph: DesignGraph,
  parentName: string,
) => Promise<boolean>;

export interface DispatchOptions {
  maxAttempts?: number;
  /** Test runner override (tests inject a stub). */
  runTests?: TestFn;
  /** When set, the dispatch reuses this persistent dir for every
   *  `test_run` call so vitest's module cache warms up between attempts. */
  projectDir?: string;
  /** Optional — enables the IMPLEMENT-vs-DECOMPOSE decision. When
   *  absent, every dispatched function goes straight to direct body
   *  generation (legacy behavior). */
  decompose?: DecomposeFn;
  /** Max Architect-review cycles after tests pass. Tests going green
   *  means the Implementer's own contract is satisfied; the Architect
   *  then checks that contract matches the original SPEC. On REVISE,
   *  the Implementer is re-dispatched with the feedback injected.
   *  0 disables review (legacy behavior). Default 3. */
  maxReviewCycles?: number;
}

/** Architect's post-green verdict on an Implementer's work. */
export interface ReviewVerdict {
  approved: boolean;
  /** Actionable feedback when `approved: false`. */
  feedback: string;
  /** Which SPEC field the REVISE maps to (purpose / inputs / ...).
   *  Enforced by the review prompt so critiques are traceable; if the
   *  Architect can't cite a spec field, the concern is likely feature
   *  creep and should have been APPROVE. */
  specField?: string;
}

/**
 * Format review feedback for the Implementer's retry prompt. When the
 * verdict cites a spec field, lead with `[architect cited spec.<field>]`
 * so the Implementer knows exactly which part of the SPEC to revisit.
 */
function formatArchitectFeedback(v: ReviewVerdict): string {
  if (!v.specField) return v.feedback;
  return `[architect cited spec.${v.specField}]\n${v.feedback}`;
}

/** Spec fields a REVISE verdict is allowed to cite. Matches the
 *  `FunctionSpec` shape one-for-one so feedback is traceable. */
const REVIEW_SPEC_FIELDS = [
  "purpose",
  "inputs",
  "output",
  "sideEffects",
  "dependencies",
  "edgeCases",
  "examples",
] as const;

/**
 * Parse the Architect's review response. Expected shape:
 *   ```
 *   APPROVE
 *   ```
 * or
 *   ```
 *   REVISE
 *   <actionable feedback>
 *   ```
 * Fail-open: unparseable → approve (tests already passed; review infra
 * shouldn't block on its own flakiness).
 */
export function parseReviewVerdict(response: string): ReviewVerdict {
  const m = response.match(/```[^\n]*\r?\n([\s\S]*?)```/);
  if (!m) return { approved: true, feedback: "" };
  const body = m[1].trim();
  if (body.length === 0) return { approved: true, feedback: "" };
  // Strip leading markdown and punctuation before matching the verdict
  // keyword. Tolerates: `**REVISE**`, `# APPROVE`, `REVISE:`,
  // `REVISE —`, etc. — the LLM isn't always disciplined.
  const firstLine = body.split(/\r?\n/, 1)[0].trim();
  const keyword = firstLine
    .replace(/^[\s*_#>\-]+/, "")
    .replace(/[\s*_#>\-:.,;!?—]+$/, "")
    .trim()
    .toUpperCase();
  const rest = body.replace(/^[^\n]*\r?\n?/, "").trim();
  if (keyword.startsWith("APPROVE")) return { approved: true, feedback: "" };
  if (keyword.startsWith("REVISE")) {
    // Empty feedback is unactionable — the Implementer has no signal
    // to revise against. Fail open (approve) to avoid burning a cycle
    // on nothing.
    if (rest.length === 0) return { approved: true, feedback: "" };
    // Extract the optional spec-field tag. Expected first-line shapes:
    //   "REVISE"           — no tag (back-compat)
    //   "REVISE purpose"   — tag that matches an allowed spec field
    //   "REVISE quality"   — unrecognized tag; treat as untagged so
    //                        the Implementer doesn't get a misleading
    //                        citation downstream.
    const afterKeyword = firstLine
      .replace(/^[\s*_#>\-]+/, "")
      .replace(/[\s*_#>\-:.,;!?—]+$/, "")
      .trim();
    const parts = afterKeyword.split(/\s+/);
    let specField: string | undefined;
    if (parts.length >= 2) {
      const tagLower = parts[1].toLowerCase();
      // Canonical match is case-insensitive — `Purpose`, `PURPOSE`,
      // `edgecases` all map to the spec-field casing the rest of the
      // system uses.
      const canonical = REVIEW_SPEC_FIELDS.find(
        (f) => f.toLowerCase() === tagLower,
      );
      if (canonical) specField = canonical;
    }
    return { approved: false, feedback: rest, specField };
  }
  return { approved: true, feedback: "" };
}

/**
 * Render the proc-ts signature line used in the Architect review so
 * the reviewer sees `function foo(ctx: Ctx, n: number): string` rather
 * than just the raw body statements. Without this, architects read a
 * body starting with `const x = ...` and mistakenly flag "no ctx
 * parameter" — ctx is supplied by the harness's wrapping signature.
 */
function renderReviewSignature(
  fn: import("./design-graph.js").FunctionNode,
): string {
  const async = fn.signature.isAsync ? "async " : "";
  const userParams = fn.signature.params
    .map((p) => {
      const q = p.optional ? "?" : "";
      const def = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : "";
      return `${p.name}${q}: ${p.type}${def}`;
    })
    .join(", ");
  const paramList =
    userParams.length > 0 ? `ctx: Ctx, ${userParams}` : "ctx: Ctx";
  return `export default ${async}function ${fn.name}(${paramList}): ${fn.signature.returnType}`;
}

function renderSpecForReview(
  spec: import("./design-graph.js").FunctionSpec,
): string {
  const lines: string[] = [];
  lines.push(`Purpose: ${spec.purpose}`);
  if (spec.inputs.length > 0) {
    lines.push("Inputs:");
    for (const i of spec.inputs) {
      lines.push(`  - ${i.name}: ${i.type} — ${i.description}`);
    }
  }
  lines.push(`Output: ${spec.output.type} — ${spec.output.description}`);
  if (spec.sideEffects.length > 0) {
    lines.push("Side effects:");
    for (const s of spec.sideEffects) lines.push(`  - ${s}`);
  }
  if (spec.dependencies.length > 0) {
    lines.push("Declared dependencies:");
    for (const d of spec.dependencies) lines.push(`  - ${d}`);
  }
  if (spec.edgeCases.length > 0) {
    lines.push("Edge cases the spec required covering:");
    for (const e of spec.edgeCases) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

async function architectReview(
  chat: ChatFn,
  fn: import("./design-graph.js").FunctionNode,
  graph: DesignGraph,
  body: string,
  testOutput: string,
  priorCycleFeedback?: string,
): Promise<ReviewVerdict> {
  if (!fn.spec) {
    // No spec to review against — approve by default.
    return { approved: true, feedback: "" };
  }
  const testNames = fn.tests.map((t) => `  - ${t.name}`).join("\n");
  const integrationNames = fn.integrationTests
    .map((t) => `  - ${t.name}`)
    .join("\n");
  // For a branch, list the children's signatures so the Architect can
  // judge whether `ctx.fns.<child>(...)` calls in the body are sensible.
  const childLines: string[] = [];
  if (fn.children.length > 0) {
    childLines.push("", "Children this function assembles:");
    for (const name of fn.children) {
      const cfn = graph.listFunctions().find((f) => f.name === name);
      if (!cfn) continue;
      const params = cfn.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      const sig = `ctx.fns.${cfn.name}(ctx${params ? ", " + params : ""}): ${cfn.signature.returnType}`;
      childLines.push(`  - ${sig} — ${cfn.description}`);
    }
  }
  const sections: string[] = [
    `You are the ARCHITECT reviewing an Implementer's work on \`${fn.name}\`.`,
    "",
    "The SPEC you wrote (the contract the Implementer was supposed to satisfy):",
    renderSpecForReview(fn.spec),
    ...childLines,
    "",
    "The Implementer's full function (signature + body as it will",
    "be emitted — note ctx is the harness-injected first parameter):",
    "```ts",
    `${renderReviewSignature(fn)} {`,
    ...body.split("\n").map((l) => `  ${l}`),
    "}",
    "```",
    "",
    testNames ? `Unit tests that passed:\n${testNames}` : "(no unit tests)",
  ];
  if (integrationNames) {
    sections.push("", `Integration tests:\n${integrationNames}`);
  }
  sections.push(
    "",
    "Test output (last 2000 chars):",
    "```",
    testOutput.slice(-2000),
    "```",
    "",
  );
  // Cycle 2+ — include the prior cycle's feedback so the review can
  // confirm its earlier critique was addressed instead of silently
  // contradicting it with a new one.
  if (priorCycleFeedback) {
    sections.push(
      "YOUR PREVIOUS CYCLE'S FEEDBACK on an earlier version of this body:",
      "```",
      priorCycleFeedback.slice(0, 1500),
      "```",
      "",
      "Either (a) confirm that the Implementer addressed this by",
      "APPROVING, or (b) REVISE again with a concern that is GENUINELY",
      "DIFFERENT from the one above — do NOT contradict your earlier",
      "feedback without explicitly noting why.",
      "",
    );
  }
  const prompt = [
    ...sections,
    "PROC-TS CONVENTIONS (do NOT flag these as bugs — they are required):",
    "- Every function receives `ctx: Ctx` as its FIRST parameter.",
    "- Sibling calls go through `ctx.fns.<name>(ctx, ...args)` — passing",
    "  ctx to each sibling is correct and mandatory.",
    "- No `import` statements at the top of function bodies. Node",
    "  modules come in via dynamic `require(...)` or `await import(...)`.",
    "",
    "ANCHOR YOUR REVIEW TO THE SPEC. Evaluate ONLY what the SPEC asks for:",
    "- Does the body fulfill the stated `purpose`?",
    "- Does it cover every `edgeCase` the spec listed?",
    "- Does it produce the declared `sideEffects` (and no undeclared ones)?",
    "- Does it call each declared `dependency` appropriately?",
    "- Are the unit tests MEANINGFUL — not trivial tautologies like",
    "  `expect(true).toBe(true)` or assertions that just mirror the body?",
    "",
    "DO NOT invent requirements outside the SPEC. If Content-Type",
    "validation, response-already-sent guards, race-condition fixes, or",
    "other hardening wasn't explicitly called out by the spec's purpose,",
    "sideEffects, or edgeCases, do NOT reject over it — APPROVE. The",
    "Architect (you) wrote the spec; hold the implementation to THAT bar,",
    "not to a higher one.",
    "",
    "",
    "Reply with EXACTLY one fenced code block.",
    "",
    "APPROVE when the spec is satisfied:",
    "```",
    "APPROVE",
    "```",
    "",
    "OR REVISE, citing EXACTLY ONE spec field your concern maps to.",
    "Allowed fields: <purpose|inputs|output|sideEffects|dependencies|edgeCases|examples>.",
    "If you CANNOT map your concern to one of those fields, your concern",
    "is outside the spec — you must APPROVE instead.",
    "",
    "```",
    "REVISE <field>",
    "<2–6 sentences of specific, actionable feedback, traceable to the",
    "cited <field>. Be concrete, not vague.>",
    "```",
    "",
    "No prose outside the fenced block.",
  ].join("\n");
  try {
    const response = await chat(prompt);
    return parseReviewVerdict(response);
  } catch (e) {
    debug(
      "dispatch",
      `architect review error for ${fn.name}: ${e instanceof Error ? e.message : String(e)} — approving by default`,
    );
    return { approved: true, feedback: "" };
  }
}

/**
 * Complexity floor: when the spec is clearly a leaf, skip the LLM
 * decompose decision entirely. Saves an LLM turn AND prevents the
 * "count concerns" framing from over-triggering on tight pipelines.
 *
 * A function is "obviously implementable" when ALL of:
 *   - zero dependencies (pure leaf, no orchestration)
 *   - ≤ 5 edge cases (simple enough for a 30-line body)
 *   - ≤ 1 side effect (multiple side effects = multiple concerns)
 *   - purpose ≤ 300 chars (long purpose is a proxy for scope)
 *
 * The `generateHtml` case from real runs (deps=0, edges=4, but
 * purpose=399ch + large resulting body) was what motivated the
 * purpose-length gate — a long purpose signals scope the other
 * counts can miss.
 *
 * INVARIANT: zero dependencies ⇒ no orchestration. The Architect's
 * phase-2 prompt asks for "dependencies: sibling function names this
 * one calls via ctx.fns — empty if pure". If that schema ever
 * changes, revisit this floor.
 */
function obviouslyImplementable(
  spec: import("./design-graph.js").FunctionSpec,
): boolean {
  return (
    spec.dependencies.length === 0 &&
    spec.edgeCases.length <= 5 &&
    spec.sideEffects.length <= 1 &&
    spec.purpose.length <= 300
  );
}

async function askDecompose(
  chat: ChatFn,
  fn: import("./design-graph.js").FunctionNode,
  graph: DesignGraph,
): Promise<boolean> {
  const specLines: string[] = [];
  if (fn.spec) {
    specLines.push(`Purpose: ${fn.spec.purpose}`);
    if (fn.spec.dependencies.length > 0) {
      specLines.push("Dependencies (siblings this function already plans to call):");
      for (const d of fn.spec.dependencies) specLines.push(`  - ${d}`);
    }
    if (fn.spec.sideEffects.length > 0) {
      specLines.push("Side effects:");
      for (const s of fn.spec.sideEffects) specLines.push(`  - ${s}`);
    }
    if (fn.spec.edgeCases.length > 0) {
      specLines.push("Edge cases:");
      for (const e of fn.spec.edgeCases) specLines.push(`  - ${e}`);
    }
  } else {
    specLines.push(`Purpose: ${fn.description}`);
  }
  // Show siblings the LLM can REUSE via ctx.fns — with their purposes,
  // not just names. Reuse is the cheapest way to avoid DECOMPOSE.
  const reuseLines: string[] = [];
  const others = graph
    .listFunctions()
    .filter((f) => f.name !== fn.name);
  if (others.length > 0) {
    reuseLines.push(
      "",
      "Existing functions you can call via `ctx.fns.<name>(ctx, ...)` —",
      "REUSE THESE FIRST if any solves a sub-concern of this function:",
    );
    for (const o of others) {
      const purpose = o.spec?.purpose ?? o.description ?? "";
      const brief = purpose.length > 120 ? purpose.slice(0, 117) + "..." : purpose;
      reuseLines.push(`  - ctx.fns.${o.name}(ctx, ...) — ${brief}`);
    }
  }
  const prompt = [
    `You are deciding how to implement a function. Default to IMPLEMENT.`,
    `DECOMPOSE is EXPENSIVE — it adds another planning round and several`,
    `LLM turns — so only pick it when the function truly cannot fit in`,
    `**~30 lines** of straightforward code even after reusing available`,
    `helpers.`,
    "",
    `Function: ${fn.name}`,
    `Signature: ${fn.signature.isAsync ? "async " : ""}function ${fn.name}(ctx: Ctx${fn.signature.params.length > 0 ? ", " + fn.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ") : ""}): ${fn.signature.returnType}`,
    ...specLines,
    ...reuseLines,
    "",
    `Decision rules (apply in order):`,
    `  1. If the body fits in ~30 lines of straightforward code,`,
    `     **prefer IMPLEMENT**. Tight pipelines (load → transform → send)`,
    `     count as ONE orchestration — do NOT split them.`,
    `  2. If every sub-concern of this function is already covered by a`,
    `     function in the "Existing functions" list above, answer IMPLEMENT`,
    `     and call those via ctx.fns. Do NOT invent new helpers that`,
    `     duplicate existing ones.`,
    `  3. Only answer DECOMPOSE when BOTH of these hold:`,
    `     (a) the function orchestrates ≥ 3 genuinely distinct concerns`,
    `         that CANNOT be covered by existing ctx.fns helpers, AND`,
    `     (b) the resulting body would be well over 30 lines even if you`,
    `         reused everything available.`,
    "",
    `Examples:`,
    `  - \`hashPassword(pw)\` → IMPLEMENT (one transform, few lines).`,
    `  - \`handleGetApiEntries\` that loads entries, serializes, sends →`,
    `    IMPLEMENT. It's a 15-line pipeline; even if it calls three`,
    `    helpers via ctx.fns, that's reuse, not orchestration.`,
    `  - \`renderPage(data)\` that builds an HTML string → IMPLEMENT.`,
    `  - \`handleSignup(req,res)\` where parse/validate/hash/write/reply`,
    `    aren't yet available as ctx.fns helpers AND the body would exceed`,
    `    30 lines → DECOMPOSE.`,
    "",
    `Answer with EXACTLY one word (IMPLEMENT or DECOMPOSE) inside a fenced`,
    `code block. Nothing else.`,
  ].join("\n");
  const response = await chat(prompt);
  const fenced = response.match(/```[^\n]*\n([\s\S]*?)```/);
  const word = (fenced ? fenced[1] : response).trim().toUpperCase();
  return word === "DECOMPOSE";
}

/**
 * Extract a body from a fenced code block. Accepts ```js / ```ts /
 * ```javascript / ```typescript / bare fences, and tolerates a
 * `:filename` suffix some models emit after the language tag
 * (e.g. ```typescript:src/foo.ts). Normalizes CRLF → LF.
 *
 * Skips ```tests / ```unit-tests / ```integration-tests fences
 * (reserved for the Implementer's test blocks). Returns the first
 * CODE fence's contents.
 */
const TEST_FENCE_TAGS = new Set([
  "tests",
  "unit-tests",
  "integration-tests",
]);

export function extractBody(response: string): string | null {
  const re = /```([a-zA-Z][a-zA-Z0-9_-]*(?::[^\s]*)?)?[^\S\n]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const tag = (m[1] ?? "").toLowerCase().split(":")[0];
    if (TEST_FENCE_TAGS.has(tag)) continue;
    return m[2].replace(/\r\n/g, "\n").trim();
  }
  return null;
}

function parseTestJson(raw: string): TestSpec[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: TestSpec[] = [];
    for (const t of parsed) {
      if (!t || typeof t !== "object") return null;
      const entry = t as Record<string, unknown>;
      if (typeof entry.name !== "string") return null;
      if (typeof entry.code !== "string") return null;
      out.push({ name: entry.name, code: entry.code });
    }
    return out;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFencedTests(
  response: string,
  tag: string,
): TestSpec[] | null {
  const re = new RegExp(
    "```" + escapeRegex(tag) + "[^\\S\\n]*\\r?\\n([\\s\\S]*?)```",
  );
  const m = response.match(re);
  if (!m) return null;
  const raw = m[1].replace(/\r\n/g, "\n").trim();
  if (raw === "") return [];
  return parseTestJson(raw);
}

/**
 * Extract an optional ```tests fenced block — legacy test-patch shape.
 * Prefer `extractUnitTests` / `extractIntegrationTests` for new prompts.
 */
export function extractTestPatch(response: string): TestSpec[] | null {
  return extractFencedTests(response, "tests");
}

/** Extract the ```unit-tests JSON array, if present. */
export function extractUnitTests(response: string): TestSpec[] | null {
  return extractFencedTests(response, "unit-tests");
}

/** Extract the ```integration-tests JSON array, if present. */
export function extractIntegrationTests(response: string): TestSpec[] | null {
  return extractFencedTests(response, "integration-tests");
}

/**
 * Round 6: on each regen, the Implementer's emitted test fence is the
 * authoritative test set for the function. We REPLACE rather than
 * merge — this prevents contradictory assertions from accumulating
 * across cycles (the failure mode that stalled parseFormData at 10/5
 * with four pairs of mutually-exclusive tests for the same input).
 *
 * The caller only invokes this when `patch !== null`, so a response
 * that omits the fence leaves existing tests alone.
 */
function replaceTestSet(
  _existing: TestSpec[],
  patch: TestSpec[],
): TestSpec[] {
  return [...patch];
}

export function createDesignDispatchBridge(
  graph: DesignGraph,
  rawChat: ChatFn,
  options: DispatchOptions = {},
): DesignDispatchBridge {
  const maxAttempts = options.maxAttempts ?? 8;
  const maxReviewCycles = options.maxReviewCycles ?? 3;
  // Wrap the host chat once — every call site inside the dispatcher
  // (Implementer attempts, architect review, decompose decision) gets
  // the abort retry.
  const chat = withAbortRetry(rawChat);
  const rawTestFn = options.runTests ?? runTests;
  const projectDir = options.projectDir;
  const testFn: TestFn = projectDir
    ? (g, candidate) => rawTestFn(g, candidate, { projectDir })
    : rawTestFn;

  return {
    async dispatch(module, name, runOpts) {
      const fn = graph.getFunction(module, name);
      if (!fn) {
        throw new Error(`function not found: ${module}#${name}`);
      }
      // External feedback (typically integration-loop failure context)
      // primes the first prompt like architect/analyzer feedback does.
      // Signals the Implementer that the call came from a failure
      // diagnosis path, not a fresh build, so unit tests should be
      // revisited alongside the body.
      const externalFeedback = runOpts?.externalFeedback ?? null;
      const key = `${module}#${name}`;
      debug(
        "dispatch",
        `begin ${key} hasImpl=${fn.implementation !== null} tests=${fn.tests.length} children=${fn.children.length}`,
      );

      // IMPLEMENT vs DECOMPOSE — only when a decomposer is wired AND
      // the function is still childless AND not yet implemented. If
      // the function already has children from a prior decompose, we
      // skip the decision (children were / are being built).
      if (
        options.decompose &&
        fn.children.length === 0 &&
        fn.implementation === null &&
        fn.spec !== null
      ) {
        let shouldDecompose: boolean;
        if (obviouslyImplementable(fn.spec)) {
          // Skip the LLM — spec is clearly a leaf. Saves a ~60–120s
          // turn on local inference AND prevents the askDecompose
          // framing from over-triggering on tight leaf pipelines.
          debug(
            "dispatch",
            `${key} complexity-floor: auto-IMPLEMENT (deps=0, edgeCases=${fn.spec.edgeCases.length} ≤ 4)`,
          );
          debug(
            "progress",
            `dispatch: ${key} complexity-floor → IMPLEMENT (no LLM call)`,
          );
          shouldDecompose = false;
        } else {
          shouldDecompose = await askDecompose(chat, fn, graph);
        }
        debug(
          "dispatch",
          `${key} decision: ${shouldDecompose ? "DECOMPOSE" : "IMPLEMENT"}`,
        );
        debug(
          "progress",
          `dispatch: ${key} decided ${shouldDecompose ? "DECOMPOSE" : "IMPLEMENT"}`,
        );
        if (shouldDecompose) {
          const ok = await options.decompose(graph, fn.name);
          if (!ok) {
            // Sub-plan failed (LLM couldn't produce valid children
            // JSON, or the safety gate tripped). Don't leave the
            // parent in limbo — fail loud so the Architect sees it.
            debug(
              "dispatch",
              `${key} decompose subplan FAILED — marking parent failed`,
            );
            debug("progress", `dispatch: ${key} decompose sub-plan FAILED`);
            return {
              module,
              name,
              status: "failed",
              implementation: null,
              attempts: 0,
              testOutput: "",
              error: "decompose sub-plan failed; no children declared",
            };
          }
          // The caller's outer build loop will now dispatch the newly-
          // added children (depth-first). When it returns here to
          // dispatch THIS function again (it's still declared), the
          // branch will fall through to body generation — because
          // fn.children.length will be > 0 and the if-gate above is
          // `=== 0`. Return a "decomposed" marker so the build knows
          // to revisit.
          return {
            module,
            name,
            status: "failed",
            implementation: null,
            attempts: 0,
            testOutput: "",
            error: "decomposed — children need to be dispatched first",
          };
        }
      }

      // Loop-local state, hoisted because the pre-test path may prime
      // some of these (pendingArchitectFeedback) before the loop starts.
      let previousBody = fn.implementation ?? "";
      let testOutput = "";
      let lastError: string | null = null;
      let reviewCycles = 0;
      let pendingArchitectFeedback: string | null = null;
      let pendingAnalyzerFeedback: string | null = null;
      // Prime the first prompt with external feedback if the caller
      // supplied it (integration-loop failure context). Formatted like
      // a reviewer critique so the Implementer reads it as actionable.
      let pendingExternalFeedback: string | null = externalFeedback
        ? `[integration-loop feedback]\n${externalFeedback}`
        : null;
      let lastAllTestsFailed = false;
      // Prior architect review feedback, carried forward to subsequent
      // review cycles so the reviewer can see what it said last time
      // and avoid contradicting itself.
      let priorReviewFeedback: string | null = null;
      // Stagnation detection. Two layers:
      //   1) Nudge (one-shot): on near-identical body + same failed count,
      //      next prompt asks the Implementer to rethink.
      //   2) Bail: if the test-output SIGNATURE (failed/passed + trimmed
      //      failure digest) repeats for two consecutive test-red runs,
      //      we halt the dispatch and preserve whatever best-attempt
      //      body we have. Stops the parseFormData 10/5-forever pattern.
      //      Genetic-algorithm principle: each iteration must leave
      //      evidence of progress; if it doesn't, move on.
      let lastFailedCount = -1;
      let lastPassedCount = -1;
      let priorBodyLength = -1;
      let stagnating = false;
      let stagnationFired = false;
      let lastFailureSignature: string | null = null;
      let identicalFailureStreak = 0;
      /** Max consecutive identical test-red signatures before bail. */
      const STAGNATION_BAIL_STREAK = 2;
      // Track the MOST-RECENT tests-green body so we never regress to
      // null on exhaustion. If the Implementer gets a green pass but
      // the architect REVISE's indefinitely, keep the green body; on
      // cap/exhaustion save it as architect-rejected rather than
      // emitting a stub. Covers the handleRequest pattern: 9/0 GREEN
      // → REVISE → 11/3 RED → ... → failed-with-null-impl, which is
      // strictly worse than keeping the 9/0 body.
      let lastGreenBody: { body: string; output: string } | null = null;

      // Pre-test: if an existing body is already in the graph (loaded
      // from disk, or carried over from a prior successful build),
      // check structural conformance FIRST (static analysis), then
      // tests, then architect. A loaded body that never went through
      // these gates shouldn't slip past them just because it's stored.
      //
      // EXCEPTION: when the caller primed `externalFeedback` (typically
      // integration-loop failure context), skip the pre-test entirely.
      // The body may pass its own unit tests while still causing the
      // integration test to fail — short-circuiting here would drop
      // the feedback and leave the bug in place. Force the regenerate
      // loop so the Implementer sees the failure text.
      //
      // Seed `lastGreenBody` with the existing body so that if the
      // regen loop exhausts without producing a better one, we keep
      // what we had rather than nulling the implementation.
      if (externalFeedback !== null && fn.implementation !== null) {
        lastGreenBody = { body: fn.implementation, output: "" };
      }
      if (fn.implementation !== null && externalFeedback === null) {
        const preAnalysis = await analyzeBody(fn.implementation);
        const preKnownNames = new Set(
          graph.listFunctions().map((f) => f.name),
        );
        // Recomposition (parent must reach every child via ctx.fns
        // call chain) is NOT enforced here — orphaned children get
        // picked up in a later cleanup/tightening pass. Dropping the
        // check lets tree-shaped compositions through (parent calls
        // one child that composes the others) without rejection.
        const preViolations = await collectBodyViolations(
          preAnalysis,
          preKnownNames,
          [],
          graph,
        );
        if (preViolations.length > 0) {
          debug(
            "dispatch",
            `pre-test body-analyzer REJECTED ${key}: ${preViolations.length} violation(s)`,
          );
          debug(
            "progress",
            `dispatch: ${key} pre-test body-analyzer REJECTED — ${preViolations.length} violation(s)`,
          );
          // Prime feedback so attempt 0 of the regenerate loop sees
          // the violation list. Don't run tests — the body is known
          // structurally invalid.
          previousBody = fn.implementation;
          pendingAnalyzerFeedback = preViolations.join("\n\n");
          testOutput = "";
          // Fall through to the regenerate loop (no early return).
        } else {
        const pre = await testFn(graph, { module, name, body: fn.implementation });
        debug(
          "dispatch",
          `pre-test ${key} ok=${pre.ok} passed=${pre.passed} failed=${pre.failed}`,
        );
        if (pre.ok) {
          let approved = true;
          if (maxReviewCycles > 0) {
            const currentFn = graph.getFunction(module, name);
            if (currentFn) {
              const review = await architectReview(
                chat,
                currentFn,
                graph,
                fn.implementation,
                pre.output,
              );
              approved = review.approved;
              if (!approved) {
                debug(
                  "dispatch",
                  `pre-test architect REVISE ${key}: ${review.feedback.slice(0, 120)} — falling through to regenerate`,
                );
                debug(
                  "progress",
                  `dispatch: ${key} pre-test architect REVISE — regenerate`,
                );
                // Fall through to the regenerate loop. Don't consume
                // a review cycle yet — the Implementer hasn't had a
                // chance to respond. Prime the feedback for attempt 1.
                previousBody = fn.implementation;
                pendingArchitectFeedback = formatArchitectFeedback(review);
                testOutput = pre.output;
                // Seed lastGreenBody with the pre-loaded body — it
                // went tests-green, so if the regenerate loop never
                // recovers another green, we restore this one rather
                // than erasing it to null.
                lastGreenBody = {
                  body: fn.implementation,
                  output: pre.output,
                };
              }
            }
          }
          if (approved) {
            debug("progress", `dispatch: ${key} pre-test green + approved — skipping LLM`);
            graph.setTestStatus(module, name, "tests-green", pre.output);
            // Reconcile spec.dependencies from the pre-existing body's
            // observed calls. Same contract as the regenerate path.
            reconcileSpecDependencies(graph, module, name, preAnalysis);
            return {
              module,
              name,
              status: "tests-green",
              implementation: fn.implementation,
              attempts: 0,
              testOutput: pre.output,
            };
          }
        }
        } // close else (structural check passed)
      }

      // Actual attempt count — separate from the loop var so the log
      // message on exhaustion shows what really ran, not the max.
      let actualAttempts = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        actualAttempts = attempt + 1;
        // Use feedback on attempt 0 too, as long as something primed it
        // (pre-test architect REVISE or pre-test analyzer rejection).
        // Without this, priming is dead and the Implementer's first
        // regenerate wastes a cycle rediscovering the problem.
        const hasPrimedFeedback =
          pendingArchitectFeedback !== null ||
          pendingAnalyzerFeedback !== null ||
          pendingExternalFeedback !== null;
        // External feedback rides on the architect channel because the
        // prompt template renders that field as high-priority "you must
        // address this" feedback.
        const architectFeedbackCombined = [
          pendingExternalFeedback,
          pendingArchitectFeedback,
        ]
          .filter((s): s is string => s !== null && s.length > 0)
          .join("\n\n");
        const prompt = await buildImplementerPrompt(
          graph,
          module,
          name,
          attempt === 0 && !hasPrimedFeedback
            ? undefined
            : {
                attempt,
                maxAttempts,
                previousBody,
                testOutput,
                architectFeedback:
                  architectFeedbackCombined.length > 0
                    ? architectFeedbackCombined
                    : undefined,
                analyzerFeedback: pendingAnalyzerFeedback ?? undefined,
                allTestsFailed: lastAllTestsFailed,
                stagnating,
                previousPassed: lastPassedCount >= 0 ? lastPassedCount : undefined,
                previousFailed: lastFailedCount >= 0 ? lastFailedCount : undefined,
              },
        );
        // Consumed — clear so a subsequent test-failure retry uses
        // test output, not stale review/analyzer feedback. Same
        // contract for `lastAllTestsFailed`: the flag reflects the
        // IMMEDIATELY prior test run, so we reset here and let the
        // next `testFn` result re-populate it. Paths that skip
        // testFn (extraction fail, analyzer reject, architect
        // REVISE-continue) leave it cleared.
        pendingArchitectFeedback = null;
        pendingAnalyzerFeedback = null;
        pendingExternalFeedback = null;
        lastAllTestsFailed = false;
        stagnating = false;

        debug(
          "dispatch",
          `attempt ${attempt + 1}/${maxAttempts} ${key} prompt=${prompt.length}ch`,
        );
        debug("progress", `dispatch: ${key} attempt ${attempt + 1}/${maxAttempts}`);
        let response: string;
        try {
          response = await chat(prompt);
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          debug("dispatch", `chat error ${key}: ${lastError}`);
          break;
        }
        debug("dispatch", `response ${key} len=${response.length}ch`);

        const body = extractBody(response);
        if (!body) {
          lastError =
            "model did not return a fenced code block with the function body";
          previousBody = response.slice(0, 400);
          testOutput = lastError;
          debug("dispatch", `no fenced body extracted ${key}; retrying`);
          continue;
        }
        // Short hash so consecutive logs reveal whether the Implementer
        // is actually changing the body or just resubmitting (a lazy
        // "fix" is one of the failure modes that masquerades as
        // real iteration).
        const bodyTag = (() => {
          let h = 0;
          for (let i = 0; i < body.length; i++) h = ((h << 5) - h + body.charCodeAt(i)) | 0;
          return (h >>> 0).toString(16).slice(0, 8);
        })();
        debug(
          "dispatch",
          `body extracted ${key} len=${body.length}ch hash=${bodyTag}`,
        );

        // Static analysis: run tree-sitter over the body BEFORE the
        // test run. Catches proc-ts violations (top-level imports, calls
        // to undeclared siblings) mechanically — cheaper than tests and
        // more deterministic than architect review.
        const analysis = await analyzeBody(body);
        const knownNames = new Set(
          graph.listFunctions().map((f) => f.name),
        );
        const violations = await collectBodyViolations(
          analysis,
          knownNames,
          [],
          graph,
        );
        if (violations.length > 0) {
          lastError = `body-analyzer rejected: ${violations.length} violation(s)`;
          previousBody = body;
          pendingAnalyzerFeedback = violations.join("\n\n");
          testOutput = ""; // tests were NOT run
          debug(
            "dispatch",
            `body-analyzer REJECTED ${key}: ${violations.length} violation(s)`,
          );
          debug(
            "progress",
            `dispatch: ${key} body-analyzer REJECTED — ${violations.length} violation(s)`,
          );
          continue;
        }

        // The Implementer owns the tests. On every attempt it may emit
        // ```unit-tests and/or ```integration-tests JSON arrays.
        // Same-name entries overwrite; new names append. Siblings'
        // tests and project-level tests are out of scope.
        const unitPatch = extractUnitTests(response);
        const integrationPatch = extractIntegrationTests(response);
        // Legacy ```tests fence still accepted as a unit-test patch
        // so older prompts keep working.
        const legacyPatch =
          unitPatch === null ? extractTestPatch(response) : null;
        const current = graph.getFunction(module, name);
        if (current) {
          const appliedUnit = unitPatch ?? legacyPatch;
          if (appliedUnit !== null) {
            const next = replaceTestSet(current.tests, appliedUnit);
            graph.replaceTests(module, name, next);
            debug(
              "dispatch",
              `unit-tests patch applied to ${key}: ${appliedUnit.length} updated, total now ${next.length}`,
            );
            debug(
              "progress",
              `dispatch: ${key} unit-tests — ${appliedUnit.length} updated`,
            );
          }
          if (integrationPatch !== null) {
            // Leaves can't run integration tests (renderIntegrationTestFile
            // drops them for children-less functions). Reject the patch
            // loudly instead of silently storing dead entries.
            if (current.children.length === 0 && integrationPatch.length > 0) {
              debug(
                "dispatch",
                `integration-tests IGNORED for leaf ${key} (${integrationPatch.length} entries) — leaves don't render integration files`,
              );
              debug(
                "progress",
                `dispatch: ${key} integration-tests ignored (leaf)`,
              );
            } else {
              const next = replaceTestSet(current.integrationTests, integrationPatch);
              graph.replaceIntegrationTests(module, name, next);
              debug(
                "dispatch",
                `integration-tests patch applied to ${key}: ${integrationPatch.length} updated, total now ${next.length}`,
              );
              debug(
                "progress",
                `dispatch: ${key} integration-tests — ${integrationPatch.length} updated`,
              );
            }
          }
        }

        // No tests to run yet — the Implementer must emit at least one
        // unit test before we can evaluate the body. Treat as a retry
        // with explicit feedback.
        const hasAnyTests =
          (graph.getFunction(module, name)?.tests.length ?? 0) > 0;
        if (!hasAnyTests) {
          lastError =
            "no tests declared for this function — emit a ```unit-tests fence with at least one test";
          previousBody = body;
          testOutput = lastError;
          debug("dispatch", `no tests extracted ${key}; retrying`);
          continue;
        }

        const tr = await testFn(graph, { module, name, body });
        // Stagnation detection: if this attempt's body is within 5% of
        // the previous attempt's length AND the failure count matches,
        // the Implementer is spinning on cosmetic tweaks. Flag the
        // NEXT attempt so the Implementer is nudged to rethink.
        // Only meaningful in the test-failing regime — review-driven
        // iterations (tr.failed === 0, architect REVISE) are not
        // cosmetic tweaks; the Implementer is responding to reviewer
        // concerns.
        if (
          tr.failed > 0 &&
          priorBodyLength >= 0 &&
          lastFailedCount >= 0 &&
          !stagnationFired
        ) {
          const lenDiff = Math.abs(body.length - priorBodyLength);
          const lenRatio = lenDiff / Math.max(priorBodyLength, 1);
          if (lenRatio < 0.05 && tr.failed === lastFailedCount) {
            stagnating = true;
            stagnationFired = true;
          }
        }
        priorBodyLength = body.length;
        lastFailedCount = tr.failed;
        lastPassedCount = tr.passed;

        // Bail on repeated identical failure SETS. The signature is the
        // sorted list of failing test names — semantic identity, not
        // output-text identity. Oscillation ("fix one, break another")
        // shows up as a CHANGING set even if counts stay the same;
        // true stagnation ("same tests keep failing") shows up as an
        // UNCHANGED set. Falls back to count-based signature when
        // runner doesn't supply names (test fixtures).
        if (!tr.ok && tr.failed > 0) {
          const names = tr.failingTestNames;
          const sig =
            names && names.length > 0
              ? `names:${names.join("||")}`
              : `counts:${tr.failed}/${tr.passed}|${(tr.output ?? "").slice(0, 300)}`;
          if (sig === lastFailureSignature) {
            identicalFailureStreak++;
          } else {
            identicalFailureStreak = 1;
          }
          lastFailureSignature = sig;
          if (identicalFailureStreak >= STAGNATION_BAIL_STREAK) {
            debug(
              "dispatch",
              `stagnation bail ${key} — ${identicalFailureStreak} consecutive identical failures (${tr.failed}/${tr.passed})`,
            );
            debug(
              "progress",
              `dispatch: ${key} STAGNATION BAIL — ${identicalFailureStreak} identical test-red runs`,
            );
            // Preserve best-attempt body if we ever saw green; otherwise
            // save the current (failing) body so something lands in the
            // graph. Status is "stagnated" (not "failed") so the
            // orchestrator can recognize the recoverable case and
            // trigger decomposition rather than just marking blocked.
            if (lastGreenBody) {
              graph.setImplementation(module, name, lastGreenBody.body);
              graph.setTestStatus(
                module,
                name,
                "architect-rejected",
                lastGreenBody.output,
              );
              return {
                module,
                name,
                status: "stagnated",
                implementation: lastGreenBody.body,
                attempts: actualAttempts,
                testOutput: lastGreenBody.output,
                error: "stagnation: identical failing-test set across attempts",
              };
            }
            graph.setImplementation(module, name, body);
            graph.setTestStatus(module, name, "tests-red", tr.output);
            return {
              module,
              name,
              status: "stagnated",
              implementation: body,
              attempts: actualAttempts,
              testOutput: tr.output,
              error: "stagnation: identical failing-test set across attempts",
            };
          }
        } else {
          // Reset the streak on anything that isn't a red run.
          identicalFailureStreak = 0;
          lastFailureSignature = null;
        }

        previousBody = body;
        testOutput = tr.output;
        // Set (or reset) the all-tests-failed flag for the NEXT attempt.
        // Always updated per test run so the flag can't go stale across
        // architect-REVISE continues or extraction-fail continues.
        lastAllTestsFailed = tr.failed > 0 && tr.passed === 0;
        debug(
          "dispatch",
          `test ${key} ok=${tr.ok} passed=${tr.passed} failed=${tr.failed}`,
        );
        // Diagnostic: on red, dump the failing test names AND the first
        // line of the output (contains the failure digest) so we can
        // reconstruct what the Implementer was working against without
        // reading the prompt verbatim. Enables post-mortem diagnosis
        // of stagnation cases.
        if (!tr.ok && tr.failed > 0) {
          const names =
            tr.failingTestNames && tr.failingTestNames.length > 0
              ? tr.failingTestNames.join("; ")
              : "(no names captured)";
          const digestLine =
            (tr.output ?? "")
              .split("\n")
              .find((l) => l.startsWith("✗"))?.slice(0, 240) ?? "";
          debug(
            "dispatch",
            `test ${key} FAILING: ${names}${digestLine ? ` | first: ${digestLine}` : ""}`,
          );
        }

        if (tr.ok) {
          // Remember this green body BEFORE review — on exhaustion
          // we'll prefer keeping it (as architect-rejected) over
          // returning a null implementation.
          lastGreenBody = { body, output: tr.output };
          // Architect review gate. The Implementer's body passed the
          // Implementer's own tests — now the Architect checks that
          // the body actually satisfies the SPEC (the original
          // contract). If the Architect rejects, the Implementer is
          // re-dispatched with the feedback injected. Reviews share
          // the `maxAttempts` budget but have their own cap.
          if (maxReviewCycles > 0) {
            const currentFn = graph.getFunction(module, name);
            if (!currentFn) {
              // Concurrent removal — shouldn't happen in our flow, but
              // don't crash.
              graph.setImplementation(module, name, body);
              graph.setTestStatus(module, name, "tests-green", tr.output);
              return {
                module,
                name,
                status: "tests-green",
                implementation: body,
                attempts: attempt + 1,
                testOutput: tr.output,
              };
            }
            const review = await architectReview(
              chat,
              currentFn,
              graph,
              body,
              tr.output,
              priorReviewFeedback ?? undefined,
            );
            if (!review.approved) {
              reviewCycles++;
              debug(
                "dispatch",
                `architect REVISE ${key} (cycle ${reviewCycles}/${maxReviewCycles}): ${review.feedback.slice(0, 120)}`,
              );
              debug(
                "progress",
                `dispatch: ${key} architect REVISE (${reviewCycles}/${maxReviewCycles})`,
              );
              if (reviewCycles >= maxReviewCycles) {
                // Preserve the (green) body instead of dropping to
                // null — architect-rejected but functionally working
                // code beats a stub downstream.
                graph.setImplementation(module, name, body);
                graph.setTestStatus(
                  module,
                  name,
                  "architect-rejected",
                  tr.output,
                );
                return {
                  module,
                  name,
                  status: "failed",
                  implementation: body,
                  attempts: attempt + 1,
                  testOutput: tr.output,
                  error: `architect rejected after ${reviewCycles} review cycle(s): ${review.feedback.slice(0, 300)}`,
                };
              }
              previousBody = body;
              pendingArchitectFeedback = formatArchitectFeedback(review);
              // Remember this cycle's feedback for the NEXT review so
              // the architect can see what it already said and not
              // contradict itself on cycle 2+.
              priorReviewFeedback = review.feedback;
              // Keep testOutput as the (passing) test output for
              // reference, but the prompt builder will surface the
              // architect feedback under its own section instead.
              testOutput = tr.output;
              lastError = `architect requested revision (cycle ${reviewCycles}/${maxReviewCycles})`;
              continue;
            }
            debug("dispatch", `architect APPROVE ${key}`);
            debug("progress", `dispatch: ${key} architect APPROVE`);
          }
          graph.setImplementation(module, name, body);
          graph.setTestStatus(module, name, "tests-green", tr.output);
          // Reconcile the LLM's phase-2 dependency guess with the body
          // we just saved. The `analysis` variable captured the call
          // sites of THIS body before the test run.
          reconcileSpecDependencies(graph, module, name, analysis);
          debug("dispatch", `saved ${key} (green after ${attempt + 1} attempts)`);
          debug(
            "progress",
            `dispatch: ${key} GREEN (${attempt + 1} attempts, ${tr.passed}/${tr.passed + tr.failed} passed)`,
          );
          return {
            module,
            name,
            status: "tests-green",
            implementation: body,
            attempts: attempt + 1,
            testOutput: tr.output,
          };
        }
        lastError = `tests failed (${tr.failed} failing, ${tr.passed} passing)`;
      }
      debug(
        "dispatch",
        `exhausted ${key} attempts=${actualAttempts}/${maxAttempts} lastError=${lastError}`,
      );

      // Recovery: if any attempt went tests-green during this dispatch
      // (even if the architect kept REVISE'ing after), preserve that
      // body rather than dropping to null. Downstream finalize would
      // otherwise emit a stub, which is strictly worse than a green
      // body with architect concerns — regressing to red while chasing
      // architect feedback is the handleRequest failure mode this
      // fallback fixes.
      if (lastGreenBody) {
        graph.setImplementation(module, name, lastGreenBody.body);
        graph.setTestStatus(
          module,
          name,
          "architect-rejected",
          lastGreenBody.output,
        );
        debug(
          "dispatch",
          `preserved last-green body for ${key} (exhausted without approval)`,
        );
        return {
          module,
          name,
          status: "failed",
          implementation: lastGreenBody.body,
          attempts: actualAttempts,
          testOutput: lastGreenBody.output,
          error: `exhausted ${actualAttempts}/${maxAttempts} attempts; preserving last tests-green body (architect concerns unresolved). ${lastError ?? ""}`.trim(),
        };
      }

      graph.setTestStatus(module, name, "tests-red", testOutput);
      return {
        module,
        name,
        status: "failed",
        implementation: null,
        attempts: actualAttempts,
        testOutput,
        error: lastError ?? "dispatch exhausted attempts without going green",
      };
    },
  };
}
