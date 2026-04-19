import { describe, it, expect } from "vitest";
import {
  createDesignGraph,
  type Signature,
  type TestSpec,
} from "../../src/rlm/design-graph.js";

const sig = (
  paramSpecs: Array<{ name: string; type: string; optional?: boolean }>,
  returnType = "void",
): Signature => ({ params: paramSpecs, returnType });

describe("DesignGraph — modules", () => {
  it("starts empty", () => {
    const g = createDesignGraph();
    expect(g.listModules()).toEqual([]);
    expect(g.listFunctions()).toEqual([]);
  });

  it("addModule creates a module node", () => {
    const g = createDesignGraph();
    const mod = g.addModule("src/db.ts");
    expect(mod.path).toBe("src/db.ts");
    expect(mod.imports).toEqual([]);
    expect(mod.exports).toEqual([]);
    expect(g.getModule("src/db.ts")).toBe(mod);
    expect(g.listModules()).toHaveLength(1);
  });

  it("addModule is idempotent — re-adding returns the existing node", () => {
    const g = createDesignGraph();
    const m1 = g.addModule("src/db.ts");
    const m2 = g.addModule("src/db.ts");
    expect(m1).toBe(m2);
    expect(g.listModules()).toHaveLength(1);
  });
});

describe("DesignGraph — functions", () => {
  it("addFunction attaches to its module and records signature", () => {
    const g = createDesignGraph();
    g.addModule("src/db.ts");
    const fn = g.addFunction(
      "src/db.ts",
      "connectDb",
      sig([{ name: "path", type: "string" }], "Database"),
      "Opens a SQLite database at the given path.",
    );
    expect(fn.module).toBe("src/db.ts");
    expect(fn.name).toBe("connectDb");
    expect(fn.signature.params).toHaveLength(1);
    expect(fn.signature.returnType).toBe("Database");
    expect(fn.status).toBe("declared");
    expect(fn.implementation).toBeNull();
    expect(g.getModule("src/db.ts")!.exports).toContain("connectDb");
  });

  it("addFunction auto-creates the module if it doesn't exist yet", () => {
    const g = createDesignGraph();
    g.addFunction("src/new.ts", "foo", sig([]), "noop");
    expect(g.getModule("src/new.ts")).toBeDefined();
  });

  it("getFunction retrieves by module + name", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    expect(g.getFunction("src/a.ts", "foo")).toBeDefined();
    expect(g.getFunction("src/a.ts", "bar")).toBeUndefined();
  });

  it("addFunction rejects duplicate name in same module", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    expect(() =>
      g.addFunction("src/a.ts", "foo", sig([]), ""),
    ).toThrow(/duplicate|already/i);
  });

  it("rejects a second function with the same name even under a different module", () => {
    // Proc-ts layout: filename = name. Two `helper` would clobber each
    // other at materialize time, so names must be globally unique.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "helper", sig([]), "");
    expect(() =>
      g.addFunction("src/b.ts", "helper", sig([]), ""),
    ).toThrow(/duplicate|globally unique/i);
  });

  it("rejects invalid function names", () => {
    const g = createDesignGraph();
    expect(() => g.addFunction("src/a.ts", "foo/bar", sig([]), "")).toThrow(
      /identifier/i,
    );
    expect(() => g.addFunction("src/a.ts", "my.fn", sig([]), "")).toThrow(
      /identifier/i,
    );
    expect(() => g.addFunction("src/a.ts", "", sig([]), "")).toThrow(
      /identifier/i,
    );
  });
});

describe("DesignGraph — imports", () => {
  it("addImport records the dep edge on the target module", () => {
    const g = createDesignGraph();
    g.addModule("src/a.ts");
    g.addModule("src/b.ts");
    g.addImport("src/b.ts", "foo", "src/a.ts");
    expect(g.getModule("src/b.ts")!.imports).toContainEqual({
      symbol: "foo",
      from: "src/a.ts",
    });
  });

  it("addImport is idempotent on the same (symbol, from) pair", () => {
    const g = createDesignGraph();
    g.addImport("src/b.ts", "foo", "src/a.ts");
    g.addImport("src/b.ts", "foo", "src/a.ts");
    expect(g.getModule("src/b.ts")!.imports).toHaveLength(1);
  });
});

