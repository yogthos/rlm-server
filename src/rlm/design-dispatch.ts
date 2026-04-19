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
 * Collect structural violations of a proc-ts body given the set of
 * known sibling names. Returns a list of human-readable violation
 * messages (empty when clean). Used in two places: the regenerate
 * loop after extractBody, and the pre-test path for loaded bodies.
 */
function collectBodyViolations(
  analysis: BodyAnalysis,
  knownNames: Set<string>,
): string[] {
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
  return violations;
}

export interface DispatchResult {
  module: string;
  name: string;
  status: FunctionStatus | "failed";
  implementation: string | null;
  attempts: number;
  /** Last test output — present whether we finished green or red. */
  testOutput: string;
  /** When dispatch failed to produce a passing implementation. */
  error?: string;
}

export interface DesignDispatchBridge {
  dispatch(module: string, name: string): Promise<DispatchResult>;
}

export type ChatFn = (prompt: string) => Promise<string>;

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
   *  0 disables review (legacy behavior). Default 2. */
  maxReviewCycles?: number;
}

/** Architect's post-green verdict on an Implementer's work. */
export interface ReviewVerdict {
  approved: boolean;
  /** Actionable feedback when `approved: false`. */
  feedback: string;
}

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
    return { approved: false, feedback: rest };
  }
  return { approved: true, feedback: "" };
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
    "The Implementer's body:",
    "```ts",
    body,
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
  const prompt = [
    ...sections,
    "Evaluate CRITICALLY whether the implementation solves the SPEC:",
    "- Does the body fulfill the stated purpose?",
    "- Does it cover every edge case the spec listed?",
    "- Does it produce the declared side effects (and no undeclared ones)?",
    "- Does it call each declared dependency appropriately?",
    "- Are the unit tests MEANINGFUL — not trivial tautologies like",
    "  `expect(true).toBe(true)` or assertions that just mirror the body?",
    "",
    "Reply with EXACTLY one fenced code block:",
    "",
    "```",
    "APPROVE",
    "```",
    "",
    "when the spec is satisfied, OR:",
    "",
    "```",
    "REVISE",
    "<2–6 sentences of specific, actionable feedback — what the Implementer",
    "must change to satisfy the spec. Be concrete, not vague.>",
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

async function askDecompose(
  chat: ChatFn,
  fn: import("./design-graph.js").FunctionNode,
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
  const prompt = [
    `You are deciding how to implement a function. Apply the`,
    `**Single Responsibility Principle**: a function should do ONE thing.`,
    "",
    `Function: ${fn.name}`,
    `Signature: ${fn.signature.isAsync ? "async " : ""}function ${fn.name}(ctx: Ctx${fn.signature.params.length > 0 ? ", " + fn.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ") : ""}): ${fn.signature.returnType}`,
    ...specLines,
    "",
    `THE ONE QUESTION: does this function do exactly ONE thing?`,
    "",
    `Read the purpose and spec carefully. Count the distinct concerns:`,
    `  - Parsing input is one concern.`,
    `  - Validating is another.`,
    `  - Persisting is another.`,
    `  - Transforming a value is one.`,
    `  - Responding to an HTTP request that orchestrates several of the`,
    `    above is MULTIPLE concerns.`,
    "",
    `If the function does ONE thing (pure transform, one I/O step, one`,
    `validation rule, one render), answer:`,
    "```",
    "IMPLEMENT",
    "```",
    "",
    `If the function orchestrates TWO OR MORE distinct concerns — if you`,
    `could sensibly extract helpers that each own a single concern —`,
    `answer:`,
    "```",
    "DECOMPOSE",
    "```",
    "",
    `Examples:`,
    `  - \`hashPassword(pw)\` → IMPLEMENT (one transform).`,
    `  - \`parseFormBody(req)\` → IMPLEMENT (one parse).`,
    `  - \`validateEmail(s)\` → IMPLEMENT (one validation).`,
    `  - \`handleSignup(req, res)\` (parse + validate + hash + write + reply)`,
    `    → DECOMPOSE (five concerns).`,
    `  - \`startServer(port)\` that just calls one library API → IMPLEMENT.`,
    `  - \`startServer(port)\` that builds routes, wires middleware, and`,
    `    starts listening → DECOMPOSE.`,
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

function mergeTests(existing: TestSpec[], patch: TestSpec[]): TestSpec[] {
  const byName = new Map(existing.map((t) => [t.name, t] as const));
  for (const p of patch) byName.set(p.name, p);
  return [...byName.values()];
}

export function createDesignDispatchBridge(
  graph: DesignGraph,
  chat: ChatFn,
  options: DispatchOptions = {},
): DesignDispatchBridge {
  const maxAttempts = options.maxAttempts ?? 5;
  const maxReviewCycles = options.maxReviewCycles ?? 2;
  const rawTestFn = options.runTests ?? runTests;
  const projectDir = options.projectDir;
  const testFn: TestFn = projectDir
    ? (g, candidate) => rawTestFn(g, candidate, { projectDir })
    : rawTestFn;

  return {
    async dispatch(module, name) {
      const fn = graph.getFunction(module, name);
      if (!fn) {
        throw new Error(`function not found: ${module}#${name}`);
      }
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
        const shouldDecompose = await askDecompose(chat, fn);
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

      // Pre-test: if an existing body is already in the graph (loaded
      // from disk, or carried over from a prior successful build),
      // check structural conformance FIRST (static analysis), then
      // tests, then architect. A loaded body that never went through
      // these gates shouldn't slip past them just because it's stored.
      if (fn.implementation !== null) {
        const preAnalysis = await analyzeBody(fn.implementation);
        const preKnownNames = new Set(
          graph.listFunctions().map((f) => f.name),
        );
        const preViolations = collectBodyViolations(
          preAnalysis,
          preKnownNames,
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
                pendingArchitectFeedback = review.feedback;
                testOutput = pre.output;
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

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Use feedback on attempt 0 too, as long as something primed it
        // (pre-test architect REVISE or pre-test analyzer rejection).
        // Without this, priming is dead and the Implementer's first
        // regenerate wastes a cycle rediscovering the problem.
        const hasPrimedFeedback =
          pendingArchitectFeedback !== null ||
          pendingAnalyzerFeedback !== null;
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
                architectFeedback: pendingArchitectFeedback ?? undefined,
                analyzerFeedback: pendingAnalyzerFeedback ?? undefined,
              },
        );
        // Consumed — clear so a subsequent test-failure retry uses
        // test output, not stale review/analyzer feedback.
        pendingArchitectFeedback = null;
        pendingAnalyzerFeedback = null;

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
        debug("dispatch", `body extracted ${key} len=${body.length}ch`);

        // Static analysis: run tree-sitter over the body BEFORE the
        // test run. Catches proc-ts violations (top-level imports, calls
        // to undeclared siblings) mechanically — cheaper than tests and
        // more deterministic than architect review.
        const analysis = await analyzeBody(body);
        const knownNames = new Set(
          graph.listFunctions().map((f) => f.name),
        );
        const violations = collectBodyViolations(analysis, knownNames);
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
            const next = mergeTests(current.tests, appliedUnit);
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
              const next = mergeTests(current.integrationTests, integrationPatch);
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
        previousBody = body;
        testOutput = tr.output;
        debug(
          "dispatch",
          `test ${key} ok=${tr.ok} passed=${tr.passed} failed=${tr.failed}`,
        );

        if (tr.ok) {
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
                  implementation: null,
                  attempts: attempt + 1,
                  testOutput: tr.output,
                  error: `architect rejected after ${reviewCycles} review cycle(s): ${review.feedback.slice(0, 300)}`,
                };
              }
              previousBody = body;
              pendingArchitectFeedback = review.feedback;
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
        `exhausted ${key} attempts=${maxAttempts} lastError=${lastError}`,
      );

      graph.setTestStatus(module, name, "tests-red", testOutput);
      return {
        module,
        name,
        status: "failed",
        implementation: null,
        attempts: maxAttempts,
        testOutput,
        error: lastError ?? "dispatch exhausted attempts without going green",
      };
    },
  };
}
