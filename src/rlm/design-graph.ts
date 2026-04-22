/**
 * DesignGraph — in-memory canonical model of the project the agents are
 * building. The Architect declares modules, function signatures, imports,
 * and tests BEFORE any implementation. Children (Implementers) later
 * attach implementations; tests are run against the materialized source.
 *
 * This is the primary state for the hierarchical-agent workflow. Files
 * exist only as a serialization target for the test runner — decisions
 * are made against the graph.
 */

/**
 * Phase N1 — analyzer-maintained edges, written by `setAnalyzedEdges`
 * after the Implementer's body is parsed by tree-sitter. Distinct from
 * architect-authored `spec.dependencies`: the spec is a plan, these are
 * the facts we observed in the actual source. Divergence between them
 * is a signal (drift, hallucinated import, missed plan step).
 */
export interface AnalyzedImport {
  source: string;
  name: string;
  isDefault: boolean;
  /** 1-based source line of the `import` statement. */
  line: number;
}

export interface AnalyzedEdges {
  imports: AnalyzedImport[];
  callees: string[];
}

export interface ParamSpec {
  name: string;
  type: string;
  optional?: boolean;
  defaultValue?: string;
}

export interface Signature {
  params: ParamSpec[];
  returnType: string;
  isAsync?: boolean;
}

export interface TestSpec {
  name: string;
  code: string;
}

export type FunctionStatus =
  | "declared"
  | "implementing"
  | "implemented"
  | "tests-green"
  | "tests-red"
  /** Tests passed but the Architect rejected the implementation against
   *  the spec. Distinguishes a spec-mismatch failure from a test failure. */
  | "architect-rejected";

/**
 * How a function entered the graph — disambiguates "design_plan wrote
 * this" from "design_load parsed this off disk" from "user wrote the
 * declaration by hand in the sandbox." Drives resume-vs-fresh decisions
 * in design_plan.
 */
export type FunctionOrigin = "plan" | "load" | "manual";

/**
 * Architect-authored specification the Implementer fills in. The
 * Architect owns the *contract* (what the function does, its inputs,
 * outputs, side effects, invariants). The Implementer owns the
 * implementation AND the tests that verify the contract.
 */
export interface FunctionSpec {
  /** One-paragraph statement of what this function exists to do. */
  purpose: string;
  /** Declared input parameters (excluding ctx, which is injected). */
  inputs: Array<{ name: string; type: string; description: string }>;
  /** Return value. */
  output: { type: string; description: string };
  /** Observable side effects (file I/O, HTTP, state mutation). */
  sideEffects: string[];
  /** Sibling functions this one calls via ctx.fns.<name>. */
  dependencies: string[];
  /** Edge cases / invariants / error conditions the Implementer must
   *  cover with tests. */
  edgeCases: string[];
  /** Concrete input → output pairs the Implementer can encode as tests. */
  examples: Array<{ input: string; output: string }>;
}

export interface FunctionNode {
  module: string;
  name: string;
  signature: Signature;
  description: string;
  /** Architect-written spec the Implementer uses as its contract.
   *  Null before phase 2 runs; present afterward. The Implementer
   *  writes tests + body derived from this spec. */
  spec: FunctionSpec | null;
  /** Unit tests — exercise THIS function in isolation, stubbing any
   *  sibling dependencies. Authored by the Implementer (not the
   *  Architect) based on the spec. Run during leaf dispatch. */
  tests: TestSpec[];
  /** Integration tests — exercise the assembly THROUGH this function.
   *  Populated when a function has children (or later, via a re-plan).
   *  Run after the branch's body is written against real wired
   *  children (no stubs). Empty for pure leaves. */
  integrationTests: TestSpec[];
  /** Phase C2 — wrapper-kill for tests: when set, the harness writes
   *  this verbatim as `<name>.test.ts` instead of rendering a
   *  describe/it wrapper around `tests[]`. `tests[]` is still kept for
   *  back-compat with legacy fixtures and for the model's own reference. */
  unitTestFile: string | null;
  /** Phase C2 — same idea for `<name>.integration.test.ts`. */
  integrationTestFile: string | null;
  /** Phase N1 — top-level imports found in the saved implementation by
   *  tree-sitter (post-save). Each entry carries the module specifier
   *  and the local binding name. Empty until the body is analyzed. */
  analyzedImports: AnalyzedImport[];
  /** Phase N1 — bare-identifier function call targets observed in the
   *  saved implementation. Deduped + sorted. Together with
   *  `analyzedImports`, these let the harness derive an authoritative
   *  call graph without parsing disk on every lookup. */
  analyzedCallees: string[];
  implementation: string | null;
  status: FunctionStatus;
  lastTestOutput: string | null;
  origin: FunctionOrigin;
  /** Name of the parent function in the call-decomposition tree, or
   *  null for a root. Set automatically by `addFunctionChild`. */
  parent: string | null;
  /** Names of child functions that compose to implement this one.
   *  Populated by `addFunctionChild`. A leaf has `children: []` and
   *  the Implementer writes its body directly; a branch has children
   *  and its body assembles them via `ctx.fns.<child>(ctx, …)`. */
  children: string[];
}

