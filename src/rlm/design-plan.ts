/**
 * Multi-turn planner for a user task.
 *
 * The Architect writes a function list and a per-function SPEC — the
 * contract the Implementer will satisfy. Tests are NOT written here:
 * the Implementer derives both unit and integration tests from the
 * spec so that the agent closest to the code owns its test contract.
 *
 * Turns:
 *   1. "List the functions needed." → [{module, name, signature, description}]
 *   2. Per function: "Fill the spec template." → FunctionSpec
 *   3. designBuild runs; each dispatched Implementer writes tests + body.
 */

import type {
  DesignGraph,
  FunctionSpec,
  ProjectConfig,
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

/**
 * Parse the Architect's phase-0 package.json. Validates JSON shape,
 * requires `devDependencies` with exactly ONE of `vitest` / `jest` —
 * neither or both trips a retry with a clear error message.
 */
export function parsePackageJson(raw: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "module") {
    throw new Error(
      'package.json must set "type": "module" (the proc-ts emitter produces ESM code)',
    );
  }
  const dev = obj.devDependencies;
  if (!dev || typeof dev !== "object" || Array.isArray(dev)) {
    throw new Error('package.json missing "devDependencies" object');
  }
  const hasVitest = "vitest" in (dev as Record<string, unknown>);
  const hasJest = "jest" in (dev as Record<string, unknown>);
  if (hasVitest && hasJest) {
    throw new Error(
      'devDependencies lists BOTH "vitest" and "jest" — pick exactly one test framework',
    );
  }
  if (!hasVitest && !hasJest) {
    throw new Error(
      'devDependencies must include exactly one of "vitest" or "jest" as the test framework',
    );
  }
  return {
    packageJson: raw,
    testFramework: hasVitest ? "vitest" : "jest",
  };
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

/**
 * Return the raw (unparsed) body of the first fenced JSON block, or the
 * whole response. Preserves formatting — needed for phase 0's
 * package.json where we want to write the LLM's exact text to disk.
 */
function extractRawJson(response: string): string | null {
  const fenced = response.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : response.trim();
  if (!body) return null;
  // Validate shape without throwing — we just want to ensure the LLM
  // at least emitted parseable JSON; full shape validation happens in
  // parsePackageJson.
  try {
    JSON.parse(body);
  } catch {
    return null;
  }
  return body;
}

/**
 * Parse the LLM's function list.
 *
 * `moduleOverride` — when set, the caller owns the module path (e.g.
 * decompose sub-plans inherit the parent's module). The LLM's `module`
 * field is ignored; missing is fine. Otherwise the top-level path
 * requires `module` on every entry.
 */
/** Hard cap on the number of children a decompose sub-plan can produce.
 *  The prompt asks for 2–5; this is the ceiling we enforce mechanically. */
export const MAX_DECOMPOSE_CHILDREN = 7;

export function parseFunctionList(
  raw: unknown,
  moduleOverride?: string,
): PlannedFunction[] {
  if (!Array.isArray(raw)) {
    throw new Error("function list must be a JSON array");
  }
  if (moduleOverride !== undefined && raw.length > MAX_DECOMPOSE_CHILDREN) {
    throw new Error(
      `decompose produced ${raw.length} children — cap is ${MAX_DECOMPOSE_CHILDREN}. Return fewer, more focused children.`,
    );
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`entry ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    const module =
      moduleOverride ??
      (typeof r.module === "string"
        ? r.module
        : (() => {
            throw new Error(`entry ${i} missing "module"`);
          })());
    // Module paths are project-relative. An empty string, an absolute
    // path, or a `..` segment signals a malformed entry (typically
    // an LLM hallucination). The override path comes from our own
    // code and is trusted, so only validate when we're reading the
    // LLM's emission.
    if (moduleOverride === undefined) {
      if (module.length === 0) {
        throw new Error(`entry ${i} has empty "module"`);
      }
      if (module.startsWith("/")) {
        throw new Error(`entry ${i} module path "${module}" is absolute — must be project-relative`);
      }
      if (module.split("/").includes("..")) {
        throw new Error(`entry ${i} module path "${module}" escapes the project (contains ..)`);
      }
    }
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
      module,
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

/**
 * Render an example value as a string. Plain strings pass through;
 * objects/arrays/numbers/booleans are JSON-stringified so downstream
 * prompts show meaningful content instead of "[object Object]".
 */
function stringifyExampleValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Parse the Architect's structured spec for one function.
 *
 * Signature-driven: the LLM authors ONLY descriptions for inputs and
 * output — `name` and `type` are copied from the function's signature.
 * This removes an entire class of drift bugs (LLM's phase-2 types
 * disagreeing with phase-1 signature).
 *
 * Expected LLM shape:
 *   inputs: string[]  // one description per signature.params entry, aligned by index
 *   output: string    // description of the return value
 */
export function parseFunctionSpec(
  raw: unknown,
  signature: Signature,
): FunctionSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("spec must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const requireStr = (k: string): string => {
    if (typeof r[k] !== "string" || (r[k] as string).trim().length === 0) {
      throw new Error(`spec missing non-empty "${k}"`);
    }
    return r[k] as string;
  };
  const requireStrArray = (k: string): string[] => {
    if (!Array.isArray(r[k])) throw new Error(`spec "${k}" must be an array`);
    return (r[k] as unknown[]).map((v, i) => {
      if (typeof v !== "string") throw new Error(`spec ${k}[${i}] must be string`);
      return v;
    });
  };
  if (!Array.isArray(r.inputs)) {
    throw new Error('spec "inputs" must be an array of description strings');
  }
  const rawInputs = r.inputs as unknown[];
  if (rawInputs.length !== signature.params.length) {
    throw new Error(
      `spec "inputs" must have ${signature.params.length} entries (one per signature param), got ${rawInputs.length}`,
    );
  }
  const inputs = signature.params.map((p, i) => {
    const desc = rawInputs[i];
    return {
      name: p.name,
      type: p.type,
      description: typeof desc === "string" ? desc : "",
    };
  });
  if (typeof r.output !== "string" || r.output.trim().length === 0) {
    throw new Error(
      'spec missing non-empty string "output" (return-value description)',
    );
  }
  const examples = Array.isArray(r.examples) ? r.examples : [];
  return {
    purpose: requireStr("purpose"),
    inputs,
    output: {
      type: signature.returnType,
      description: r.output,
    },
    sideEffects: requireStrArray("sideEffects"),
    dependencies: requireStrArray("dependencies"),
    edgeCases: requireStrArray("edgeCases"),
    examples: examples.map((v, i) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`spec examples[${i}] must be an object`);
      }
      const vi = v as Record<string, unknown>;
      return {
        input: stringifyExampleValue(vi.input),
        output: stringifyExampleValue(vi.output),
      };
    }),
  };
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
      `  module: ${parent.module}`,
      `  name: ${parent.name}`,
      `  signature: ${parent.signature.isAsync ? "async " : ""}function ${parent.name}(${paramList}): ${parent.signature.returnType}`,
      `  purpose: ${parent.description}`,
      ...existingBlock,
      "",
      `Return ONLY a fenced JSON block listing the NEW children. Each child:`,
      "  - name: string (function name, camelCase, globally unique,",
      "    NOT already in the existing-functions list above)",
      "  - signature: { params: [{name, type}], returnType, isAsync? }",
      "  - description: string (one-line purpose within the assembly)",
      "",
      "**IMPORTANT**:",
      "- Do NOT emit a `module` field. The harness places every child in",
      `  the parent's module (${parent.module}) automatically — any module`,
      "  string you supply is discarded.",
      "- The `params` array must NOT include `ctx: Ctx` — the harness",
      "  injects it automatically as the first parameter. Only list",
      "  BUSINESS params (e.g. `req`, `entries`, `path`).",
      "",
      "The children should compose cleanly: the parent's body will call",
      `each child via \`ctx.fns.<child>(ctx, ...)\`. Write 2–5 children`,
      `focused on distinct concerns (hard cap: ${MAX_DECOMPOSE_CHILDREN}).`,
      "Do NOT include the parent itself. No prose outside the JSON block.",
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
    `Fill in the SPEC for the following function. You are the ARCHITECT.`,
    `You are NOT writing tests — the Implementer who later builds this`,
    `function will derive both unit AND integration tests from your spec.`,
    `Your job is the contract: purpose, inputs, outputs, side effects,`,
    `dependencies, edge cases, and concrete examples.`,
    "",
    `Parent task (the whole application):`,
    task,
    "",
    `Function: ${fn.name}`,
    `Signature: ${sigStr}`,
    `Initial description: ${fn.description}`,
    "",
    siblingList
      ? `Other functions in the project (this function MAY call any of these via ctx.fns; list them under "dependencies" if it does):\n${siblingList}`
      : "No sibling functions.",
    "",
    `HARD REQUIREMENT — "inputs" MUST be EXACTLY ${fn.signature.params.length} description string${fn.signature.params.length === 1 ? "" : "s"}, aligned with this signature's parameters in order:`,
    fn.signature.params.length === 0
      ? `  (this function has ZERO parameters — emit "inputs": [])`
      : fn.signature.params
          .map((p, i) => `  index ${i}: ${p.name} (${p.type})`)
          .join("\n"),
    `Do NOT include ctx or any wrapping envelope — only the business parameters above. Extra or missing entries cause a schema error and a retry.`,
    "",
    `Return ONLY a fenced JSON block with EXACTLY this shape. Every field`,
    `is required; arrays can be empty but must be present.`,
    "",
    "```json",
    "{",
    '  "purpose": "One paragraph: what this function does and why it exists in the assembly.",',
    `  "inputs": [${fn.signature.params
      .map((p) => `"<description of ${p.name}: ${p.type}>"`)
      .join(", ")}],`,
    '  "output": "what is returned, shape, meaning",',
    '  "sideEffects": ["describe each observable side effect — file I/O, HTTP, state mutation, throws on X"],',
    '  "dependencies": ["<sibling function names this one calls via ctx.fns — empty if pure>"],',
    '  "edgeCases": ["enumerate boundary / error / invariant cases the Implementer MUST cover with tests"],',
    '  "examples": [',
    '    {"input": "human-readable input description", "output": "human-readable expected output"}',
    "  ]",
    "}",
    "```",
    "",
    `Guidelines:`,
    `- \`inputs\` is an array of DESCRIPTION STRINGS — one per signature`,
    `  parameter, in order. The harness pulls \`name\` and \`type\` from the`,
    `  signature; do NOT repeat them. Length must be exactly`,
    `  ${fn.signature.params.length}.`,
    `- \`output\` is a single DESCRIPTION STRING. The \`type\` is already`,
    `  known from the signature; do NOT repeat it.`,
    `- Be concrete. "handles errors" is useless; "throws TypeError when path is not string"`,
    `  is testable.`,
    `- "dependencies" lists ONLY siblings this function will DEFINITELY call.`,
    `  Do NOT list every sibling that MIGHT be useful — that bloats the`,
    `  Implementer's prompt and will either trigger architect-review`,
    `  feedback for "declared but never called" OR be auto-overwritten`,
    `  when we reconcile from the observed ctx.fns call sites. Unknown`,
    `  names are dropped at store time; if you're uncertain, omit.`,
    `- Write 2–6 edge cases and 1–4 examples.`,
    `- No prose outside the JSON block.`,
  ].join("\n");
}

function buildPhase0Prompt(task: string): string {
  return [
    `Phase 0 of the pipeline — project initialization.`,
    "",
    `Your job: fill in this package.json template for the project described`,
    `in the task. The harness reads it to pick the test framework and to`,
    `emit the file verbatim at materialize time.`,
    "",
    `Task:`,
    task,
    "",
    `Fill in this package.json template. Rules:`,
    `  - pick EXACTLY ONE test framework — add either "vitest" OR "jest"`,
    `    to devDependencies. Never both; never neither.`,
    `  - "scripts.test" must invoke the chosen framework ("vitest run" or`,
    `    "jest").`,
    `  - "type" must be "module".`,
    `  - Fill runtime dependencies as needed for the project. Keep them`,
    `    minimal — dev-only helpers go in devDependencies.`,
    `  - "name" should be kebab-case, derived from the task.`,
    "",
    "Return ONLY a fenced JSON block with your filled-in package.json:",
    "",
    "```json",
    "{",
    '  "name": "<kebab-case>",',
    '  "version": "0.1.0",',
    '  "description": "<one-line purpose>",',
    '  "type": "module",',
    '  "scripts": {',
    '    "test": "<test runner CLI>"',
    "  },",
    '  "dependencies": { },',
    '  "devDependencies": { }',
    "}",
    "```",
    "",
    "No prose outside the fenced block.",
  ].join("\n");
}

async function runPhase0(
  chat: (p: string) => Promise<string>,
  task: string,
  maxRetries: number,
): Promise<ProjectConfig | { error: string }> {
  const basePrompt = buildPhase0Prompt(task);
  let currentPrompt = basePrompt;
  let lastError = "(no attempt made)";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug("plan", `phase0-init attempt ${attempt + 1}/${maxRetries + 1}`);
    let response: string;
    try {
      response = await chat(currentPrompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debug("plan", `phase0-init chat error: ${lastError}`);
      break;
    }
    const raw = extractRawJson(response);
    if (raw === null) {
      lastError = "response did not contain a parseable JSON block";
      currentPrompt = `${basePrompt}\n\nYour previous response was not valid JSON. Return ONLY a fenced JSON block this time.`;
      debug("plan", `phase0-init no JSON extracted, retrying`);
      continue;
    }
    try {
      return parsePackageJson(raw);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      currentPrompt = `${basePrompt}\n\nYour previous response had a package.json error: ${lastError}. Fix it and return ONLY a fenced JSON block.`;
      debug("plan", `phase0-init package.json error: ${lastError}`);
    }
  }
  return { error: lastError };
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

  // ── Phase 0: project init — Architect fills package.json ─────────
  // Only at the root plan. Subtree plans (parentName set) inherit the
  // project config from the parent graph. Skipped on resume if a
  // config was already stored.
  if (!parentName && graph.getProjectConfig() === null) {
    debug("progress", `plan: phase 0 — asking for package.json`);
    const phase0 = await runPhase0(options.chat, task, maxRetries);
    if ("error" in phase0) {
      debug("plan", `phase 0 failed: ${phase0.error}`);
      debug("progress", `plan: phase 0 FAILED — ${phase0.error}`);
      return {
        ok: false,
        phase: "plan",
        consistency: { ok: false, violations: [], advisories: [] },
        dispatched: [],
        failed: [],
        finalize: null,
        files: {},
        failedSpecs: [],
      };
    }
    debug(
      "plan",
      `phase 0 ok — testFramework=${phase0.testFramework}`,
    );
    debug(
      "progress",
      `plan: phase 0 ok — test framework = ${phase0.testFramework}`,
    );
    graph.setProjectConfig(phase0);
  } else if (!parentName) {
    debug(
      "plan",
      `phase 0 SKIPPED (resume) — projectConfig already set: testFramework=${graph.getProjectConfig()!.testFramework}`,
    );
    debug(
      "progress",
      `plan: phase 0 skipped (resume) — framework = ${graph.getProjectConfig()!.testFramework}`,
    );
  }

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
    const moduleOverride = parentFn?.module;
    const phase1 = await withJsonRetry(
      options.chat,
      buildPhase1Prompt(task, parentSummary, existingNames),
      (raw) => parseFunctionList(raw, moduleOverride),
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
      } catch (e) {
        // Only silent-skip exact-duplicate (same module+name) — that's
        // a legitimate resume. Everything else (cross-module name
        // collision, invalid identifier, reserved name, missing parent)
        // is a real planning error and must surface.
        const msg = e instanceof Error ? e.message : String(e);
        if (/^duplicate function:/.test(msg)) {
          continue;
        }
        debug(
          "plan",
          `phase 1 add failed for ${fn.module}#${fn.name}: ${msg}`,
        );
        debug(
          "progress",
          `plan: phase 1 FAILED adding ${fn.module}#${fn.name} — ${msg}`,
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
    }
    plannedNames = phase1;
  }

  // ── Phase 2: Architect fills the SPEC for each function ────────
  // The spec becomes the Implementer's contract. Tests are written
  // later, by the Implementer, during dispatch.
  let specsAttached = 0;
  const failedSpecs: string[] = [];
  for (let i = 0; i < plannedNames.length; i++) {
    const fn = plannedNames[i];
    const key = `${fn.module}#${fn.name}`;
    const stored = graph.getFunction(fn.module, fn.name);
    if (stored && stored.spec !== null) {
      debug("plan", `phase 2 SKIPPED (resume) ${key} — spec already attached`);
      debug(
        "progress",
        `plan: phase 2 ${i + 1}/${plannedNames.length} skipped ${key} (spec already attached)`,
      );
      specsAttached++;
      continue;
    }
    debug("progress", `plan: phase 2 ${i + 1}/${plannedNames.length} — ${key}`);
    // Use the graph's normalized signature (isAsync/Promise reconciled
    // at ingest) rather than the raw phase-1 claim, so both the prompt
    // display AND the spec parser see the canonical shape.
    const normalizedFn: PlannedFunction = stored
      ? {
          module: stored.module,
          name: stored.name,
          signature: stored.signature,
          description: stored.description,
        }
      : fn;
    // Sibling list: EVERY function in the graph (except the target).
    // During decompose this includes top-level roots + the parent, not
    // just co-children — critical so the LLM can list top-level deps.
    const siblingsForPrompt: PlannedFunction[] = graph
      .listFunctions()
      .filter((f) => f.name !== normalizedFn.name)
      .map((f) => ({
        module: f.module,
        name: f.name,
        signature: f.signature,
        description: f.description,
      }));
    const phase2 = await withJsonRetry(
      options.chat,
      buildPhase2Prompt(task, normalizedFn, siblingsForPrompt),
      (raw) => parseFunctionSpec(raw, normalizedFn.signature),
      maxRetries,
      `phase2-spec[${key}]`,
    );
    if ("error" in phase2) {
      debug("plan", `phase 2 failed for ${key}: ${phase2.error}`);
      debug(
        "progress",
        `plan: phase 2 ${i + 1}/${plannedNames.length} FAILED ${key} — proceeding without spec`,
      );
      failedSpecs.push(key);
      continue;
    }
    // Filter spec.dependencies against the graph — the LLM sometimes
    // hallucinates sibling names. Unknown entries would pollute the
    // Implementer prompt ("depends on foo") for a sibling that isn't
    // wired into ctx.fns, producing a runtime TypeError at test time.
    const knownNames = new Set(graph.listFunctions().map((f) => f.name));
    const unknownDeps = phase2.dependencies.filter((d) => !knownNames.has(d));
    if (unknownDeps.length > 0) {
      debug(
        "plan",
        `phase 2 ${key} — dropping unknown deps: ${unknownDeps.join(", ")}`,
      );
      debug(
        "progress",
        `plan: phase 2 ${key} — dropped unknown deps: ${unknownDeps.join(", ")}`,
      );
      phase2.dependencies = phase2.dependencies.filter((d) => knownNames.has(d));
    }
    debug(
      "plan",
      `phase 2 ${key} → purpose=${phase2.purpose.length}ch deps=${phase2.dependencies.length} edges=${phase2.edgeCases.length}`,
    );
    debug(
      "progress",
      `plan: phase 2 ${i + 1}/${plannedNames.length} ok ${key} — ${phase2.dependencies.length} deps, ${phase2.edgeCases.length} edge cases`,
    );
    graph.setSpec(fn.module, fn.name, phase2);
    specsAttached++;
  }

  // Safety net: every planned function must have a spec. The
  // Implementer refuses to build without one.
  if (specsAttached === 0) {
    debug(
      "progress",
      `plan: FAILED — no specs produced across ${plannedNames.length} functions`,
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
      failedSpecs,
    };
  }

  // ── Phase 2b removed ─────────────────────────────────────────────
  // Integration-test writing moved out of the Architect. Each
  // Implementer writes both unit AND integration tests for its own
  // function (informed by the spec and by the list of siblings its
  // spec declares as dependencies). Project-level tests are no longer
  // emitted by the planner.

  // ── Phase 3: mechanical build (skipped for sub-tree plans) ──────
  if (parentName) {
    // Recursive call — children are now declared + tested; the outer
    // dispatch loop will pick them up depth-first. Return a plan-only
    // success report so the caller knows the subtree is ready.
    debug(
      "plan",
      `phase 3 skipped — subtree plan under ${parentName} complete (${specsAttached} specs, ${plannedNames.length} children)`,
    );
    debug(
      "progress",
      `plan: subtree under ${parentName} planned — ${specsAttached} specs, ${plannedNames.length} children`,
    );
    return {
      ok: true,
      phase: "plan",
      consistency: graph.consistency(),
      dispatched: [],
      failed: [],
      finalize: null,
      files: {},
      failedSpecs,
    };
  }

  debug(
    "plan",
    `handing off to designBuild (${specsAttached} specs across ${plannedNames.length} functions, ${failedSpecs.length} specless)`,
  );
  debug(
    "progress",
    `plan: handoff to build — ${specsAttached} specs, ${plannedNames.length} functions, ${failedSpecs.length} specless`,
  );
  const buildReport = await designBuild(graph, {
    dispatch: options.dispatch,
    finalize: options.finalize,
    allowUntested: true,
  });
  if (failedSpecs.length > 0) {
    buildReport.failedSpecs = failedSpecs;
  }
  return buildReport;
}
