import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

describe("materialize (Phase N2) — natural mode, no ctx scaffolding", () => {
  it("does NOT emit ctx.ts", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const files = g.materialize();
    expect(files["ctx.ts"]).toBeUndefined();
  });

  it("does NOT emit ctx_fns.d.ts", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const files = g.materialize();
    expect(files["ctx_fns.d.ts"]).toBeUndefined();
  });

  it("function stub signature has NO `ctx: Ctx` first parameter", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    const files = g.materialize();
    const src = files["foo.ts"];
    expect(src).toBeDefined();
    expect(src).not.toContain("ctx: Ctx");
    expect(src).toMatch(/function foo\s*\(a:\s*number,\s*b:\s*number\)/);
  });

  it("body wrapping (legacy body-only implementation) no longer injects ctx", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [{ name: "a", type: "number" }],
      returnType: "number",
    });
    // Legacy body-only path (no `export default` token). Still accepted;
    // wrapper must use natural signature.
    g.setImplementation("src/a.ts", "foo", "return a + 1;");
    const files = g.materialize();
    const src = files["foo.ts"];
    expect(src).not.toContain("ctx: Ctx");
    expect(src).toMatch(/function foo\s*\(a:\s*number\)/);
    expect(src).toContain("return a + 1;");
  });

  it("full-file implementations (with export default) pass through unchanged", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", {
      params: [{ name: "a", type: "number" }],
      returnType: "number",
    });
    const body = [
      `import bar from "./bar.js";`,
      `export default function foo(a: number): number {`,
      `  return bar(a) + 1;`,
      `}`,
      "",
    ].join("\n");
    g.setImplementation("src/a.ts", "foo", body);
    const files = g.materialize();
    expect(files["foo.ts"]).toBe(body);
  });
});
