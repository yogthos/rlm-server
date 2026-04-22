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
  ProjectDecisions,
  Signature,
  TestSpec,
} from "./design-graph.js";
import { designBuild, type BuildReport, type BuildOptions } from "./design-build.js";
import { renderDecompositionRules } from "./decomposition-rules.js";
import { debug } from "./debug.js";

export interface DesignPlanOptions {
  chat: (prompt: string) => Promise<string>;
  dispatch?: BuildOptions["dispatch"];
  finalize?: BuildOptions["finalize"];
  /** How many times to retry each JSON phase when shape validation fails. */
  maxShapeRetries?: number;
  /** Plan the children of an EXISTING function rather than top-level
   *  functions for the task. When set, phase 1 lists CHILDREN of this
   *  function; phase 2 writes integration tests for each child's role
   *  in the parent's assembly; phase 3 (build) is SKIPPED — the
   *  caller decides when to dispatch. */
  parent?: string;
  /** When true, return after phase 2 (specs attached) without calling
   *  `designBuild`. Used by the integration orchestrator which runs
   *  its own leaf-up build pass afterwards. */
  skipBuild?: boolean;
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

/**
 * Return the raw (unparsed) body of the first fenced JSON block, or the
 * whole response. Preserves formatting — needed for phase 0's
 * package.json where we want to write the LLM's exact text to disk.
 */
/** Extract the contents of a ```testing-notes fence from a phase-0
 *  response, or null if absent. Retained for backward compatibility
 *  with any legacy flow that still emits testing-notes as a separate
 *  fence. New code paths use `parsePhase0Response` which reads
 *  `testingNotes` from the structured `decisions` block instead. */
export function extractTestingNotes(response: string): string | null {
  const m = response.match(/```testing-notes\s*\r?\n([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
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

function renderExistingFunction(fn: PlannedFunction): string {
  const params = fn.signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const asyncMark = fn.signature.isAsync ? "async " : "";
  const sig = `${asyncMark}${fn.name}(${params}): ${fn.signature.returnType}`;
  const desc = fn.description ? ` — ${fn.description}` : "";
  return `  - ${fn.module}#${sig}${desc}`;
}

function buildPhase1Prompt(
  task: string,
  parent?: PlannedFunction,
  existingFunctions: PlannedFunction[] = [],
): string {
  if (parent) {
    const paramList = parent.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    const existingBlock =
      existingFunctions.length > 0
        ? [
            "",
            `Functions already in the project (names are GLOBALLY UNIQUE —`,
            `do NOT reuse any of these names for a new child; pick a`,
            `distinct name. You CAN reference them from inside the parent's`,
            `body by importing them directly (\`import <name> from "./<name>.js"\`)`,
            `without declaring them as children):`,
            ...existingFunctions.map(renderExistingFunction),
          ]
        : [];
    return [
      `A function's tests didn't converge after repeated implementation`,
      `attempts. You're being asked to consider splitting it into`,
      `children — but first, judge whether splitting is the right move.`,
      "",
      `Parent task (the whole application's goal):`,
      task,
      "",
      `Parent function:`,
      `  module: ${parent.module}`,
      `  name: ${parent.name}`,
      `  signature: ${parent.signature.isAsync ? "async " : ""}function ${parent.name}(${paramList}): ${parent.signature.returnType}`,
      `  purpose: ${parent.description}`,
      ...existingBlock,
      "",
      `When to RETURN AN EMPTY ARRAY (decline to split):`,
      `  - The function wraps a single Node built-in — e.g. \`path.join\`,`,
      `    \`process.cwd\`, \`fs.existsSync\`, a single regex. Splitting`,
      `    into "detectSeparator / normalizeSeparators / combinePath" is`,
      `    worse than the built-in itself.`,
      `  - The function is <30 lines of straightforward logic. More,`,
      `    smaller children often fail for the same reasons the parent`,
      `    failed, compounding the problem.`,
      `  - The failing tests look wrong for the spec (e.g. asserting`,
      `    behavior the spec doesn't promise), OR a sibling's return`,
      `    shape is mismatched with what this function expects. In`,
      `    those cases the bug is NOT lack of decomposition.`,
      "",
      `When to SPLIT:`,
      `  - The function genuinely coordinates 2+ distinct concerns that`,
      `    could each be 15+ lines (e.g. "read request body" vs "parse`,
      `    form-encoded data" vs "validate required fields" — three`,
      `    clearly separable steps).`,
      `  - A child would be independently testable and useful.`,
      "",
      ...renderDecompositionRules(),
      "",
      `Return ONLY a fenced JSON block — an array (possibly EMPTY). If`,
      `you split, each child:`,
      "  - name: string (function name, camelCase, globally unique,",
      "    NOT already in the existing-functions list above)",
      "  - signature: { params: [{name, type}], returnType, isAsync? }",
      "  - description: string (one-line purpose within the assembly)",
      "",
      "**IMPORTANT**:",
      "- Do NOT emit a `module` field. The harness places every child in",
      `  the parent's module (${parent.module}) automatically.`,
      "- `params` is the function's FULL signature. List only what the",
      "  caller actually passes — no framework arguments.",
      "",
      `Prefer 0 children over forced splits. If splitting, 2–4 is typical;`,
      `hard cap ${MAX_DECOMPOSE_CHILDREN}. Do NOT include the parent itself.`,
      `No prose outside the JSON block.`,
    ].join("\n");
  }
  const existingBlock =
    existingFunctions.length > 0
      ? [
          "",
          "Functions ALREADY in the graph (names are globally unique — do",
          "NOT re-propose any of these; you can reference them from any",
          "new function's body by importing directly (`import <name> from",
          '"./<name>.js"`) without declaring a dependency). Plan only',
          "what's MISSING:",
          ...existingFunctions.map(renderExistingFunction),
        ]
      : [];
  return [
    `Your job is to list the top-level functions needed to complete this task:`,
    "",
    task,
    "",
    "These are the roots of the project's call tree. Each becomes its own",
    "TypeScript file; an Architect at dispatch time may later decompose any",
    "of them into children if too complex.",
    "",
    ...renderDecompositionRules(),
    ...existingBlock,
    "",
    "Return ONLY a fenced JSON block. The value must be an array of objects",
    "with these exact fields:",
    "  - module: string (file path, e.g. `src/server.js`; use `.js` for pure",
    "    Node, `.ts` for TypeScript)",
    "  - name: string (function name, camelCase, globally unique)",
    "  - signature: { params: [{name, type}], returnType, isAsync? }",
    "  - description: string (one-line purpose in the overall assembly)",
    "",
    "**IMPORTANT**: `params` is the function's FULL signature. List",
    "only what the caller passes — e.g. `path`, `req`, `entries`. No",
    "framework-injected arguments; the harness doesn't add any.",
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
  const paramList = fn.signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const sigStr = `${fn.signature.isAsync ? "async " : ""}function ${fn.name}(${paramList}): ${fn.signature.returnType}`;
  const siblingList = siblings
    .filter((s) => !(s.module === fn.module && s.name === fn.name))
    .map((s) => `  - ${s.name}: ${s.description}`)
    .join("\n");
  return [
    `Fill in the SPEC for the following function. You are the ARCHITECT.`,
    `You are NOT writing tests — the Implementer who later builds this`,
    `function will derive both unit AND integration tests from your spec.`,
    `Your job is the CONTRACT — not the implementation plan.`,
    "",
    `State WHAT the function must do (purpose, I/O shape, observable`,
    `effects). Do NOT state HOW it should do it. Leave algorithm choice,`,
    `data-structure choice, control-flow, and helper extraction to the`,
    `Implementer. They see the full context (siblings, tests) and will`,
    `choose the shape that actually works.`,
    "",
    `Edge cases are SUGGESTIONS, not mandates. If you list an edge case,`,
    `the Implementer should cover it with a test — but only when the`,
    `spec's purpose/output genuinely promises that behavior. Listing`,
    `every conceivable failure mode ("must handle null, undefined,`,
    `malformed input, truncated streams, ...") creates over-strict tests`,
    `that stagnate dispatch. Prefer 2–4 edge cases that reflect REAL`,
    `invariants the consumer of this function relies on.`,
    "",
    `Parent task (the whole application):`,
    task,
    "",
    `Function: ${fn.name}`,
    `Signature: ${sigStr}`,
    `Initial description: ${fn.description}`,
    "",
    siblingList
      ? `Other functions in the project (this function MAY import and call any of these; list them under "dependencies" if it does):\n${siblingList}`
      : "No sibling functions.",
    "",
    `HARD REQUIREMENT — "inputs" MUST be EXACTLY ${fn.signature.params.length} description string${fn.signature.params.length === 1 ? "" : "s"}, aligned with this signature's parameters in order:`,
    fn.signature.params.length === 0
      ? `  (this function has ZERO parameters — emit "inputs": [])`
      : fn.signature.params
          .map((p, i) => `  index ${i}: ${p.name} (${p.type})`)
          .join("\n"),
    `Only the declared parameters — no framework envelope. Extra or missing entries cause a schema error and a retry.`,
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
    '  "dependencies": ["<sibling function names this one imports and calls — empty if pure>"],',
    '  "edgeCases": ["2–4 invariants the CONSUMER relies on — the implementer will write tests only for those the purpose/output genuinely promises"],',
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
    `  when we reconcile from the observed imports+calls. Unknown`,
    `  names are dropped at store time; if you're uncertain, omit.`,
    `- Write 2–6 edge cases and 1–4 examples.`,
    `- No prose outside the JSON block.`,
  ].join("\n");
}

function buildPhase0Prompt(task: string): string {
  const nodeVersion = process.version; // e.g. "v25.9.0"
  return [
    `Phase 0 — project initialization.`,
    "",
    `You commit to the runtime + tooling shape of this TypeScript`,
    `project. The harness owns ONLY two conventions: every function is`,
    `one default-exported \`function <name>(<params>): <ret>\` per file,`,
    `and siblings are called by direct import (\`import <name> from`,
    ` "./<name>.js"\`). EVERY other decision — runtime, test framework,`,
    `module system, package manager, assertion / mocking strategy —`,
    `is yours. The decisions you record here are injected into every`,
    `later Implementer / Architect prompt so the whole pipeline speaks`,
    `your chosen stack.`,
    "",
    `Host environment (this is where the project WILL be built and run):`,
    `  Node.js: ${nodeVersion}`,
    `  Platform: ${process.platform} / ${process.arch}`,
    "",
    `When pinning dependencies in your package.json, pick versions`,
    `that support ${nodeVersion}. This matters especially for NATIVE`,
    `modules (anything using node-gyp / prebuild-install — e.g.`,
    `better-sqlite3, bcrypt, sharp, sqlite3). Native-module major`,
    `versions often drop support for older Node or add support for`,
    `newer Node in distinct releases; picking a version below the`,
    `floor required for the host Node will fail to build on install`,
    `with cryptic C++ compile errors about V8 API changes. When in`,
    `doubt, pick the LATEST stable major of a native module — it's`,
    `almost always the one that supports current Node.`,
    "",
    `Task:`,
    task,
    "",
    `Return THREE fenced blocks in this order:`,
    "",
    `1. \`\`\`decisions — a JSON object with the shape below. Fields are`,
    `   free-form strings; pick whatever values fit the task. The`,
    `   harness doesn't validate against an allowlist.`,
    "",
    `   {`,
    `     "runtime":        "node" | "deno" | "bun" | ...,`,
    `     "moduleSystem":   "esm" | "cjs" | "(n/a)",`,
    `     "testFramework":  "vitest" | "jest" | "mocha" | "node:test" | "deno:test" | ...,`,
    `     "testCommand":    <CLI for the FULL test suite (integration/finalize phase), including a TAP reporter flag>,`,
    `     "singleTestCommand": <CLI template for ONE test file — must contain the literal token {file}, which the harness substitutes with "<functionName>.test.ts" per dispatch>,`,
    `     "testImports":    <literal import line(s) every test file must include>,`,
    `     "packageManager": "npm" | "pnpm" | "yarn" | "bun" | "(none)",`,
    `     "mockingStrategy": <free-form: describe how tests should mock, or commit to DI-only>,`,
    `     "testingNotes":   <free-form gotchas specific to this combination — if any>`,
    `   }`,
    "",
    `   IMPORTANT — both testCommand and singleTestCommand must emit`,
    `   TAP output. The harness parses TAP to track pass/fail.`,
    "",
    `   Per-node dispatch runs ONE test file at a time — the function`,
    `   being implemented. The harness spawns singleTestCommand with`,
    `   {file} replaced by that function's "<name>.test.ts". A sibling`,
    `   function's failing test CANNOT affect the current target's`,
    `   pass/fail signal. Globs like *.test.ts or src/**/*.test.ts are`,
    `   WRONG here — they'd re-introduce cross-contamination.`,
    "",
    `   Examples of valid singleTestCommand templates:`,
    `     - vitest:            "npx vitest run --reporter=tap {file}"`,
    `     - jest:              "npx jest --reporters=jest-tap-reporter {file}"`,
    `     - mocha:             "npx mocha --reporter=tap {file}"`,
    `     - node:test (22+):   "node --test --test-reporter=tap --experimental-strip-types {file}"`,
    `     - node:test + tsc:   "tsc && node --test --test-reporter=tap dist/{file}".replace(".ts",".js")  — rewrite the extension in your template`,
    `     - deno:test:         "deno test --reporter=tap {file}"`,
    "",
    `   testCommand is used by the FINAL integration phase (runs the`,
    `   whole suite end-to-end); singleTestCommand is what the`,
    `   leaf-up builder spawns for every function dispatch.`,
    "",
    `   STRONGLY PREFERRED — delegate to your package manager's test`,
    `   script. Put the full pipeline (compile + spawn + reporter) in`,
    `   your package.json's \`scripts.test\`, then set:`,
    `     testCommand: "npm test"    (or "pnpm test", "yarn test", "bun test")`,
    `   This keeps ONE source of truth. When testCommand and`,
    `   scripts.test drift, the harness runs one thing, your npm run`,
    `   does another, and you'll debug a ghost.`,
    "",
    `   CRITICAL — FILE LAYOUT the harness uses:`,
    `     All function files AND test files live FLAT at the project`,
    `     root. No \`src/\` subdir. Filenames are \`<functionName>.ts\``,
    `     and \`<functionName>.test.ts\`. Integration tests are`,
    `     \`integration.test.ts\` at the root.`,
    `     A glob like \`src/**/*.test.ts\` will match ZERO files and`,
    `     your test run will report 0/0 — which counts as failure.`,
    `     Use \`*.test.ts\` (or \`./*.test.ts\`) in your test command /`,
    `     scripts.test.`,
    "",
    `   CRITICAL — IMPORT CONVENTION the harness uses:`,
    `     The harness emits test files that import functions with \`.js\``,
    `     extensions — e.g. \`import foo from "./foo.js"\` — even though`,
    `     the file on disk is \`foo.ts\`. This matches Node ESM + tsc`,
    `     output conventions. Your test command MUST resolve \`.js\``,
    `     specifiers to the corresponding \`.ts\` sources. Tools that`,
    `     do this natively: vitest, jest (with ts-jest or @swc/jest),`,
    `     tsx (as a Node loader), or a \`tsc\` compile step that`,
    `     actually produces \`.js\` files in \`dist/\`.`,
    `     \`node --experimental-strip-types\` does NOT do this remap —`,
    `     it runs \`.ts\` syntax but Node's resolver still looks for the`,
    `     literal \`.js\` file on disk, so every \`import "./x.js"\` fails`,
    `     with ERR_MODULE_NOT_FOUND. Don't use it.`,
    "",
    `   If you don't delegate, the testCommand / singleTestCommand you`,
    `   write IS what the harness spawns — standalone. Common pitfalls:`,
    `     - \`ts-node/esm\` loader is fragile and often mismatches the`,
    `       installed ts-node version. Prefer tsx or vitest.`,
    `     - \`--experimental-strip-types\` alone (see above — .js imports fail).`,
    `     - jest without a TAP reporter plugin installed: pick a TAP`,
    `       reporter or delegate via \`npm test\`.`,
    "",
    `   RECOMMENDED combinations (pick one):`,
    `     - vitest (easiest — handles .js/.ts remap natively):`,
    `         testCommand:       "npx vitest run --reporter=tap"`,
    `         singleTestCommand: "npx vitest run --reporter=tap {file}"`,
    `     - node:test + tsx loader (Node 22+, tsx installed):`,
    `         testCommand:       "node --import tsx --test --test-reporter=tap *.test.ts"`,
    `         singleTestCommand: "node --import tsx --test --test-reporter=tap {file}"`,
    `     - mocha + tsx:`,
    `         testCommand:       "npx mocha --reporter=tap --loader=tsx *.test.ts"`,
    `         singleTestCommand: "npx mocha --reporter=tap --loader=tsx {file}"`,
    `     - deno:test (runtime: deno):`,
    `         testCommand:       "deno test --reporter=tap"`,
    `         singleTestCommand: "deno test --reporter=tap {file}"`,
    "",
    `   If your framework has no TAP reporter AND no way to delegate,`,
    `   pick a different framework.`,
    "",
    `2. \`\`\`file:package.json — literal package.json for the project.`,
    `   Include runtime deps + devDeps consistent with your decisions.`,
    `   If your testCommand is "npm test" (or similar), make sure`,
    `   \`scripts.test\` in this file is the FULL standalone command — it`,
    `   is what actually runs. If testCommand is a standalone CLI`,
    `   string instead, the two may diverge; keeping them in sync is`,
    `   your responsibility.`,
    `   If your runtime doesn't use package.json (e.g., Deno), emit an`,
    `   empty \`{}\`.`,
    "",
    `3. \`\`\`file:tsconfig.json — literal tsconfig.json. Pick compiler`,
    `   options that match your moduleSystem + runtime. Minimum: it`,
    `   must let the test command compile the generated \`.ts\` files.`,
    `   The harness emits function files like`,
    `     export default function foo(<params>): <RT> { ... }`,
    `   and test files that import via \`./<name>.js\` specifiers.`,
    "",
    `Every value is YOUR decision. No prose outside the fenced blocks.`,
  ].join("\n");
}

/** Pull the content of a specifically-tagged fence: ```<tag>\n…\n```. */
export function extractTaggedFence(
  response: string,
  tag: string,
): string | null {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = response.match(new RegExp(`\`\`\`${esc}\\s*\\r?\\n([\\s\\S]*?)\`\`\``));
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
}

const REQUIRED_DECISION_FIELDS = [
  "runtime",
  "moduleSystem",
  "testFramework",
  "testCommand",
  "singleTestCommand",
  "testImports",
] as const;

/** Parse the `decisions` JSON fence from phase 0, cross-reference
 *  with the two file fences (package.json + tsconfig.json), and
 *  assemble a fully-populated ProjectDecisions. Throws on missing
 *  required fields or missing file fences. */
export function parsePhase0Response(response: string): ProjectDecisions {
  const decisionsRaw = extractTaggedFence(response, "decisions");
  if (!decisionsRaw) {
    throw new Error(
      "missing ```decisions fence — expected a JSON object with project decisions",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decisionsRaw);
  } catch (e) {
    throw new Error(
      `decisions block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decisions block must be a JSON object");
  }
  const r = parsed as Record<string, unknown>;
  for (const field of REQUIRED_DECISION_FIELDS) {
    if (typeof r[field] !== "string" || (r[field] as string).length === 0) {
      throw new Error(
        `decisions missing required string field "${field}"`,
      );
    }
  }
  // Phase U12 — singleTestCommand must be a template with a literal
  // `{file}` token. Without it, the harness has no way to scope the
  // spawn to one test file, and per-node dispatch degenerates to a
  // whole-suite run (the bug this phase is fixing).
  if (!(r.singleTestCommand as string).includes("{file}")) {
    throw new Error(
      `decisions.singleTestCommand must contain the literal placeholder "{file}" — the harness substitutes it with "<functionName>.test.ts" per dispatch`,
    );
  }
  const packageJson = extractTaggedFence(response, "file:package.json");
  if (!packageJson) {
    throw new Error(
      "missing ```file:package.json fence — emit the project's package.json (or `{}` if runtime doesn't use one)",
    );
  }
  const tsconfig = extractTaggedFence(response, "file:tsconfig.json");
  if (!tsconfig) {
    throw new Error(
      "missing ```file:tsconfig.json fence — emit the project's tsconfig.json",
    );
  }
  const cfg: ProjectDecisions = {
    runtime: r.runtime as string,
    moduleSystem: r.moduleSystem as string,
    testFramework: r.testFramework as string,
    testCommand: r.testCommand as string,
    singleTestCommand: r.singleTestCommand as string,
    testImports: r.testImports as string,
    packageJson,
    tsconfig,
  };
  if (typeof r.packageManager === "string") cfg.packageManager = r.packageManager;
  if (typeof r.mockingStrategy === "string") cfg.mockingStrategy = r.mockingStrategy;
  if (typeof r.testingNotes === "string") cfg.testingNotes = r.testingNotes;
  return cfg;
}

async function runPhase0(
  chat: (p: string) => Promise<string>,
  task: string,
  maxRetries: number,
): Promise<ProjectDecisions | { error: string }> {
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
    try {
      return parsePhase0Response(response);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      currentPrompt = `${basePrompt}\n\nYour previous response: ${lastError}. Fix and re-emit all three fences.`;
      debug("plan", `phase0-init parse error: ${lastError}`);
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
    const notesPreview = phase0.testingNotes
      ? phase0.testingNotes.slice(0, 120).replace(/\s+/g, " ")
      : "(none)";
    debug(
      "plan",
      `phase 0 ok — framework=${phase0.testFramework} moduleSystem=${phase0.moduleSystem} testingNotes=${phase0.testingNotes ? `${phase0.testingNotes.length}ch` : "(none)"}`,
    );
    debug(
      "progress",
      `plan: phase 0 ok — ${phase0.testFramework} + ${phase0.moduleSystem}; testing-notes: ${notesPreview}`,
    );
    graph.setProjectConfig(phase0);
    // Phase D — mirror package.json + tsconfig into the asset map so
    // they're part of the model-owned asset surface (reachable via
    // request-info / revisable via asset fences) rather than only
    // accessible through projectConfig.
    if (phase0.packageJson) graph.setAsset("package.json", phase0.packageJson);
    if (phase0.tsconfig) graph.setAsset("tsconfig.json", phase0.tsconfig);
  } else if (!parentName) {
    const cfg = graph.getProjectConfig()!;
    debug(
      "plan",
      `phase 0 SKIPPED (resume) — projectConfig already set: framework=${cfg.testFramework} moduleSystem=${cfg.moduleSystem} testingNotes=${cfg.testingNotes ? `${cfg.testingNotes.length}ch` : "(none)"}`,
    );
    debug(
      "progress",
      `plan: phase 0 skipped (resume) — ${cfg.testFramework} + ${cfg.moduleSystem}`,
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
    // Always feed the current graph to the prompt so the model sees
    // what already exists (A2: idempotent re-entry). Both top-level
    // and decompose branches benefit — on outer-agent retry the graph
    // has prior functions, and the planner must not propose duplicates
    // without knowing what's there.
    const existingFunctions: PlannedFunction[] = graph
      .listFunctions()
      .map((f) => ({
        module: f.module,
        name: f.name,
        signature: f.signature,
        description: f.description,
      }));
    const moduleOverride = parentFn?.module;
    const phase1 = await withJsonRetry(
      options.chat,
      buildPhase1Prompt(task, parentSummary, existingFunctions),
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
    // Track which proposals actually landed in the graph — duplicates
    // get absorbed and must be dropped from plannedNames so phase 2
    // doesn't try to setSpec on a function that wasn't added.
    const addedPhase1: PlannedFunction[] = [];
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
        addedPhase1.push(fn);
      } catch (e) {
        // Silent-skip both duplicate forms on phase-1 re-entry:
        //   - "duplicate function:" = exact same-module+name (resume)
        //   - "duplicate function name:" = cross-module name collision
        //     (model re-proposed an existing name under a different
        //     module; the existing entry wins, the proposal is dropped)
        // The model saw the full existing-functions list in the prompt,
        // so collisions here are signal that the LLM re-proposed anyway
        // — log but don't halt. Other errors (invalid identifier,
        // reserved name, missing parent) still surface as planning
        // failures.
        const msg = e instanceof Error ? e.message : String(e);
        if (/^duplicate function(?:\s+name)?:/.test(msg)) {
          debug(
            "plan",
            `phase 1 duplicate absorbed — ${fn.module}#${fn.name}: ${msg}`,
          );
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
    plannedNames = addedPhase1;
  }

  // ── Phase 2: Architect fills the SPEC for each function ────────
  // The spec becomes the Implementer's contract. Tests are written
  // later, by the Implementer, during dispatch.
  //
  // Phase H1 — each function's spec is independent; all LLM calls are
  // issued concurrently via Promise.all. Graph mutations (setSpec)
  // happen after every call resolves, in a single synchronous pass,
  // so no two tasks race on `graph.setSpec`.
  let specsAttached = 0;
  const failedSpecs: string[] = [];
  // Snapshot the known-names set ONCE — siblings don't change during
  // phase 2 (we don't add new functions here), so this is the same
  // value every iteration would have computed inside the serial loop.
  const knownNames = new Set(graph.listFunctions().map((f) => f.name));
  const allFunctions = graph.listFunctions();
  type SpecTask =
    | { kind: "skip"; fn: PlannedFunction; key: string }
    | {
        kind: "work";
        fn: PlannedFunction;
        key: string;
        normalizedFn: PlannedFunction;
        siblings: PlannedFunction[];
      };
  const specTasks: SpecTask[] = plannedNames.map((fn) => {
    const key = `${fn.module}#${fn.name}`;
    const stored = graph.getFunction(fn.module, fn.name);
    if (stored && stored.spec !== null) {
      return { kind: "skip", fn, key };
    }
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
    const siblings: PlannedFunction[] = allFunctions
      .filter((f) => f.name !== normalizedFn.name)
      .map((f) => ({
        module: f.module,
        name: f.name,
        signature: f.signature,
        description: f.description,
      }));
    return { kind: "work", fn, key, normalizedFn, siblings };
  });
  type SpecResult = Awaited<ReturnType<typeof withJsonRetry<FunctionSpec>>>;
  // Fire all work tasks concurrently. Skipped tasks don't need an await.
  const results = await Promise.all(
    specTasks.map(async (specTask): Promise<{ task: SpecTask; parsed: SpecResult | null }> => {
      if (specTask.kind === "skip") return { task: specTask, parsed: null };
      const parsed = await withJsonRetry(
        options.chat,
        buildPhase2Prompt(task, specTask.normalizedFn, specTask.siblings),
        (raw) => parseFunctionSpec(raw, specTask.normalizedFn.signature),
        maxRetries,
        `phase2-spec[${specTask.key}]`,
      );
      return { task: specTask, parsed };
    }),
  );
  // Commit specs sequentially in the original order so debug logs read
  // like the old serial loop and resume ordering is stable.
  for (let i = 0; i < results.length; i++) {
    const { task: specTask, parsed } = results[i];
    if (specTask.kind === "skip") {
      debug(
        "plan",
        `phase 2 SKIPPED (resume) ${specTask.key} — spec already attached`,
      );
      debug(
        "progress",
        `plan: phase 2 ${i + 1}/${specTasks.length} skipped ${specTask.key} (spec already attached)`,
      );
      specsAttached++;
      continue;
    }
    debug(
      "progress",
      `plan: phase 2 ${i + 1}/${specTasks.length} — ${specTask.key}`,
    );
    if (parsed !== null && "error" in parsed) {
      debug("plan", `phase 2 failed for ${specTask.key}: ${parsed.error}`);
      debug(
        "progress",
        `plan: phase 2 ${i + 1}/${specTasks.length} FAILED ${specTask.key} — proceeding without spec`,
      );
      failedSpecs.push(specTask.key);
      continue;
    }
    const phase2 = parsed!;
    // Filter spec.dependencies against the graph — the LLM sometimes
    // hallucinates sibling names. Unknown entries would pollute the
    // Implementer prompt ("depends on foo") for a sibling that isn't
    // wired into ctx.fns, producing a runtime TypeError at test time.
    const unknownDeps = phase2.dependencies.filter((d) => !knownNames.has(d));
    if (unknownDeps.length > 0) {
      debug(
        "plan",
        `phase 2 ${specTask.key} — dropping unknown deps: ${unknownDeps.join(", ")}`,
      );
      debug(
        "progress",
        `plan: phase 2 ${specTask.key} — dropped unknown deps: ${unknownDeps.join(", ")}`,
      );
      phase2.dependencies = phase2.dependencies.filter((d) =>
        knownNames.has(d),
      );
    }
    debug(
      "plan",
      `phase 2 ${specTask.key} → purpose=${phase2.purpose.length}ch deps=${phase2.dependencies.length} edges=${phase2.edgeCases.length}`,
    );
    debug(
      "progress",
      `plan: phase 2 ${i + 1}/${specTasks.length} ok ${specTask.key} — ${phase2.dependencies.length} deps, ${phase2.edgeCases.length} edge cases`,
    );
    graph.setSpec(specTask.fn.module, specTask.fn.name, phase2);
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

  // ── Phase 3: mechanical build ───────────────────────────────────
  // Skipped when:
  //   - This is a sub-tree plan (caller drives dispatch)
  //   - skipBuild is true (caller runs its own build — e.g. the
  //     integration orchestrator's leaf-up pass)
  if (options.skipBuild) {
    debug(
      "plan",
      `phase 3 SKIPPED (skipBuild) — ${specsAttached} specs, ${plannedNames.length} functions`,
    );
    debug(
      "progress",
      `plan: phase 3 skipped (skipBuild) — ${specsAttached} specs, ${plannedNames.length} functions`,
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
  if (!options.dispatch || !options.finalize) {
    throw new Error(
      "designPlan requires `dispatch` and `finalize` when skipBuild is not set",
    );
  }
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
