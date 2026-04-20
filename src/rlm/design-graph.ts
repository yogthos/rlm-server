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
 * Architect-chosen project-level config: the raw package.json (as authored
 * in phase 0) plus the test framework detected from its devDependencies.
 * `null` until `setProjectConfig` is called; once set, it's sticky across
 * resumes and drives emitter + test-runner choices downstream.
 */
export interface ProjectConfig {
  packageJson: string;
  testFramework: "vitest" | "jest";
}

export interface DesignGraphSnapshot {
  modules: Record<string, ModuleNode>;
  functions: Record<string, FunctionNode>;
  projectTests: TestSpec[];
  projectConfig: ProjectConfig | null;
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
  /** Attach the Architect's phase-0 package.json + detected test
   *  framework. Sticky across resumes. */
  setProjectConfig(config: ProjectConfig): void;
  getProjectConfig(): ProjectConfig | null;
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
 * Render a proc-ts-style function signature. First parameter is always
 * `ctx: Ctx` (injected by the harness, not in `fn.signature.params`),
 * followed by the function's business-logic params. Return type is
 * emitted as a TypeScript annotation.
 */
function renderProcSignature(fn: FunctionNode): string {
  const async = fn.signature.isAsync ? "async " : "";
  const userParams = fn.signature.params.map(renderParam).join(", ");
  const paramList = userParams.length > 0 ? `ctx: Ctx, ${userParams}` : "ctx: Ctx";
  return `export default ${async}function ${fn.name}(${paramList}): ${fn.signature.returnType}`;
}

function renderBody(fn: FunctionNode): string {
  if (fn.implementation !== null) return fn.implementation;
  return `throw new Error(\`${fn.name}: not implemented (TODO)\`);`;
}

/**
 * Import line for describe/it/expect/<mocker> based on the project's
 * configured test framework. vitest pulls `vi`; jest pulls `jest`.
 */
function renderTestFrameworkImport(
  framework: ProjectConfig["testFramework"],
): string {
  if (framework === "jest") {
    return `import { describe, it, expect, jest } from "@jest/globals";`;
  }
  return `import { describe, it, expect, vi } from "vitest";`;
}

/** Emit one file per function in proc-ts style: filename = function name. */
function renderFunctionFile(fn: FunctionNode): string {
  const lines: string[] = [];
  lines.push(`${renderProcSignature(fn)} {`);
  for (const row of renderBody(fn).split("\n")) {
    lines.push(`  ${row}`);
  }
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit one `<fnName>.test.ts` per function that has tests. The test
 * file imports the target directly and constructs a minimal `ctx`
 * wiring in every project-local function (so tests can call
 * `ctx.fns.<name>(ctx, ...)` against any sibling).
 */
function renderFunctionTestFile(
  target: FunctionNode,
  allFns: FunctionNode[],
  framework: ProjectConfig["testFramework"],
): string {
  if (target.tests.length === 0) return "";
  const lines: string[] = [];
  lines.push(renderTestFrameworkImport(framework));
  // Common Node built-ins that test code frequently references. The
  // LLM writes bodies inline without top-of-file imports, so give it a
  // base palette available by namespace. Unused imports are cheap.
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  lines.push(`import ${target.name} from "./${target.name}.js";`);
  for (const f of allFns) {
    if (f.name === target.name) continue;
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  // Minimal CtxFns wiring: every imported function. `as any` because
  // these tests don't exercise the generated CtxFns d.ts shape — we
  // just need runtime callable bindings. Declared with `let` so tests
  // can swap in stub siblings (ctx.fns.other = () => ...) without
  // tripping a TS "cannot assign to const" error.
  const fnEntries = [target.name, ...allFns.filter((f) => f.name !== target.name).map((f) => f.name)];
  lines.push(`let ctx: any = { fns: { ${fnEntries.join(", ")} }, state: {}, t: null };`);
  lines.push("");
  lines.push(`describe(${JSON.stringify(target.name)}, () => {`);
  for (const t of target.tests) {
    // Always emit the `it` callback as async. The LLM frequently
    // writes `await` inside its test code — a plain arrow makes that
    // a syntax error, wrecking the whole file. An async arrow is
    // valid whether the body awaits or not.
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) {
      lines.push(`    ${row}`);
    }
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit `<name>.integration.test.ts` for a BRANCH function — exercises
 * the assembly through this function with ALL children real (no
 * stubs). This fires after the branch's body is written.
 */
function renderIntegrationTestFile(
  target: FunctionNode,
  allFns: FunctionNode[],
  framework: ProjectConfig["testFramework"],
): string {
  if (target.integrationTests.length === 0) return "";
  // Integration tests only make sense on BRANCH functions — they
  // exercise the assembly through the target and would otherwise run
  // against sibling stubs at dispatch time, producing false failures.
  if (target.children.length === 0) return "";
  const lines: string[] = [];
  lines.push(renderTestFrameworkImport(framework));
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  lines.push(`import ${target.name} from "./${target.name}.js";`);
  for (const f of allFns) {
    if (f.name === target.name) continue;
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  const fnEntries = [
    target.name,
    ...allFns.filter((f) => f.name !== target.name).map((f) => f.name),
  ];
  // Integration wiring: ALL functions real; `const` so tests that try
  // to stub trip a lint error (stubs defeat the purpose here).
  lines.push(
    `const ctx: any = { fns: { ${fnEntries.join(", ")} }, state: {}, t: null };`,
  );
  lines.push("");
  lines.push(`describe(${JSON.stringify(`${target.name} (integration)`)}, () => {`);
  for (const t of target.integrationTests) {
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) {
      lines.push(`    ${row}`);
    }
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Emit `project.integration.test.ts` for app-scope integration tests.
 * Wires ALL functions into ctx so tests can call any entry point.
 */
function renderProjectTestFile(
  allFns: FunctionNode[],
  projectTests: TestSpec[],
  framework: ProjectConfig["testFramework"],
): string {
  if (projectTests.length === 0 || allFns.length === 0) return "";
  const lines: string[] = [];
  lines.push(renderTestFrameworkImport(framework));
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  for (const f of allFns) {
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  lines.push(
    `const ctx: any = { fns: { ${allFns.map((f) => f.name).join(", ")} }, state: {}, t: null };`,
  );
  lines.push("");
  lines.push(`describe("project integration", () => {`);
  for (const t of projectTests) {
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) {
      lines.push(`    ${row}`);
    }
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

/** Emit the shared ctx.ts scaffolding. */
function renderCtxFile(): string {
  return [
    `export type CtxFns = import("./ctx_fns").default;`,
    "",
    `export type Ctx = {`,
    `  fns: CtxFns;`,
    `  state: Record<string, any>;`,
    `  t: any;`,
    `};`,
    "",
    `declare global {`,
    `  type Ctx = import("./ctx").Ctx;`,
    `}`,
    "",
    `const ctx: Ctx = { fns: {} as CtxFns, state: {}, t: null };`,
    `export default ctx;`,
    "",
  ].join("\n");
}

/**
 * Emit the auto-generated CtxFns interface. One entry per function.
 * Using `typeof import("./<name>").default` lets TypeScript enforce the
 * signature of each sibling call at `ctx.fns.<name>(ctx, ...)`.
 */
function renderCtxFnsFile(fns: FunctionNode[]): string {
  const lines: string[] = [`// Auto-generated — do not edit.`];
  lines.push(`export default interface CtxFns {`);
  for (const f of [...fns].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${f.name}: typeof import("./${f.name}").default;`);
  }
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

function materializeGraph(
  _modules: Map<string, ModuleNode>,
  functions: Map<string, FunctionNode>,
  projectTests: TestSpec[],
  projectConfig: ProjectConfig | null,
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
  if (projectConfig) {
    files["package.json"] = projectConfig.packageJson;
  }
  files["ctx.ts"] = renderCtxFile();
  files["ctx_fns.d.ts"] = renderCtxFnsFile(rendered);
  const framework = projectConfig?.testFramework ?? "vitest";
  for (const fn of rendered) {
    files[`${fn.name}.ts`] = renderFunctionFile(fn);
    const unit = renderFunctionTestFile(fn, rendered, framework);
    if (unit.length > 0) files[`${fn.name}.test.ts`] = unit;
    const integration = renderIntegrationTestFile(fn, rendered, framework);
    if (integration.length > 0) {
      files[`${fn.name}.integration.test.ts`] = integration;
    }
  }
  const project = renderProjectTestFile(rendered, projectTests, framework);
  if (project.length > 0) files["project.integration.test.ts"] = project;
  return files;
}

export function createDesignGraph(): DesignGraph {
  const modules = new Map<string, ModuleNode>();
  const functions = new Map<string, FunctionNode>();
  const projectTests: TestSpec[] = [];
  let projectConfig: ProjectConfig | null = null;
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

    addIntegrationTest(module, name, test) {
      const fn = requireFunction(module, name);
      fn.integrationTests.push(test);
    },

    replaceIntegrationTests(module, name, tests) {
      const fn = requireFunction(module, name);
      fn.integrationTests.length = 0;
      fn.integrationTests.push(...tests);
    },

    setProjectConfig(config) {
      // Store a fresh copy so outside callers can't mutate our state by
      // reference.
      projectConfig = { ...config };
    },

    getProjectConfig() {
      return projectConfig ? { ...projectConfig } : null;
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
      return {
        modules: modSnap,
        functions: fnSnap,
        projectTests: projectTests.map((t) => ({ ...t })),
        projectConfig: projectConfig ? { ...projectConfig } : null,
      };
    },
  };
}
