import { describe, it, expect } from "vitest";
import { createDesignBridge } from "../../src/rlm/design-bridge.js";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

describe("createDesignBridge", () => {
  it("module() adds a module node", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    const r = b.module("src/db.ts");
    expect(r.path).toBe("src/db.ts");
    expect(g.getModule("src/db.ts")).toBeDefined();
  });

  it("function() adds a function and registers the export", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function(
      "src/math.ts",
      "add",
      { params: [{ name: "a", type: "number" }, { name: "b", type: "number" }], returnType: "number" },
      "sum of two ints",
    );
    const fn = g.getFunction("src/math.ts", "add");
    expect(fn).toBeDefined();
    expect(fn!.signature.params).toHaveLength(2);
    expect(g.getModule("src/math.ts")!.exports).toContain("add");
  });

  it("import() records the dep edge", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.module("src/a.ts");
    b.module("src/b.ts");
    b.import("src/b.ts", "foo", "src/a.ts");
    expect(g.getModule("src/b.ts")!.imports).toContainEqual({
      symbol: "foo",
      from: "src/a.ts",
    });
  });

  it("test() attaches to a function", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function("src/a.ts", "foo", { params: [], returnType: "void" });
    b.test("src/a.ts", "foo", { name: "works", code: "expect(true).toBe(true);" });
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(1);
  });

  it("implement() records source and transitions status", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function("src/a.ts", "foo", { params: [], returnType: "number" });
    b.implement("src/a.ts", "foo", "return 1;");
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.implementation).toBe("return 1;");
    expect(fn.status).toBe("implemented");
  });

  it("setTestStatus() updates status + output", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function("src/a.ts", "foo", { params: [], returnType: "number" });
    b.implement("src/a.ts", "foo", "return 1;");
    b.setTestStatus("src/a.ts", "foo", "tests-green", "2 passed");
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.status).toBe("tests-green");
    expect(fn.lastTestOutput).toBe("2 passed");
  });

  it("query() returns a JSON-serializable snapshot", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function("src/a.ts", "foo", { params: [], returnType: "number" });
    const snap = b.query();
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.modules["src/a.ts"]).toBeDefined();
    expect(snap.functions["src/a.ts#foo"]).toBeDefined();
  });

  it("consistency() returns the validation report", () => {
    const g = createDesignGraph();
    const b = createDesignBridge(g);
    b.function("src/b.ts", "bar", { params: [], returnType: "void" });
    // With no tests attached, consistency returns ok:true but surfaces
    // a `no_tests` advisory (proc-ts no longer validates import edges).
    const r = b.consistency();
    expect(r.ok).toBe(true);
    expect(r.advisories.some((a) => a.kind === "no_tests")).toBe(true);
  });
});

describe("DESIGN_IMPL — end-to-end through the sandbox", () => {
  it("design_* builtins reach the DesignGraph from sandbox code", async () => {
    const { createSandbox } = await import("../../src/sandbox.js");
    const { DESIGN_IMPL } = await import("../../src/builtins/index.js");

    const graph = createDesignGraph();
    const bridge = createDesignBridge(graph);

    const sandbox = createSandbox("", {
      builtins: [DESIGN_IMPL],
      globals: { __designBridge: bridge },
      timeoutMs: 5000,
    });

    const result = await sandbox.execute(
      `
      design_module("src/db.ts");
      design_function("src/db.ts", "connect", { params: [{ name: "path", type: "string" }], returnType: "Database" }, "opens sqlite");
      design_test("src/db.ts", "connect", { name: "opens file", code: "expect(true).toBe(true);" });
      const snap = design_query();
      console.log(JSON.stringify({
        modules: Object.keys(snap.modules),
        functions: Object.keys(snap.functions),
      }));
      `,
      5000,
    );

    expect(result.error).toBeUndefined();
    expect(graph.getFunction("src/db.ts", "connect")).toBeDefined();
    expect(graph.getFunction("src/db.ts", "connect")!.tests).toHaveLength(1);
    sandbox.dispose();
  });
});
