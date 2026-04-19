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
}

async function askDecompose(
  chat: ChatFn,
  fn: import("./design-graph.js").FunctionNode,
): Promise<boolean> {
  const prompt = [
    `You are deciding how to implement a function. Apply the`,
    `**Single Responsibility Principle**: a function should do ONE thing.`,
    "",
    `Function: ${fn.name}`,
    `Signature: ${fn.signature.isAsync ? "async " : ""}function ${fn.name}(ctx: Ctx${fn.signature.params.length > 0 ? ", " + fn.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ") : ""}): ${fn.signature.returnType}`,
    `Purpose: ${fn.description}`,
    "",
    `Tests that must pass:`,
    ...fn.tests.flatMap((t) => [
      `  - ${t.name}:`,
      ...t.code
        .split("\n")
        .slice(0, 6)
        .map((line) => `      ${line}`),
    ]),
    "",
    `THE ONE QUESTION: does this function do exactly ONE thing?`,
    "",
    `Read the purpose and tests carefully. Count the distinct concerns:`,
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
 * Skips any ```tests fence (reserved for test patches — see
 * `extractTestPatch`). Returns the first CODE fence's contents.
 */
export function extractBody(response: string): string | null {
  const re = /```([a-zA-Z]+(?::[^\s]*)?)?[^\S\n]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const tag = (m[1] ?? "").toLowerCase().split(":")[0];
    if (tag === "tests") continue; // reserved for test-patch shape
    return m[2].replace(/\r\n/g, "\n").trim();
  }
  return null;
}

/**
 * Extract an optional test patch — a ```tests fenced block containing
 * a JSON array of `{name, code}` entries. Returns null if absent or
 * unparseable. Tests matching existing names by `name` are replaced;
 * new names are appended. Scope: only tests for the dispatched
 * function. Other functions' tests are out of bounds.
 */
export function extractTestPatch(
  response: string,
): TestSpec[] | null {
  const m = response.match(/```tests[^\S\n]*\r?\n([\s\S]*?)```/);
  if (!m) return null;
  const raw = m[1].replace(/\r\n/g, "\n").trim();
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

export function createDesignDispatchBridge(
  graph: DesignGraph,
  chat: ChatFn,
  options: DispatchOptions = {},
): DesignDispatchBridge {
  const maxAttempts = options.maxAttempts ?? 5;
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
        fn.tests.length > 0
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

      // Pre-test: if an existing body is already in the graph (loaded
      // from disk, or carried over from a prior successful build),
      // check if it already passes the declared tests. Skip the LLM
      // call entirely when it does — saves a turn and a generation.
      if (fn.implementation !== null) {
        const pre = await testFn(graph, { module, name, body: fn.implementation });
        debug(
          "dispatch",
          `pre-test ${key} ok=${pre.ok} passed=${pre.passed} failed=${pre.failed}`,
        );
        if (pre.ok) {
          debug("progress", `dispatch: ${key} pre-test green — skipping LLM`);
          graph.setTestStatus(module, name, "tests-green", pre.output);
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

      let previousBody = fn.implementation ?? "";
      let testOutput = "";
      let lastError: string | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const prompt = await buildImplementerPrompt(
          graph,
          module,
          name,
          attempt === 0
            ? undefined
            : {
                attempt,
                maxAttempts,
                previousBody,
                testOutput,
              },
        );

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

        // Optional test-patch: the Implementer can patch its OWN
        // tests if it believes they have bugs. Patched tests replace
        // same-named existing entries; new names are appended. Only
        // tests on THIS function are writeable — siblings' tests are
        // out of scope for the dispatched agent.
        const testPatch = extractTestPatch(response);
        if (testPatch && testPatch.length > 0) {
          const current = graph.getFunction(module, name);
          if (current) {
            const byName = new Map(
              current.tests.map((t) => [t.name, t] as const),
            );
            for (const p of testPatch) byName.set(p.name, p);
            const next = [...byName.values()];
            // Mutate in place — graph's test list is the canonical
            // store and we don't have a bulk-replace API.
            current.tests.length = 0;
            current.tests.push(...next);
            debug(
              "dispatch",
              `test-patch applied to ${key}: ${testPatch.length} test(s) updated, total now ${current.tests.length}`,
            );
            debug(
              "progress",
              `dispatch: ${key} test-patch — ${testPatch.length} test(s) updated`,
            );
          }
        }

        const tr = await testFn(graph, { module, name, body });
        previousBody = body;
        testOutput = tr.output;
        debug(
          "dispatch",
          `test ${key} ok=${tr.ok} passed=${tr.passed} failed=${tr.failed}`,
        );

        if (tr.ok) {
          graph.setImplementation(module, name, body);
          graph.setTestStatus(module, name, "tests-green", tr.output);
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
