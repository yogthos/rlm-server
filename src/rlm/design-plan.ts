/**
 * Multi-turn planner for a user task.
 *
 * The Architect's original "write a single big repl block that builds
 * the whole graph" interaction was brittle — LLMs handle one
 * well-scoped instruction per turn much better. `designPlan` drives a
 * deterministic pipeline where each turn asks for ONE thing with a
 * fixed JSON shape, the harness accumulates state in the DesignGraph,
 * then defers to `designBuild` for the mechanical dispatch + finalize.
 *
 * Turns:
 *   1. "List the functions needed." → [{module, name, signature, description}]
 *   2. Per function: "Write the tests." → [{name, code}]
 *   3. designBuild runs.
 */

import type {
  DesignGraph,
  Signature,
  TestSpec,
} from "./design-graph.js";
import { designBuild, type BuildReport, type BuildOptions } from "./design-build.js";
import { debug } from "./debug.js";

export interface DesignPlanOptions {
  chat: (prompt: string) => Promise<string>;
  dispatch: BuildOptions["dispatch"];
  finalize: BuildOptions["finalize"];
  /** How many times to retry each JSON phase when shape validation fails. */
  maxShapeRetries?: number;
  /** Plan the children of an EXISTING function rather than top-level
   *  functions for the task. When set, phase 1 lists CHILDREN of this
   *  function; phase 2 writes integration tests for each child's role
   *  in the parent's assembly; phase 3 (build) is SKIPPED — the
   *  caller decides when to dispatch. */
  parent?: string;
}

export interface PlannedFunction {
  module: string;
  name: string;
  signature: Signature;
  description: string;
}

/** Extract the first fenced JSON block, or parse the whole response. */
export function extractJson(response: string): unknown {
  const fenced = response.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : response.trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function parseFunctionList(raw: unknown): PlannedFunction[] {
  if (!Array.isArray(raw)) {
    throw new Error("function list must be a JSON array");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`entry ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.module !== "string") throw new Error(`entry ${i} missing "module"`);
    if (typeof r.name !== "string") throw new Error(`entry ${i} missing "name"`);
    if (!r.signature || typeof r.signature !== "object") {
      throw new Error(`entry ${i} missing "signature"`);
    }
    const sig = r.signature as Signature;
    if (!Array.isArray(sig.params)) throw new Error(`entry ${i} signature.params must be array`);
    if (typeof sig.returnType !== "string") {
      throw new Error(`entry ${i} signature.returnType must be string`);
    }
    return {
      module: r.module,
      name: r.name,
      signature: sig,
      description: typeof r.description === "string" ? r.description : "",
    };
  });
}

export function parseTestList(raw: unknown): TestSpec[] {
  if (!Array.isArray(raw)) throw new Error("test list must be a JSON array");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`test ${i} not an object`);
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") throw new Error(`test ${i} missing "name"`);
    if (typeof r.code !== "string") throw new Error(`test ${i} missing "code"`);
    return { name: r.name, code: r.code };
  });
}

export interface FunctionSpec {
  description: string;
  tests: TestSpec[];
}

export function parseFunctionSpec(raw: unknown): FunctionSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("function spec must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.description !== "string" || r.description.trim().length === 0) {
    throw new Error("spec missing non-empty \"description\"");
  }
  return {
    description: r.description,
    tests: parseTestList(r.tests),
  };
}

/** Parse an integration-test array (same shape as unit tests). */
export function parseIntegrationTestList(raw: unknown): TestSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("integration test list must be a JSON array");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`test ${i} not an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") throw new Error(`test ${i} missing "name"`);
    if (typeof r.code !== "string") throw new Error(`test ${i} missing "code"`);
    return { name: r.name, code: r.code };
  });
}