export interface ImportEdge {
  symbol: string;
  from: string;
}

export interface ModuleNode {
  path: string;
  imports: ImportEdge[];
  exports: string[];
}

/**
 * Model-authored project decisions. Populated once in phase 0 via a
 * structured template; revisable later via architect-level reflect.
 * Drives every downstream code-generation prompt and the test-runner
 * spawn — the HARNESS hardcodes nothing about runtime, framework, or
 * tooling.
 *
 * All string fields are free-form. The harness doesn't validate their
 * values against an allowlist; the architect commits to a combination
 * and is responsible for consistency (e.g., `testImports` must load
 * symbols the `testCommand` runtime understands).
 *
 * Required:
 *   `runtime`        — e.g. "node", "deno", "bun" — affects materialization
 *   `moduleSystem`   — "esm" | "cjs" | "(n/a)" — informs tsconfig + test syntax
 *   `testFramework`  — e.g. "vitest", "jest", "mocha", "node:test", "deno:test"
 *   `testCommand`    — the full CLI the harness will spawn in the project dir
 *   `testImports`    — literal import line(s) placed atop auto-emitted test files
 *                       (when the harness generates them; implementer-emitted
 *                       test files declare their own imports)
 *
 * Optional:
 *   `packageManager`   — "npm", "pnpm", "yarn", "bun", "(none)"
 *   `packageJson`      — raw file content (verbatim at materialize) — kept here
 *                        for phase-0 locality; lives in projectAssets too
 *   `tsconfig`         — raw file content, architect-authored
 *   `mockingStrategy`  — free-form description of how tests should mock deps
 *   `testingNotes`     — free-form gotchas (framework + runtime specific)
 *
 * `testFramework: "vitest" | "jest"` style unions were the PRIOR shape;
 * they forced the harness to ship per-framework code paths. The fields
 * are now plain strings — the architect picks any framework, declares
 * how to invoke it, and every downstream prompt receives the decision.
 */
export interface ProjectDecisions {
  runtime: string;
  moduleSystem: string;
  testFramework: string;
  testCommand: string;
  /** Phase U12 — per-node dispatch spawns this instead of `testCommand`.
   *  Template string with a literal `{file}` placeholder that the
   *  harness substitutes at spawn time with the target function's
   *  `<name>.test.ts`. Keeps dispatch scoped to ONE test file so a
   *  sibling's failing test can't contaminate the current target's
   *  pass/fail signal. `testCommand` (full suite) still runs during
   *  the integration/finalize phase.
   *  Optional on the TS type so pre-U12 graphs / test fixtures load
   *  without edits; phase 0 REQUIRES it for fresh runs. */
  singleTestCommand?: string;
  testImports: string;
  packageManager?: string;
  packageJson?: string;
  tsconfig?: string;
  mockingStrategy?: string;
  testingNotes?: string;
}

/**
 * @deprecated Use `ProjectDecisions`. Kept temporarily as an alias
 *   so the migration is mechanical; consumers will be updated in the
 *   coming phases.
 */
export type ProjectConfig = ProjectDecisions;

export interface DesignGraphSnapshot {
  modules: Record<string, ModuleNode>;
  functions: Record<string, FunctionNode>;
  projectTests: TestSpec[];
  projectConfig: ProjectConfig | null;
  /** Phase D — free-form asset map. Keys are project-relative paths
   *  (`package.json`, `tsconfig.json`, `scripts/seed.sql`, …); values
   *  are file contents. Written verbatim at materialize time. */
  assets: Record<string, string>;
  /** Phase C2 unified — architect-owned `project.integration.test.ts`
   *  source when the wrapper-kill path is in use. */
  projectTestFile: string | null;
}