describe("DesignGraph — tests", () => {
  const t = (name: string, code = "expect(true).toBe(true);"): TestSpec => ({
    name,
    code,
  });

  it("addTest attaches to a function; tests is an ordered list", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "add", sig([{ name: "a", type: "number" }, { name: "b", type: "number" }], "number"), "");
    g.addTest("src/a.ts", "add", t("returns sum"));
    g.addTest("src/a.ts", "add", t("handles zero"));
    const fn = g.getFunction("src/a.ts", "add")!;
    expect(fn.tests).toHaveLength(2);
    expect(fn.tests[0].name).toBe("returns sum");
  });

  it("addTest rejects when the function doesn't exist", () => {
    const g = createDesignGraph();
    expect(() => g.addTest("src/a.ts", "nope", t("x"))).toThrow(/not found/i);
  });
});

describe("DesignGraph — implementation + status", () => {
  it("setImplementation records source and transitions status", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "add", sig([{ name: "a", type: "number" }, { name: "b", type: "number" }], "number"), "");
    g.setImplementation("src/a.ts", "add", "return a + b;");
    const fn = g.getFunction("src/a.ts", "add")!;
    expect(fn.implementation).toBe("return a + b;");
    expect(fn.status).toBe("implemented");
  });

  it("setTestStatus updates status + lastTestOutput", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "add", sig([]), "");
    g.setImplementation("src/a.ts", "add", "return 1;");
    g.setTestStatus("src/a.ts", "add", "tests-green", "2 passed");
    const fn = g.getFunction("src/a.ts", "add")!;
    expect(fn.status).toBe("tests-green");
    expect(fn.lastTestOutput).toBe("2 passed");
  });

  it("setImplementation rejects when the function is unknown", () => {
    const g = createDesignGraph();
    expect(() => g.setImplementation("src/a.ts", "nope", "return 1;")).toThrow(
      /not found/i,
    );
  });
});

describe("DesignGraph — coverage query", () => {
  it("allImplemented reflects whether every declared function has source", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addFunction("src/a.ts", "bar", sig([]), "");
    expect(g.allImplemented()).toBe(false);
    g.setImplementation("src/a.ts", "foo", "return 1;");
    expect(g.allImplemented()).toBe(false);
    g.setImplementation("src/a.ts", "bar", "return 2;");
    expect(g.allImplemented()).toBe(true);
  });

  it("allTestsGreen is true only when every function is implemented AND tests-green", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    expect(g.allTestsGreen()).toBe(false);
    g.setImplementation("src/a.ts", "foo", "return 1;");
    // implemented but tests not run
    expect(g.allTestsGreen()).toBe(false);
    g.setTestStatus("src/a.ts", "foo", "tests-green", "");
    expect(g.allTestsGreen()).toBe(true);
    g.setTestStatus("src/a.ts", "foo", "tests-red", "1 failed");
    expect(g.allTestsGreen()).toBe(false);
  });
});

describe("DesignGraph — consistency validator (proc-ts)", () => {
  it("clean graph: zero violations, zero advisories", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addTest("src/a.ts", "foo", { name: "t", code: "expect(1).toBe(1);" });
    const r = g.consistency();
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("no_tests is advisory, not blocking", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    const r = g.consistency();
    expect(r.ok).toBe(true);
    expect(
      r.advisories.some((a) => a.kind === "no_tests" && a.function === "foo"),
    ).toBe(true);
  });

  it("no longer validates import edges — proc-ts uses ctx.fns", () => {
    // In the proc-ts layout, functions don't import each other — they
    // call via `ctx.fns.<name>(ctx, …)`. The import-edge validation is
    // a no-op to avoid phantom violations on metadata-only design_import
    // entries.
    const g = createDesignGraph();
    g.addFunction("src/b.ts", "bar", sig([]), "");
    g.addImport("src/b.ts", "ghost", "src/missing.ts");
    const r = g.consistency();
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("DesignGraph — architect-rejected status", () => {
  it("accepts 'architect-rejected' as a valid setTestStatus value", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]));
    g.setTestStatus("src/a.ts", "foo", "architect-rejected", "output");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("architect-rejected");
  });
});

describe("DesignGraph — isAsync auto-derivation", () => {
  it("addFunction forces isAsync=true when returnType starts with Promise<", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [],
      returnType: "Promise<string>",
      isAsync: false, // LLM slipped
    });
    expect(g.getFunction("src/a.ts", "foo")!.signature.isAsync).toBe(true);
  });

  it("addFunction preserves isAsync=false for non-Promise returnType", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [],
      returnType: "string",
      isAsync: false,
    });
    expect(g.getFunction("src/a.ts", "foo")!.signature.isAsync).toBe(false);
  });

  it("addFunction wraps returnType in Promise<...> when isAsync=true but returnType isn't a Promise", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [],
      returnType: "string",
      isAsync: true,
    });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.signature.returnType).toBe("Promise<string>");
    expect(fn.signature.isAsync).toBe(true);
  });

  it("addFunction leaves Promise<T> alone when isAsync=true", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [],
      returnType: "Promise<number>",
      isAsync: true,
    });
    expect(g.getFunction("src/a.ts", "foo")!.signature.returnType).toBe(
      "Promise<number>",
    );
  });

  it("addFunctionChild forces isAsync=true when returnType is Promise<T>", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "child",
      { params: [], returnType: "Promise<void>", isAsync: false },
    );
    expect(g.getFunction("src/a.ts", "child")!.signature.isAsync).toBe(true);
  });
});