function buildPhase1Prompt(
  task: string,
  parent?: PlannedFunction,
  existingNames: string[] = [],
): string {
  if (parent) {
    const userParams = parent.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    const paramList = userParams.length > 0 ? `ctx: Ctx, ${userParams}` : "ctx: Ctx";
    const existingBlock =
      existingNames.length > 0
        ? [
            "",
            `Functions already in the project (names are GLOBALLY UNIQUE —`,
            `do NOT reuse any of these names for a new child; pick a`,
            `distinct name. You CAN reference them from inside the parent's`,
            `body via \`ctx.fns.<name>(ctx, ...)\` without declaring them as`,
            `children):`,
            ...existingNames.map((n) => `  - ${n}`),
          ]
        : [];
    return [
      `You are decomposing a function. It is too complex to implement`,
      `directly — you need to break it into sub-functions (children) that`,
      `assemble into its behavior.`,
      "",
      `Parent task (the whole application's goal):`,
      task,
      "",
      `Parent function you are decomposing:`,
      `  name: ${parent.name}`,
      `  signature: ${parent.signature.isAsync ? "async " : ""}function ${parent.name}(${paramList}): ${parent.signature.returnType}`,
      `  purpose: ${parent.description}`,
      ...existingBlock,
      "",
      `Return ONLY a fenced JSON block listing the NEW children. Each child:`,
      "  - module: string (file path — reuse the parent's module)",
      "  - name: string (function name, camelCase, globally unique,",
      "    NOT already in the existing-functions list above)",
      "  - signature: { params: [{name, type}], returnType, isAsync? }",
      "  - description: string (one-line purpose within the assembly)",
      "",
      "**IMPORTANT**: the `params` array must NOT include `ctx: Ctx` —",
      "the harness injects it automatically as the first parameter.",
      "Only list BUSINESS params (e.g. `req`, `entries`, `path`).",
      "",
      "The children should compose cleanly: the parent's body will call",
      "each child via `ctx.fns.<child>(ctx, ...)`. Write 2–5 children",
      "focused on distinct concerns. Do NOT include the parent itself.",
      "No prose outside the JSON block.",
    ].join("\n");
  }
  return [
    `Your job is to list the top-level functions needed to complete this task:`,
    "",
    task,
    "",
    "These are the roots of the project's call tree. Each becomes its own",
    "proc-ts file; an Architect at dispatch time may later decompose any of",
    "them into children if too complex.",
    "",
    "Return ONLY a fenced JSON block. The value must be an array of objects",
    "with these exact fields:",
    "  - module: string (file path, e.g. `src/server.js`; use `.js` for pure",
    "    Node, `.ts` for TypeScript)",
    "  - name: string (function name, camelCase, globally unique)",
    "  - signature: { params: [{name, type}], returnType, isAsync? }",
    "  - description: string (one-line purpose in the overall assembly)",
    "",
    "**IMPORTANT**: the `params` array must NOT include `ctx: Ctx` —",
    "the harness injects it automatically as the first parameter.",
    "List only BUSINESS params (e.g. `path`, `req`, `entries`).",
    "",
    "Example:",
    "```json",
    "[",
    '  {"module": "src/db.ts", "name": "connect",',
    '   "signature": {"params": [{"name":"path","type":"string"}], "returnType":"Database"},',
    '   "description": "open a SQLite database"}',
    "]",
    "```",
    "",
    "No prose outside the JSON block.",
  ].join("\n");
}