export type ConsistencyViolation =
  | { kind: "unresolved_import"; module: string; symbol: string; from: string }
  | { kind: "missing_module"; module: string; from: string }
  | { kind: "import_cycle"; cycle: string[] };

export type ConsistencyAdvisory =
  | { kind: "no_tests"; module: string; function: string };

export interface ConsistencyReport {
  ok: boolean;
  violations: ConsistencyViolation[];
  advisories: ConsistencyAdvisory[];
}

export interface DesignGraph {
  addModule(path: string): ModuleNode;
  addFunction(
    module: string,
    name: string,
    signature: Signature,
    description?: string,
    origin?: FunctionOrigin,
  ): FunctionNode;
  /** Declare a function that decomposes the given parent. The parent
   *  must already exist. Parent's `children` list gets the new name;
   *  child's `parent` points back. */
  addFunctionChild(
    parentName: string,
    module: string,
    name: string,
    signature: Signature,
    description?: string,
    origin?: FunctionOrigin,
  ): FunctionNode;
  listRoots(): FunctionNode[];
  listChildren(parentName: string): FunctionNode[];
  hasChildren(name: string): boolean;
  /** Depth-first topological sort — every function's children appear
   *  before the function itself. Siblings are ordered alphabetically
   *  for determinism. Handles multiple roots. */
  topoSortFunctions(): FunctionNode[];
  addImport(toModule: string, symbol: string, fromModule: string): void;
  addTest(module: string, name: string, test: TestSpec): void;
  /** Bulk-replace the function's unit tests. Used by the Implementer's
   *  test-patch path so callers don't mutate `fn.tests` directly. */
  replaceTests(module: string, name: string, tests: TestSpec[]): void;
  /** Phase C2 — store the full unit test file content. When set, the
   *  harness materializes it verbatim instead of wrapping
   *  `tests[]`. Pass `null` to clear and fall back to the wrapper. */
  setUnitTestFile(module: string, name: string, content: string | null): void;
  /** Phase C2 — same for `<name>.integration.test.ts`. */
  setIntegrationTestFile(
    module: string,
    name: string,
    content: string | null,
  ): void;
  /** Attach an integration test to a function (exercises the assembly
   *  through this function once its children are wired). */
  addIntegrationTest(module: string, name: string, test: TestSpec): void;
  /** Bulk-replace the function's integration tests. Mirror of
   *  `replaceTests` for the integration list. */
  replaceIntegrationTests(
    module: string,
    name: string,
    tests: TestSpec[],
  ): void;
  /** Phase C2 unified — architect-owned full `project.integration.test.ts`
   *  source. When set, the harness materializes this verbatim instead
   *  of wrapping `projectTests[]` in a describe/it scaffold. Pass `null`
   *  to clear. */
  setProjectTestFile(content: string | null): void;
  getProjectTestFile(): string | null;
  /** Phase N1 — write the analyzer-observed edges for a function.
   *  Overwrites both `analyzedImports` and `analyzedCallees`
   *  atomically. Throws when the function doesn't exist. */
  setAnalyzedEdges(
    module: string,
    name: string,
    edges: AnalyzedEdges,
  ): void;
  /** Attach the Architect's phase-0 package.json + detected test
   *  framework. Sticky across resumes. */
  setProjectConfig(config: ProjectConfig): void;
  getProjectConfig(): ProjectConfig | null;
  /** Phase D — attach a free-form asset (any path, any content). Pass
   *  `null` to delete. Keys are project-relative paths written by
   *  materialize, never absolute. */
  setAsset(path: string, content: string | null): void;
  getAsset(path: string): string | null;
  listAssets(): Record<string, string>;
  /** Attach an integration test to the whole project (no specific
   *  function — exercises the top-level assembly). */
  /** Remove a function from the graph entirely. Drops its entry from
   *  the parent/child tree (the parent's `children` array) and from
   *  any sibling spec's `dependencies`. Used by the coherence self-
   *  heal pass to drop orphans the architect marked for deletion. */
  removeFunction(module: string, name: string): void;
  addProjectTest(test: TestSpec): void;
  /** Replace the entire project-scope integration test set. Used by
   *  the review pass when the architect revises a test — we swap the
   *  old entry for the rewritten one rather than accumulate both. */
  replaceProjectTests(tests: TestSpec[]): void;
  /** All project-scope integration tests. */
  listProjectTests(): TestSpec[];
  /** Replace the function's description (for progressive enrichment
   *  during planning — phase 1 gets a one-liner, phase 2 elaborates). */
  setDescription(module: string, name: string, description: string): void;
  /** Attach the Architect's spec (contract) to a function. */
  setSpec(module: string, name: string, spec: FunctionSpec): void;
  setImplementation(module: string, name: string, source: string): void;
  /** Wipe the stored body + test status, resetting the function to
   *  "declared" (planned but not yet implemented). Used by the
   *  split-on-stagnation recovery path: before we re-plan a function
   *  into sub-children, we erase the Implementer's failed work so
   *  downstream materialization doesn't embed the broken body. */
  clearImplementation(module: string, name: string): void;
  setTestStatus(
    module: string,
    name: string,
    status: FunctionStatus,
    output?: string,
  ): void;