describe("DesignGraph — spec (architect contract)", () => {
  it("new functions start with spec: null", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    expect(g.getFunction("src/a.ts", "foo")!.spec).toBeNull();
  });

  it("setSpec attaches an Architect-authored contract", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parseBody", sig([]), "");
    g.setSpec("src/a.ts", "parseBody", {
      purpose: "parse form-urlencoded body",
      inputs: [
        { name: "req", type: "IncomingMessage", description: "raw request" },
      ],
      output: {
        type: "Record<string, string>",
        description: "key-value map",
      },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["empty body → {}", "malformed pairs → skip"],
      examples: [{ input: "a=1&b=2", output: '{"a":"1","b":"2"}' }],
    });
    const fn = g.getFunction("src/a.ts", "parseBody")!;
    expect(fn.spec).not.toBeNull();
    expect(fn.spec!.purpose).toContain("parse");
    expect(fn.spec!.edgeCases).toHaveLength(2);
  });

  it("snapshot deep-copies the spec", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.setSpec("src/a.ts", "foo", {
      purpose: "x",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    const snap = g.snapshot();
    expect(snap.functions["src/a.ts#foo"].spec).not.toBeNull();
    expect(snap.functions["src/a.ts#foo"].spec!.purpose).toBe("x");
    // Mutating the stored spec doesn't leak.
    g.getFunction("src/a.ts", "foo")!.spec!.purpose = "mutated";
    expect(snap.functions["src/a.ts#foo"].spec!.purpose).toBe("x");
  });
});

describe("DesignGraph — integration-test layer", () => {
  it("addIntegrationTest attaches to a function's integrationTests (not tests)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addIntegrationTest("src/a.ts", "foo", {
      name: "i1",
      code: "expect(1).toBe(1);",
    });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.tests).toHaveLength(0);
    expect(fn.integrationTests).toHaveLength(1);
    expect(fn.integrationTests[0].name).toBe("i1");
  });

  it("replaceTests replaces the entire unit-test list in one call", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addTest("src/a.ts", "foo", { name: "old", code: "x" });
    g.replaceTests("src/a.ts", "foo", [
      { name: "new1", code: "a" },
      { name: "new2", code: "b" },
    ]);
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.tests.map((t) => t.name)).toEqual(["new1", "new2"]);
  });

  it("replaceIntegrationTests replaces the integration-test list", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addIntegrationTest("src/a.ts", "foo", { name: "old", code: "x" });
    g.replaceIntegrationTests("src/a.ts", "foo", [
      { name: "ni", code: "z" },
    ]);
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.integrationTests.map((t) => t.name)).toEqual(["ni"]);
  });

  it("addProjectTest + listProjectTests", () => {
    const g = createDesignGraph();
    g.addProjectTest({ name: "p1", code: "expect(1).toBe(1);" });
    g.addProjectTest({ name: "p2", code: "expect(2).toBe(2);" });
    expect(g.listProjectTests().map((t) => t.name)).toEqual(["p1", "p2"]);
  });

  it("materialize emits <name>.integration.test.ts when a branch has integration tests", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig([]), "");
    g.addFunctionChild("root", "src/a.ts", "child", sig([]), "");
    g.addIntegrationTest("src/a.ts", "root", {
      name: "assembly works",
      code: "expect(root(ctx)).toBeUndefined();",
    });
    const files = g.materialize();
    expect(files["root.integration.test.ts"]).toBeDefined();
    expect(files["root.integration.test.ts"]).toContain("root (integration)");
    expect(files["root.integration.test.ts"]).toContain("assembly works");
    // Integration wiring is const (no stubbing allowed).
    expect(files["root.integration.test.ts"]).toContain("const ctx");
  });

  it("materialize omits integration test file when there are no integration tests", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addTest("src/a.ts", "foo", { name: "u", code: "expect(1).toBe(1);" });
    const files = g.materialize();
    expect(files["foo.test.ts"]).toBeDefined();
    expect(files["foo.integration.test.ts"]).toBeUndefined();
  });

  it("materialize emits project.integration.test.ts when projectTests exist", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addProjectTest({
      name: "end-to-end",
      code: "expect(foo(ctx)).toBeUndefined();",
    });
    const files = g.materialize();
    expect(files["project.integration.test.ts"]).toBeDefined();
    expect(files["project.integration.test.ts"]).toContain("project integration");
    expect(files["project.integration.test.ts"]).toContain("end-to-end");
  });

  it("does NOT emit integration test file for a leaf function", () => {
    // Integration tests only make sense on branches — a leaf's
    // integration test would run against sibling stubs at dispatch time.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "leaf", sig([]), "");
    g.addIntegrationTest("src/a.ts", "leaf", {
      name: "spurious",
      code: "expect(1).toBe(1);",
    });
    const files = g.materialize();
    expect(files["leaf.integration.test.ts"]).toBeUndefined();
  });

  it("snapshot() includes projectTests", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    g.addProjectTest({ name: "e2e", code: "expect(1).toBe(1);" });
    const snap = g.snapshot();
    expect(snap.projectTests).toHaveLength(1);
    expect(snap.projectTests[0].name).toBe("e2e");
  });

  it("strips a leading `ctx` param if the planner includes it", () => {
    // The emitter always prepends `ctx: Ctx` to every function's
    // signature. If the planner mistakenly includes `ctx` in its
    // params, we'd produce `function foo(ctx: Ctx, ctx: Ctx, ...)` —
    // a TS parse error. Defensive strip guarantees single injection.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [
        { name: "ctx", type: "Ctx" },
        { name: "x", type: "string" },
      ],
      returnType: "void",
    });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.signature.params).toEqual([{ name: "x", type: "string" }]);
    const files = g.materialize();
    expect(files["foo.ts"]).toContain("function foo(ctx: Ctx, x: string)");
    expect(files["foo.ts"]).not.toContain("ctx: Ctx, ctx: Ctx");
  });

  it("rejects `project` as a reserved function name", () => {
    const g = createDesignGraph();
    expect(() => g.addFunction("src/a.ts", "project", sig([]), "")).toThrow(
      /reserved|project/,
    );
  });

  it("omits project integration file when no projectTests", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    const files = g.materialize();
    expect(files["project.integration.test.ts"]).toBeUndefined();
  });
});