function buildPhase2Prompt(
  task: string,
  fn: PlannedFunction,
  siblings: PlannedFunction[],
): string {
  // Render the proc-ts signature — `ctx: Ctx` injected first — so the
  // LLM writing tests sees the real calling shape.
  const userParams = fn.signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const paramList = userParams.length > 0 ? `ctx: Ctx, ${userParams}` : "ctx: Ctx";
  const sigStr = `${fn.signature.isAsync ? "async " : ""}function ${fn.name}(${paramList}): ${fn.signature.returnType}`;
  const siblingList = siblings
    .filter((s) => !(s.module === fn.module && s.name === fn.name))
    .map((s) => `  - ${s.name}: ${s.description}`)
    .join("\n");
  return [
    `For the following function, write (a) a detailed description and`,
    `(b) INTEGRATION tests that exercise its role in the assembly.`,
    "",
    `Parent task (the whole application):`,
    task,
    "",
    `Function: ${fn.name}`,
    `Signature: ${sigStr}`,
    `Initial description: ${fn.description}`,
    "",
    siblingList
      ? `Other functions in the project (siblings/roots you'll assemble with):\n${siblingList}`
      : "No sibling functions.",
    "",
    "TEST LEVEL — think integration, not unit:",
    "- These tests describe how this function CONTRIBUTES to the overall",
    "  application's behavior. Exercise observable outcomes of the assembly.",
    "- Do NOT test trivial internal details. Someone else (the Implementer,",
    "  or a sub-Architect decomposing this function further) will handle the",
    "  unit-level invariants.",
    "- If this function calls siblings, the tests can stub siblings or let",
    "  them run — whichever better captures the contract this function owes",
    "  its caller.",
    "",
    "PROC-TS test conventions (IMPORTANT — the harness scaffolds each test file for you):",
    `- The function is imported and available by bare name as a default export.`,
    `- A local \`let ctx\` with every sibling wired into \`ctx.fns\` is in scope.`,
    `- Each \`it(...)\` callback is ALREADY async — you can freely use \`await\``,
    `  inside the test code without declaring anything.`,
    `- \`fs\`, \`path\`, and \`http\` are imported as namespaces (\`import * as fs from "node:fs"\`).`,
    `  Use them as-is (e.g. \`fs.promises.readFile(...)\`). Any other Node module`,
    `  can be dynamic-imported: \`const mod = await import("node:foo")\`.`,
    "",
    "CALLING CONVENTION:",
    `- Always pass ctx first: \`${fn.name}(ctx, ...args)\`.`,
    `- Siblings: \`ctx.fns.other(ctx, ...)\`.`,
    "",
    "STUBBING SIBLINGS — use sparingly:",
    "  - If this function will later be DECOMPOSED into children, the",
    "    tests must NOT stub those children — the whole point of the",
    "    integration test is to exercise the real assembly. Let the",
    "    wired `ctx.fns.<child>` run as-is.",
    "  - Stub only when:",
    "    (a) the sibling is an I/O primitive (fs/http/db) and the test",
    "        cares about inputs it receives, or",
    "    (b) this test is isolating a narrow concern that doesn't",
    "        need the full assembly.",
    "  - Stub shape: plain arrow closures matching the signature (ctx first):",
    "",
    "    ```ts",
    "    ctx.fns.writeLog = async (_ctx, msg) => { /* record or ignore */ };",
    "    ```",
    "",
    "  Do NOT assume mock frameworks like Sinon — write plain closures",
    "  that record into local variables when you need to assert on calls.",
    "",
    "DO NOT use imports, mock libraries, or assume a test runner beyond vitest's",
    "`describe`/`it`/`expect`.",
    "",
    "Return ONLY a fenced JSON block with this shape:",
    "```json",
    "{",
    '  "description": "Paragraph(s) explaining purpose, inputs, outputs, edge cases, side effects, and which sibling fns it calls.",',
    '  "tests": [',
    `    {"name": "short test name", "code": "const result = ${fn.signature.isAsync ? "await " : ""}${fn.name}(ctx${fn.signature.params.length > 0 ? ", /* args */" : ""}); expect(result).toBe(/* … */);"}`,
    "  ]",
    "}",
    "```",
    "",
    "Write 2–5 focused tests. Each `code` is a plain JS/TS statement list;",
    "`await` is allowed; `ctx` is in scope. No prose outside the JSON block.",
  ].join("\n");
}