  getModule(path: string): ModuleNode | undefined;
  getFunction(module: string, name: string): FunctionNode | undefined;
  listModules(): ModuleNode[];
  listFunctions(): FunctionNode[];

  allImplemented(): boolean;
  allTestsGreen(): boolean;
  consistency(): ConsistencyReport;

  snapshot(): DesignGraphSnapshot;
  /**
   * Render the graph into a file set. When `override` is provided, the
   * named function is rendered with the override body — without mutating
   * the stored graph — so concurrent callers see consistent state.
   */
  materialize(override?: {
    module: string;
    name: string;
    body: string;
  }): Record<string, string>;
  /**
   * Serialize an async critical section against concurrent graph
   * mutations. Node's event loop keeps fully-synchronous mutations
   * (setImplementation, addImport, …) race-free on their own, but any
   * async section that reads, does I/O, and writes back (materialize →
   * vitest → setImplementation) needs this to avoid torn reads.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

function fnKey(module: string, name: string): string {
  return `${module}#${name}`;
}

function renderParam(p: ParamSpec): string {
  const q = p.optional ? "?" : "";
  const def = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : "";
  return `${p.name}${q}: ${p.type}${def}`;
}

/**
 * Render a natural-style function signature for wrapping and stubs.
 * Phase N2: ctx is no longer injected — the architect's declared
 * params are the whole signature. Siblings are imported directly by
 * the implementer; call-graph edges are captured post-save by tree-
 * sitter analysis (`analyzeSource`), not by parsing `ctx.fns.*` tokens.
 */
function renderProcSignature(fn: FunctionNode): string {
  const async = fn.signature.isAsync ? "async " : "";
  const paramList = fn.signature.params.map(renderParam).join(", ");
  return `export default ${async}function ${fn.name}(${paramList}): ${fn.signature.returnType}`;
}

/** Full-file stub for an unimplemented function. Used at materialize
 *  time when fn.implementation is null so siblings that import it via
 *  `./<name>.js` still resolve, and tsc can still compile the
 *  project-level test file. */
function renderFunctionStubFile(fn: FunctionNode): string {
  return [
    `${renderProcSignature(fn)} {`,
    `  throw new Error(\`${fn.name}: not implemented (TODO)\`);`,
    `}`,
    "",
  ].join("\n");
}

/** Emit one file per function in proc-ts style: filename = function
 *  name. Since Phase 3 (wrapper-kill): `fn.implementation` holds the
 *  complete file the implementer emitted (imports + signature + body).
 *  Materialize passes it through verbatim. An unimplemented function
 *  gets a minimal full-file stub so siblings can still resolve the
 *  import at typecheck / runtime.
 *
 *  Back-compat for body-only inputs: if `fn.implementation` doesn't
 *  contain `export default`, it was produced before the wrapper-kill
 *  (legacy test fixtures, sandbox `design_implement` calls that pass
 *  bare statements, or occasional LLM deviation). Wrap it with the
 *  declared signature so the emitted file is always a valid module
 *  and the test file's `import foo from "./foo.js"` succeeds.
 *  Callers that DO pass a full file (has `export default`) are
 *  passed through untouched. */
function renderFunctionFile(fn: FunctionNode): string {
  if (fn.implementation !== null) {
    if (/\bexport\s+default\b/.test(fn.implementation)) {
      return fn.implementation;
    }
    return [
      `${renderProcSignature(fn)} {`,
      ...fn.implementation.split("\n").map((l) => `  ${l}`),
      `}`,
      "",
    ].join("\n");
  }
  return renderFunctionStubFile(fn);
}

/**
 * Emit `<fnName>.test.ts` — wrapper-kill only. The implementer owns
 * the entire test file end-to-end (imports, describe/it, assertions).
 * Returns "" when the implementer hasn't authored one yet.
 *
 * Phase U6 — the legacy `addTest` / `tests[]` wrapper path was
 * retired. `tests[]` is still kept on the FunctionNode for the
 * implementer's OWN reference (echoed back into subsequent prompts),
 * but the harness never wraps those into a test file — that would
 * hardcode vitest/jest-style describe/it syntax and defeat the
 * "model owns tooling" principle.
 */
function renderFunctionTestFile(target: FunctionNode): string {
  if (target.unitTestFile !== null && target.unitTestFile.length > 0) {
    return target.unitTestFile;
  }
  return "";
}

/**
 * Emit `<name>.integration.test.ts` — wrapper-kill only. Integration
 * tests only make sense on BRANCH functions (with children); for
 * leaves, even the implementer's integration file is dropped.
 */
function renderIntegrationTestFile(target: FunctionNode): string {
  if (target.children.length === 0) return "";
  if (
    target.integrationTestFile !== null &&
    target.integrationTestFile.length > 0
  ) {
    return target.integrationTestFile;
  }
  return "";
}

/**
 * Emit `project.integration.test.ts` — wrapper-kill only. The architect
 * authors the full file via `setProjectTestFile`.
 */
function renderProjectTestFile(projectTestFile: string | null): string {
  return projectTestFile !== null && projectTestFile.length > 0
    ? projectTestFile
    : "";
}

function materializeGraph(
  _modules: Map<string, ModuleNode>,
  functions: Map<string, FunctionNode>,
  _projectTests: TestSpec[],
  projectConfig: ProjectConfig | null,
  assets: Map<string, string>,
  projectTestFile: string | null,
  override?: { module: string; name: string; body: string },
): Record<string, string> {
  if (functions.size === 0) return {};
  const overrideKey = override ? fnKey(override.module, override.name) : null;
  const rendered: FunctionNode[] = [];
  for (const fn of functions.values()) {
    rendered.push(
      overrideKey && fnKey(fn.module, fn.name) === overrideKey
        ? { ...fn, implementation: override!.body }
        : fn,
    );
  }
  const files: Record<string, string> = {};
  // Phase D — assets write first so phase-0 package.json / tsconfig and
  // anything set via setAsset landed on disk verbatim. Function files
  // below overwrite on key collision, which is intentional: a
  // package.json in assets beats the legacy projectConfig.packageJson
  // path if the model has revised it.
  for (const [path, content] of assets) files[path] = content;
  if (projectConfig?.packageJson && !files["package.json"]) {
    files["package.json"] = projectConfig.packageJson;
  }
  if (projectConfig?.tsconfig && !files["tsconfig.json"]) {
    files["tsconfig.json"] = projectConfig.tsconfig;
  }
  // Phase N2 — ctx.ts / ctx_fns.d.ts are no longer emitted. The model
  // writes plain TypeScript modules with natural imports; there's no
  // framework scaffold to inject anymore.
  for (const fn of rendered) {
    files[`${fn.name}.ts`] = renderFunctionFile(fn);
    const unit = renderFunctionTestFile(fn);
    if (unit.length > 0) files[`${fn.name}.test.ts`] = unit;
    const integration = renderIntegrationTestFile(fn);
    if (integration.length > 0) {
      files[`${fn.name}.integration.test.ts`] = integration;
    }
  }
  const project = renderProjectTestFile(projectTestFile);
  if (project.length > 0) files["project.integration.test.ts"] = project;
  return files;
}

export function createDesignGraph(): DesignGraph {
  const modules = new Map<string, ModuleNode>();
  const functions = new Map<string, FunctionNode>();
  const projectTests: TestSpec[] = [];
  let projectConfig: ProjectConfig | null = null;
  let projectTestFile: string | null = null;
  const assets = new Map<string, string>();
  let mutationChain: Promise<unknown> = Promise.resolve();

  function ensureModule(path: string): ModuleNode {
    const existing = modules.get(path);
    if (existing) return existing;
    const node: ModuleNode = { path, imports: [], exports: [] };
    modules.set(path, node);
    return node;
  }

  function requireFunction(module: string, name: string): FunctionNode {
    const fn = functions.get(fnKey(module, name));
    if (!fn) {
      throw new Error(`function not found: ${module}#${name}`);
    }
    return fn;
  }

  function addFunctionInternal(
    module: string,
    name: string,
    signature: Signature,
    description: string,
    origin: FunctionOrigin,
    parent: string | null,
  ): FunctionNode {
    // Defensive: if a caller (planner) included `ctx` as the first
    // param, strip it — the emitter injects `ctx: Ctx` automatically,
    // and keeping both would produce a duplicate-parameter signature
    // (a TS parse error that surfaces as 0/0 tests).
    if (
      signature.params.length > 0 &&
      signature.params[0].name === "ctx"
    ) {
      signature = {
        ...signature,
        params: signature.params.slice(1),
      };
    }
    // Normalize `isAsync` ↔ `returnType` consistency. The LLM can slip
    // in two directions:
    //   - isAsync=false + returnType=Promise<T>  → force isAsync=true
    //     (otherwise the body can't `await` — syntax error)
    //   - isAsync=true  + returnType=T (non-Promise) → wrap as Promise<T>
    //     (otherwise `async function f(): T` is a TS error)
    // Both renderings produce uncompilable files, so we reconcile at ingest.
    const rtTrim = signature.returnType.trim();
    const isPromise = /^Promise</.test(rtTrim);
    if (!signature.isAsync && isPromise) {
      signature = { ...signature, isAsync: true };
    } else if (signature.isAsync && !isPromise && rtTrim.length > 0) {
      signature = {
        ...signature,
        returnType: `Promise<${rtTrim}>`,
      };
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(
        `invalid function name: ${JSON.stringify(name)} — must be a TypeScript identifier`,
      );
    }
    // "project" collides with the project-level integration-tests
    // describe title (`describe("project integration", …)`), which
    // would make finalize's failure digest misattribute project-level
    // failures to a user function of that name.
    if (name === "project") {
      throw new Error(
        `function name "project" is reserved — it collides with the project-integration describe block`,
      );
    }
    for (const existing of functions.values()) {
      if (existing.name === name && existing.module !== module) {
        throw new Error(
          `duplicate function name: ${name} — already declared in ${existing.module}; names must be globally unique under the proc-ts layout`,
        );
      }
    }
    const key = fnKey(module, name);
    if (functions.has(key)) {
      throw new Error(`duplicate function: ${key}`);
    }
    const mod = ensureModule(module);
    if (!mod.exports.includes(name)) mod.exports.push(name);
    const node: FunctionNode = {
      module,
      name,
      signature,
      description,
      spec: null,
      tests: [],
      integrationTests: [],
      unitTestFile: null,
      integrationTestFile: null,
      analyzedImports: [],
      analyzedCallees: [],
      implementation: null,
      status: "declared",
      lastTestOutput: null,
      origin,
      parent,
      children: [],
    };
    functions.set(key, node);
    return node;
  }

  return {
    addModule(path) {
      return ensureModule(path);
    },

    addFunction(module, name, signature, description = "", origin = "manual") {
      return addFunctionInternal(module, name, signature, description, origin, null);
    },

    addFunctionChild(parentName, module, name, signature, description = "", origin = "manual") {
      // Find the parent by name (global-unique under proc-ts).
      let parentNode: FunctionNode | undefined;
      for (const existing of functions.values()) {
        if (existing.name === parentName) {
          parentNode = existing;
          break;
        }
      }
      if (!parentNode) {
        throw new Error(`parent not found: ${parentName}`);
      }
      const child = addFunctionInternal(module, name, signature, description, origin, parentName);
      if (!parentNode.children.includes(name)) {
        parentNode.children.push(name);
      }
      return child;
    },

    listRoots() {
      return Array.from(functions.values()).filter((f) => f.parent === null);
    },

    listChildren(parentName) {
      return Array.from(functions.values()).filter(
        (f) => f.parent === parentName,
      );
    },

    hasChildren(name) {
      for (const f of functions.values()) {
        if (f.parent === name) return true;
      }
      return false;
    },

    topoSortFunctions() {
      // DFS from each root; emit children before parent. Sibling order
      // is alphabetical for stable output. Handles multiple roots.
      const visited = new Set<string>();
      const out: FunctionNode[] = [];
      const visit = (fn: FunctionNode): void => {
        if (visited.has(fn.name)) return;
        visited.add(fn.name);
        const children = Array.from(functions.values())
          .filter((f) => f.parent === fn.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const c of children) visit(c);
        out.push(fn);
      };
      const roots = Array.from(functions.values())
        .filter((f) => f.parent === null)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const r of roots) visit(r);
      // Any orphan (shouldn't happen, but be defensive) — append.
      for (const fn of functions.values()) {
        if (!visited.has(fn.name)) out.push(fn);
      }
      return out;
    },

    addImport(toModule, symbol, fromModule) {
      const mod = ensureModule(toModule);
      const already = mod.imports.some(
        (e) => e.symbol === symbol && e.from === fromModule,
      );
      if (!already) mod.imports.push({ symbol, from: fromModule });
    },

    addTest(module, name, test) {
      const fn = requireFunction(module, name);
      fn.tests.push(test);
    },

    replaceTests(module, name, tests) {
      const fn = requireFunction(module, name);
      fn.tests.length = 0;
      fn.tests.push(...tests);
    },

    setUnitTestFile(module, name, content) {
      const fn = requireFunction(module, name);
      fn.unitTestFile = content;
    },

    setIntegrationTestFile(module, name, content) {
      const fn = requireFunction(module, name);
      fn.integrationTestFile = content;
    },

    addIntegrationTest(module, name, test) {
      const fn = requireFunction(module, name);
      fn.integrationTests.push(test);
    },

    replaceIntegrationTests(module, name, tests) {
      const fn = requireFunction(module, name);
      fn.integrationTests.length = 0;
      fn.integrationTests.push(...tests);
    },

    setAnalyzedEdges(module, name, edges) {
      const fn = requireFunction(module, name);
      fn.analyzedImports = edges.imports.map((i) => ({ ...i }));
      fn.analyzedCallees = [...edges.callees];
    },

    setProjectTestFile(content) {
      // Defense-in-depth: a blank/whitespace-only payload behaves like
      // `null` — the harness treats "no authored file" as a signal to
      // run the LLM next resume, and storing "" would silently skip
      // that attempt while also producing an empty
      // `project.integration.test.ts` at materialize time.
      if (content !== null && content.trim().length === 0) {
        projectTestFile = null;
        return;
      }
      projectTestFile = content;
    },

    getProjectTestFile() {
      return projectTestFile;
    },

    setProjectConfig(config) {
      // Store a fresh copy so outside callers can't mutate our state by
      // reference.
      projectConfig = { ...config };
    },

    getProjectConfig() {
      return projectConfig ? { ...projectConfig } : null;
    },

    setAsset(path, content) {
      if (content === null) {
        assets.delete(path);
      } else {
        assets.set(path, content);
      }
    },

    getAsset(path) {
      return assets.has(path) ? (assets.get(path) as string) : null;
    },

    listAssets() {
      const out: Record<string, string> = {};
      for (const [k, v] of assets) out[k] = v;
      return out;
    },

    removeFunction(module, name) {
      const fn = functions.get(fnKey(module, name));
      if (!fn) return;
      // Drop from parent's children list.
      if (fn.parent !== null) {
        for (const other of functions.values()) {
          if (other.name === fn.parent) {
            other.children = other.children.filter((c) => c !== name);
            break;
          }
        }
      }
      // Drop from any sibling's spec.dependencies.
      for (const other of functions.values()) {
        if (!other.spec) continue;
        if (other.spec.dependencies.includes(name)) {
          other.spec = {
            ...other.spec,
            dependencies: other.spec.dependencies.filter((d) => d !== name),
          };
        }
      }
      // Drop from parent pointers on any remaining nodes claiming this
      // as parent (defensive — orphaned descendants become roots).
      for (const other of functions.values()) {
        if (other.parent === name) other.parent = null;
      }
      functions.delete(fnKey(module, name));
    },

    addProjectTest(test) {
      projectTests.push(test);
    },

    replaceProjectTests(tests) {
      projectTests.length = 0;
      for (const t of tests) projectTests.push(t);
    },

    listProjectTests() {
      return [...projectTests];
    },

    setDescription(module, name, description) {
      const fn = requireFunction(module, name);
      fn.description = description;
    },

    setSpec(module, name, spec) {
      const fn = requireFunction(module, name);
      fn.spec = spec;
    },

    setImplementation(module, name, source) {
      const fn = requireFunction(module, name);
      fn.implementation = source;
      fn.status = "implemented";
      fn.lastTestOutput = null;
    },

    clearImplementation(module, name) {
      const fn = requireFunction(module, name);
      fn.implementation = null;
      fn.tests = [];
      fn.integrationTests = [];
      fn.status = "declared";
      fn.lastTestOutput = null;
    },

    setTestStatus(module, name, status, output) {
      const fn = requireFunction(module, name);
      fn.status = status;
      if (output !== undefined) fn.lastTestOutput = output;
    },

    getModule(path) {
      return modules.get(path);
    },
    getFunction(module, name) {
      return functions.get(fnKey(module, name));
    },
    listModules() {
      return Array.from(modules.values());
    },
    listFunctions() {
      return Array.from(functions.values());
    },

    allImplemented() {
      for (const fn of functions.values()) {
        if (fn.implementation === null) return false;
      }
      return true;
    },

    allTestsGreen() {
      for (const fn of functions.values()) {
        if (fn.status !== "tests-green") return false;
      }
      return true;
    },

    consistency() {
      // proc-ts layout: functions call each other via `ctx.fns.<name>`,
      // not via imports. `design_import` edges are preserved as
      // metadata but no longer validated — an "unresolved_import" in
      // proc-ts is semantically meaningless. The only remaining check
      // is the "no_tests" advisory, which the planner uses to gate
      // dispatch.
      const violations: ConsistencyViolation[] = [];
      const advisories: ConsistencyAdvisory[] = [];
      for (const fn of functions.values()) {
        if (fn.tests.length === 0) {
          advisories.push({
            kind: "no_tests",
            module: fn.module,
            function: fn.name,
          });
        }
      }
      return {
        ok: true,
        violations,
        advisories,
      };
    },

    materialize(override) {
      if (override) {
        const key = fnKey(override.module, override.name);
        if (!functions.has(key)) {
          throw new Error(`function not found: ${key}`);
        }
      }
      return materializeGraph(
        modules,
        functions,
        projectTests,
        projectConfig,
        assets,
        projectTestFile,
        override,
      );
    },

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      // Chain so callers waiting on the lock all see a consistent view.
      const prior = mutationChain;
      let release: () => void;
      const gate = new Promise<void>((r) => (release = r));
      mutationChain = prior.then(() => gate);
      try {
        await prior.catch(() => undefined);
        return await fn();
      } finally {
        release!();
      }
    },

