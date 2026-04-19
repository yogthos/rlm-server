import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { finalizeProject } from "../../src/rlm/finalize.js";

describe("finalizeProject", () => {
  it("returns ok=false when any function is unimplemented", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const report = await finalizeProject(g, { typecheck: false });
    expect(report.ok).toBe(false);
    expect(report.unimplemented).toContain("src/a.ts#foo");
  });

  it("does NOT populate files when functions are unimplemented", async () => {
    // Otherwise FINAL_FILES(report) would stream stub-throw bodies as
    // if they were finished code.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const report = await finalizeProject(g, { typecheck: false });
    expect(Object.keys(report.files)).toHaveLength(0);
  });

  it("runs the full test suite against the materialized graph", async () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    g.setImplementation("src/math.ts", "add", "return a + b;");

    const report = await finalizeProject(g, { typecheck: false });
    expect(report.ok).toBe(true);
    expect(report.testsPassed).toBeGreaterThanOrEqual(1);
    expect(report.testsFailed).toBe(0);
  }, 30_000);

  it("re-opens functions for dispatch when integration tests fail", async () => {
    // After finalize catches a regression, the Architect's next
    // design_build() must re-dispatch the broken function — so we null
    // its implementation and flip status back to tests-red.
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    g.setImplementation("src/math.ts", "add", "return a - b;");
    g.setTestStatus("src/math.ts", "add", "tests-green", "(stale)");

    const report = await finalizeProject(g, { typecheck: false });
    expect(report.ok).toBe(false);
    expect(report.testsFailed).toBeGreaterThanOrEqual(1);

    const fn = g.getFunction("src/math.ts", "add")!;
    expect(fn.status).toBe("tests-red");
    expect(fn.implementation).toBeNull();
  }, 30_000);

  it("reports test failures when implementations are wrong", async () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    g.setImplementation("src/math.ts", "add", "return a - b;");

    const report = await finalizeProject(g, { typecheck: false });
    expect(report.ok).toBe(false);
    expect(report.testsFailed).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("returns the materialized file set", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setImplementation("src/a.ts", "foo", "return 1;");
    const report = await finalizeProject(g, {
      typecheck: false,
      runTests: false,
    });
    expect(report.files["foo.ts"]).toContain(
      "function foo(ctx: Ctx): number",
    );
    expect(report.files["foo.ts"]).toContain("return 1;");
  });

});