function buildProjectIntegrationPrompt(
  task: string,
  fns: PlannedFunction[],
): string {
  const roots = fns
    .map(
      (f) =>
        `  - ${f.name}(ctx${f.signature.params.length > 0 ? ", " + f.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ") : ""}): ${f.signature.returnType} — ${f.description}`,
    )
    .join("\n");
  return [
    `Write PROJECT-LEVEL INTEGRATION TESTS for the application below.`,
    "",
    `Application goal:`,
    task,
    "",
    `The project exports the following functions — all will be wired`,
    `into \`ctx.fns\` and available for your tests. Do NOT stub any of`,
    `them; call them as real implementations. Tests run AFTER every`,
    `function is unit-tested green:`,
    roots,
    "",
    `Return ONLY a fenced JSON block — an array of tests:`,
    "```json",
    "[",
    '  {"name": "user can sign the guestbook", "code": "…await statements…"},',
    '  {"name": "api returns stored entries", "code": "…"}',
    "]",
    "```",
    "",
    `Each test is an async function body. You can use:`,
    `  - Any wired function via \`ctx.fns.<name>(ctx, …)\` — no stubbing.`,
    `  - \`fs\`, \`path\`, \`http\` namespaces (already imported).`,
    `  - Dynamic \`await import("node:…")\` for other modules.`,
    "",
    `Write 2–5 end-to-end flows that an external observer of the app`,
    `would care about. Think user journeys, not function details.`,
    "",
    `These are PROJECT-LEVEL integration tests — distinct from (and`,
    `complementary to) the per-function unit tests you wrote in phase 2`,
    `and any per-branch integration tests. Focus on whole-app outcomes.`,
    `No prose outside the JSON block.`,
  ].join("\n");
}

function buildBranchIntegrationPrompt(
  parent: PlannedFunction,
  children: PlannedFunction[],
): string {
  const paramList =
    parent.signature.params.length > 0
      ? "ctx: Ctx, " +
        parent.signature.params
          .map((p) => `${p.name}: ${p.type}`)
          .join(", ")
      : "ctx: Ctx";
  const childList = children
    .map(
      (c) =>
        `  - ${c.name}(ctx${c.signature.params.length > 0 ? ", " + c.signature.params.map((p) => `${p.name}: ${p.type}`).join(", ") : ""}): ${c.signature.returnType} — ${c.description}`,
    )
    .join("\n");
  return [
    `Write INTEGRATION TESTS for the assembly of the function below.`,
    "",
    `Parent function (the assembly): ${parent.name}`,
    `Signature: ${parent.signature.isAsync ? "async " : ""}function ${parent.name}(${paramList}): ${parent.signature.returnType}`,
    `Purpose: ${parent.description}`,
    "",
    `Children that compose into ${parent.name}'s body (ALL real, no stubbing):`,
    childList,
    "",
    `Tests run AFTER the parent's body is written with real wired`,
    `children. Exercise the assembly — do not stub children.`,
    "",
    `Return ONLY a fenced JSON block:`,
    "```json",
    "[",
    `  {"name": "orchestrates parse+validate+write", "code": "…await ${parent.name}(ctx, …)…"}`,
    "]",
    "```",
    "",
    `Write 2–5 tests. Each test is an async body. Call ${parent.name}`,
    `directly and assert on its observable outcome. Do NOT reach into`,
    `children via \`ctx.fns.<child>\` directly — the goal is to verify`,
    `the assembly works end-to-end via the parent's interface. Use`,
    `\`fs\`/\`path\`/\`http\` namespaces if needed.`,
    "",
    `These are BRANCH-LEVEL integration tests for this assembly only —`,
    `distinct from per-function unit tests (written elsewhere) and from`,
    `project-wide integration tests (written at the top level).`,
    `No prose outside JSON.`,
  ].join("\n");
}