    snapshot() {
      const modSnap: Record<string, ModuleNode> = {};
      for (const [k, v] of modules) {
        modSnap[k] = { ...v, imports: [...v.imports], exports: [...v.exports] };
      }
      const fnSnap: Record<string, FunctionNode> = {};
      for (const [k, v] of functions) {
        fnSnap[k] = {
          ...v,
          signature: { ...v.signature, params: v.signature.params.map((p) => ({ ...p })) },
          tests: v.tests.map((t) => ({ ...t })),
          integrationTests: v.integrationTests.map((t) => ({ ...t })),
          analyzedImports: v.analyzedImports.map((i) => ({ ...i })),
          analyzedCallees: [...v.analyzedCallees],
          spec: v.spec
            ? {
                purpose: v.spec.purpose,
                inputs: v.spec.inputs.map((i) => ({ ...i })),
                output: { ...v.spec.output },
                sideEffects: [...v.spec.sideEffects],
                dependencies: [...v.spec.dependencies],
                edgeCases: [...v.spec.edgeCases],
                examples: v.spec.examples.map((e) => ({ ...e })),
              }
            : null,
        };
      }
      const assetSnap: Record<string, string> = {};
      for (const [k, v] of assets) assetSnap[k] = v;
      return {
        modules: modSnap,
        functions: fnSnap,
        projectTests: projectTests.map((t) => ({ ...t })),
        projectConfig: projectConfig ? { ...projectConfig } : null,
        assets: assetSnap,
        projectTestFile,
      };
    },
  };
}