describe("DesignGraph — tree structure", () => {
  it("addFunction with no parent creates a root node", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([]), "");
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.parent).toBeNull();
    expect(fn.children).toEqual([]);
    expect(g.listRoots().map((f) => f.name)).toEqual(["foo"]);
  });

  it("addFunctionChild links the child to its parent and updates both sides", () => {
    const g = createDesignGraph();
    g.addFunction("src/root.ts", "handleSign", sig([]), "");
    g.addFunctionChild(
      "handleSign",
      "src/root.ts",
      "parseBody",
      sig([]),
      "",
    );
    const parent = g.getFunction("src/root.ts", "handleSign")!;
    const child = g.getFunction("src/root.ts", "parseBody")!;
    expect(parent.children).toEqual(["parseBody"]);
    expect(child.parent).toBe("handleSign");
    expect(g.listRoots().map((f) => f.name)).toEqual(["handleSign"]);
    expect(g.listChildren("handleSign").map((f) => f.name)).toEqual([
      "parseBody",
    ]);
  });

  it("addFunctionChild rejects an unknown parent", () => {
    const g = createDesignGraph();
    expect(() =>
      g.addFunctionChild("ghost", "src/a.ts", "foo", sig([]), ""),
    ).toThrow(/parent not found/);
  });

  it("hasChildren is true for an inner node, false for a leaf", () => {
    const g = createDesignGraph();
    g.addFunction("src/r.ts", "root", sig([]), "");
    g.addFunctionChild("root", "src/r.ts", "leaf", sig([]), "");
    expect(g.hasChildren("root")).toBe(true);
    expect(g.hasChildren("leaf")).toBe(false);
  });

  it("topoSortFunctions emits children before parents", () => {
    // Tree: root -> [a, b]; a -> [aa]
    const g = createDesignGraph();
    g.addFunction("src/r.ts", "root", sig([]), "");
    g.addFunctionChild("root", "src/r.ts", "a", sig([]), "");
    g.addFunctionChild("root", "src/r.ts", "b", sig([]), "");
    g.addFunctionChild("a", "src/r.ts", "aa", sig([]), "");
    const order = g.topoSortFunctions().map((f) => f.name);
    // aa must come before a; a and b must come before root
    expect(order.indexOf("aa")).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("root"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("root"));
  });

  it("listRoots returns multiple roots when present", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root1", sig([]), "");
    g.addFunction("src/a.ts", "root2", sig([]), "");
    g.addFunctionChild("root1", "src/a.ts", "child1", sig([]), "");
    expect(g.listRoots().map((f) => f.name).sort()).toEqual(["root1", "root2"]);
  });
});