async function withJsonRetry<T>(
  chat: (p: string) => Promise<string>,
  prompt: string,
  parse: (raw: unknown) => T,
  maxRetries: number,
  phaseLabel: string,
): Promise<T | { error: string }> {
  let lastError = "(no attempt made)";
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug("plan", `${phaseLabel} attempt ${attempt + 1}/${maxRetries + 1}`);
    let response: string;
    try {
      response = await chat(currentPrompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debug("plan", `${phaseLabel} chat error: ${lastError}`);
      break;
    }
    const parsed = extractJson(response);
    if (parsed === null) {
      lastError = "response did not contain valid JSON";
      currentPrompt = `${prompt}\n\nYour previous response was not valid JSON. Return ONLY a fenced JSON block this time.`;
      debug("plan", `${phaseLabel} no JSON extracted, retrying`);
      continue;
    }
    try {
      return parse(parsed);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      currentPrompt = `${prompt}\n\nYour previous response had a schema error: ${lastError}. Fix the shape and return ONLY a fenced JSON block.`;
      debug("plan", `${phaseLabel} schema error: ${lastError}`);
    }
  }
  return { error: lastError };
}

export async function designPlan(
  graph: DesignGraph,
  task: string,
  options: DesignPlanOptions,
): Promise<BuildReport> {
  const maxRetries = options.maxShapeRetries ?? 1;
  const parentName = options.parent;
  debug("plan", `start task=${task.slice(0, 80)}... parent=${parentName ?? "<root>"}`);
  debug(
    "progress",
    `plan: start (task ${task.length}ch)${parentName ? ` parent=${parentName}` : ""}`,
  );

  // ── Phase 1: list functions (skipped on resume) ─────────────────
  // For top-level plans: look for prior plan-origin ROOT functions.
  // For recursive plans (parent set): look for existing children of
  // that parent.
  let parentFn: ReturnType<typeof graph.getFunction> | undefined;
  if (parentName) {
    // Resolve the parent by name (proc-ts names are globally unique).
    for (const f of graph.listFunctions()) {
      if (f.name === parentName) {
        parentFn = f;
        break;
      }
    }
    if (!parentFn) {
      throw new Error(`designPlan: parent function not found: ${parentName}`);
    }
  }

  const prior = parentFn
    ? graph.listChildren(parentName!).filter((f) => f.origin === "plan")
    : graph.listFunctions().filter(
        (f) => f.origin === "plan" && f.parent === null,
      );
  let plannedNames: PlannedFunction[];
  if (prior.length > 0) {
    debug(
      "plan",
      `phase 1 SKIPPED (resume) — ${prior.length} plan-origin functions already present`,
    );
    debug(
      "progress",
      `plan: phase 1 skipped (resume) — ${prior.length} plan-origin functions`,
    );
    plannedNames = prior.map((f) => ({
      module: f.module,
      name: f.name,
      signature: f.signature,
      description: f.description,
    }));
  } else {
    debug("progress", `plan: phase 1 — asking for function list`);
    const parentSummary: PlannedFunction | undefined = parentFn
      ? {
          module: parentFn.module,
          name: parentFn.name,
          signature: parentFn.signature,
          description: parentFn.description,
        }
      : undefined;
    const existingNames = parentFn
      ? graph.listFunctions().map((f) => f.name)
      : [];
    const phase1 = await withJsonRetry(
      options.chat,
      buildPhase1Prompt(task, parentSummary, existingNames),
      parseFunctionList,
      maxRetries,
      "phase1-functions",
    );
    if ("error" in phase1) {
      debug("plan", `phase 1 failed: ${phase1.error}`);
      debug("progress", `plan: phase 1 FAILED — ${phase1.error}`);
      return {
        ok: false,
        phase: "plan",
        consistency: { ok: false, violations: [], advisories: [] },
        dispatched: [],
        failed: [],
        finalize: null,
        files: {},
      };
    }
    debug("plan", `phase 1 produced ${phase1.length} functions`);
    debug(
      "progress",
      `plan: phase 1 ok — ${phase1.length} functions: ${phase1.map((f) => `${f.module}#${f.name}`).join(", ")}`,
    );
    for (const fn of phase1) {
      graph.addModule(fn.module);
      try {
        if (parentName) {
          graph.addFunctionChild(
            parentName,
            fn.module,
            fn.name,
            fn.signature,
            fn.description,
            "plan",
          );
        } else {
          graph.addFunction(
            fn.module,
            fn.name,
            fn.signature,
            fn.description,
            "plan",
          );
        }
      } catch {
        // Already present — skip silently (addTest still works below).
      }
    }
    plannedNames = phase1;
  }

  // ── Phase 2: description + tests per function (per-fn skip on resume) ──
  let testsTotal = 0;
  for (let i = 0; i < plannedNames.length; i++) {
    const fn = plannedNames[i];
    const key = `${fn.module}#${fn.name}`;
    const stored = graph.getFunction(fn.module, fn.name);
    if (stored && stored.tests.length > 0) {
      // Resume: tests already attached from a previous run. Skip the
      // LLM call and count the tests toward the safety gate.
      debug(
        "plan",
        `phase 2 SKIPPED (resume) ${key} — ${stored.tests.length} tests already attached`,
      );
      debug(
        "progress",
        `plan: phase 2 ${i + 1}/${plannedNames.length} skipped ${key} (${stored.tests.length} tests)`,
      );
      testsTotal += stored.tests.length;
      continue;
    }
    debug("progress", `plan: phase 2 ${i + 1}/${plannedNames.length} — ${key}`);
    const phase2 = await withJsonRetry(
      options.chat,
      buildPhase2Prompt(task, fn, plannedNames),
      parseFunctionSpec,
      maxRetries,
      `phase2-spec[${key}]`,
    );
    if ("error" in phase2) {
      debug(
        "plan",
        `phase 2 failed for ${key}: ${phase2.error}; proceeding without tests/description`,
      );
      debug("progress", `plan: phase 2 ${i + 1}/${plannedNames.length} FAILED ${key}`);
      continue;
    }
    debug(
      "plan",
      `phase 2 ${key} → description=${phase2.description.length}ch tests=${phase2.tests.length}`,
    );
    debug(
      "progress",
      `plan: phase 2 ${i + 1}/${plannedNames.length} ok ${key} — ${phase2.tests.length} tests`,
    );
    graph.setDescription(fn.module, fn.name, phase2.description);
    for (const t of phase2.tests) {
      graph.addTest(fn.module, fn.name, t);
      testsTotal++;
    }
  }

  // Safety net 1: if phase 2 failed across the board, don't hand a
  // toothless graph to dispatch (where 0/0 would auto-pass every body).
  if (testsTotal === 0) {
    debug(
      "progress",
      `plan: FAILED — no tests produced across ${plannedNames.length} functions`,
    );
    return {
      ok: false,
      phase: "plan",
      consistency: {
        ok: false,
        violations: [],
        advisories: graph.consistency().advisories,
      },
      dispatched: [],
      failed: [],
      finalize: null,
      files: {},
    };
  }

  // Safety net 2: mixed state — some fns got tests, some didn't.
  // A fn without tests AND without a pre-loaded body would get
  // dispatched with allowUntested + hasTests=false, yielding 0/0 =
  // auto-pass — producing unverified code. Abort loud instead.
  const untested: string[] = [];
  for (const fn of plannedNames) {
    const stored = graph.getFunction(fn.module, fn.name);
    if (!stored) continue;
    if (stored.tests.length === 0 && stored.implementation === null) {
      untested.push(`${fn.module}#${fn.name}`);
    }
  }
  if (untested.length > 0) {
    debug(
      "progress",
      `plan: FAILED — ${untested.length} functions without tests: ${untested.join(", ")}`,
    );
    return {
      ok: false,
      phase: "plan",
      consistency: {
        ok: false,
        violations: [],
        advisories: graph.consistency().advisories,
      },
      dispatched: [],
      failed: [],
      finalize: null,
      files: {},
    };
  }

  // ── Phase 2b: integration tests ─────────────────────────────────
  // For a subtree plan: ask for integration tests that exercise the
  // parent assembly through its real wired children. Attach to parent.
  // For a top-level plan: ask for PROJECT integration tests exercising
  // the whole app. Attach to graph.projectTests.
  // Skip entirely on resume when the target already has integration
  // tests — re-running would duplicate them.
  if (parentName) {
    const existing = parentFn!.integrationTests?.length ?? 0;
    if (existing > 0) {
      debug(
        "plan",
        `phase 2b SKIPPED (resume) — ${parentName} already has ${existing} integration tests`,
      );
      debug(
        "progress",
        `plan: phase 2b skipped (resume) for ${parentName} — ${existing} integration tests`,
      );
    } else {
      debug("progress", `plan: phase 2b — branch integration tests for ${parentName}`);
      const branchSpec = await withJsonRetry(
        options.chat,
        buildBranchIntegrationPrompt(
          {
            module: parentFn!.module,
            name: parentFn!.name,
            signature: parentFn!.signature,
            description: parentFn!.description,
          },
          plannedNames,
        ),
        parseIntegrationTestList,
        maxRetries,
        `phase2b-integration[${parentName}]`,
      );
      if ("error" in branchSpec) {
        debug(
          "plan",
          `phase 2b failed for ${parentName}: ${branchSpec.error}; proceeding without integration tests`,
        );
        debug(
          "progress",
          `plan: phase 2b FAILED for ${parentName} — continuing without integration tests`,
        );
      } else {
        debug(
          "plan",
          `phase 2b ${parentName} → ${branchSpec.length} integration tests`,
        );
        debug(
          "progress",
          `plan: phase 2b ok for ${parentName} — ${branchSpec.length} integration tests`,
        );
        for (const t of branchSpec) {
          graph.addIntegrationTest(parentFn!.module, parentFn!.name, t);
        }
      }
    }
  } else {
    const existing = graph.listProjectTests().length;
    if (existing > 0) {
      debug(
        "plan",
        `phase 2b SKIPPED (resume) — project already has ${existing} integration tests`,
      );
      debug(
        "progress",
        `plan: phase 2b skipped (resume) for project — ${existing} integration tests`,
      );
    } else {
      debug("progress", `plan: phase 2b — project integration tests`);
      const projectSpec = await withJsonRetry(
        options.chat,
        buildProjectIntegrationPrompt(task, plannedNames),
        parseIntegrationTestList,
        maxRetries,
        "phase2b-integration[project]",
      );
      if ("error" in projectSpec) {
        debug(
          "plan",
          `phase 2b failed for project: ${projectSpec.error}; proceeding without integration tests`,
        );
        debug(
          "progress",
          `plan: phase 2b FAILED for project — continuing without integration tests`,
        );
      } else {
        debug(
          "plan",
          `phase 2b project → ${projectSpec.length} integration tests`,
        );
        debug(
          "progress",
          `plan: phase 2b ok for project — ${projectSpec.length} integration tests`,
        );
        for (const t of projectSpec) {
          graph.addProjectTest(t);
        }
      }
    }
  }

  // ── Phase 3: mechanical build (skipped for sub-tree plans) ──────
  if (parentName) {
    // Recursive call — children are now declared + tested; the outer
    // dispatch loop will pick them up depth-first. Return a plan-only
    // success report so the caller knows the subtree is ready.
    debug(
      "plan",
      `phase 3 skipped — subtree plan under ${parentName} complete (${testsTotal} tests, ${plannedNames.length} children)`,
    );
    debug(
      "progress",
      `plan: subtree under ${parentName} planned — ${testsTotal} tests, ${plannedNames.length} children`,
    );
    return {
      ok: true,
      phase: "plan",
      consistency: graph.consistency(),
      dispatched: [],
      failed: [],
      finalize: null,
      files: {},
    };
  }

  debug(
    "plan",
    `handing off to designBuild (${testsTotal} tests across ${plannedNames.length} functions)`,
  );
  debug(
    "progress",
    `plan: handoff to build — ${testsTotal} tests, ${plannedNames.length} functions`,
  );
  return designBuild(graph, {
    dispatch: options.dispatch,
    finalize: options.finalize,
    allowUntested: true,
  });
}