describe("DesignGraph — materialize() (proc-ts layout)", () => {
  it("empty graph → empty file set", () => {
    const g = createDesignGraph();
    expect(g.materialize()).toEqual({});
  });

  it("emits one <fnName>.ts per function with ctx:Ctx as first param", () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/math.ts",
      "add",
      sig([{ name: "a", type: "number" }, { name: "b", type: "number" }], "number"),
      "",
    );
    g.setImplementation("src/math.ts", "add", "return a + b;");
    const files = g.materialize();
    expect(files["add.ts"]).toBeDefined();
    expect(files["add.ts"]).toMatch(
      /export default function add\(ctx: Ctx, a: number, b: number\): number \{/,
    );
    expect(files["add.ts"]).toContain("return a + b;");
  });

  it("emits a stub throwing TODO when implementation is missing", () => {
    const g = createDesignGraph();
    g.addFunction("src/todo.ts", "foo", sig([], "void"), "");
    const files = g.materialize();
    expect(files["foo.ts"]).toContain("throw new Error");
    expect(files["foo.ts"]).toMatch(/not implemented|TODO/i);
  });

  it("emits ctx.ts with global Ctx declaration", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([], "void"), "");
    const files = g.materialize();
    expect(files["ctx.ts"]).toBeDefined();
    expect(files["ctx.ts"]).toContain("export type Ctx");
    expect(files["ctx.ts"]).toContain("declare global");
    expect(files["ctx.ts"]).toContain("fns: CtxFns");
  });

  it("emits auto-generated ctx_fns.d.ts listing every function", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([], "void"), "");
    g.addFunction("src/a.ts", "bar", sig([], "void"), "");
    const files = g.materialize();
    expect(files["ctx_fns.d.ts"]).toContain(
      'foo: typeof import("./foo").default',
    );
    expect(files["ctx_fns.d.ts"]).toContain(
      'bar: typeof import("./bar").default',
    );
  });

  it("emits a companion <fnName>.test.ts for each function with tests", () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/math.ts",
      "add",
      sig([{ name: "a", type: "number" }, { name: "b", type: "number" }], "number"),
      "",
    );
    g.addTest("src/math.ts", "add", {
      name: "returns the sum",
      code: "expect(add(ctx, 1, 2)).toBe(3);",
    });
    const files = g.materialize();
    expect(files["add.test.ts"]).toBeDefined();
    const test = files["add.test.ts"];
    expect(test).toContain('import add from "./add.js"');
    expect(test).toContain("returns the sum");
    expect(test).toContain("expect(add(ctx, 1, 2)).toBe(3);");
    expect(test).toContain("fns: { add");
  });

  it("preserves signature for async functions", () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/api.ts",
      "fetchUser",
      { params: [{ name: "id", type: "string" }], returnType: "User", isAsync: true },
      "",
    );
    g.setImplementation("src/api.ts", "fetchUser", "return await get(id);");
    expect(g.materialize()["fetchUser.ts"]).toMatch(
      /export default async function fetchUser/,
    );
  });

  it("handles optional params with `?`", () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/api.ts",
      "greet",
      sig(
        [
          { name: "name", type: "string" },
          { name: "title", type: "string", optional: true },
        ],
        "string",
      ),
      "",
    );
    g.setImplementation("src/api.ts", "greet", "return title ? `${title} ${name}` : name;");
    expect(g.materialize()["greet.ts"]).toMatch(/name: string, title\?: string/);
  });
});

describe("DesignGraph — snapshot", () => {
  it("returns a plain-data representation round-trippable in JSON", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig([{ name: "x", type: "number" }], "number"), "noop");
    g.addTest("src/a.ts", "foo", { name: "positive", code: "expect(foo(1)).toBeGreaterThan(0);" });
    g.addImport("src/a.ts", "someUtil", "src/utils.ts");

    const snap = g.snapshot();
    const round = JSON.parse(JSON.stringify(snap));
    expect(round.modules["src/a.ts"].exports).toContain("foo");
    expect(round.functions["src/a.ts#foo"].name).toBe("foo");
    expect(round.functions["src/a.ts#foo"].tests).toHaveLength(1);
  });
});

// Former "file-extension-aware rendering" tests removed — the proc-ts
// emitter always produces TypeScript files with `ctx: Ctx` injection,
// regardless of the module path. Extension in `module` is informational
// only.
