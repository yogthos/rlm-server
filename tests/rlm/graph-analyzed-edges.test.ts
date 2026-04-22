import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

describe("DesignGraph — analyzed edge fields (Phase N1)", () => {
  it("defaults analyzedImports and analyzedCallees to empty arrays", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.analyzedImports).toEqual([]);
    expect(fn.analyzedCallees).toEqual([]);
  });

  it("setAnalyzedEdges replaces both fields atomically", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [
        { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
        { source: "./x.js", name: "helper", isDefault: false, line: 2 },
      ],
      callees: ["bar", "helper"],
    });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.analyzedImports).toEqual([
      { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
      { source: "./x.js", name: "helper", isDefault: false, line: 2 },
    ]);
    expect(fn.analyzedCallees).toEqual(["bar", "helper"]);
  });

  it("setAnalyzedEdges is idempotent — re-setting overwrites, not appends", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [{ source: "./a.js", name: "a", isDefault: true, line: 1 }],
      callees: ["a"],
    });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [{ source: "./b.js", name: "b", isDefault: true, line: 1 }],
      callees: ["b"],
    });
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.analyzedImports.map((i) => i.name)).toEqual(["b"]);
    expect(fn.analyzedCallees).toEqual(["b"]);
  });

  it("throws when the function doesn't exist", () => {
    const g = createDesignGraph();
    expect(() =>
      g.setAnalyzedEdges("src/a.ts", "missing", {
        imports: [],
        callees: [],
      }),
    ).toThrow(/missing/);
  });

  it("snapshot preserves analyzed edges", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [{ source: "./bar.js", name: "bar", isDefault: true, line: 1 }],
      callees: ["bar"],
    });
    const snap = g.snapshot();
    const restored = snap.functions["src/a.ts#foo"];
    expect(restored.analyzedImports).toEqual([
      { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
    ]);
    expect(restored.analyzedCallees).toEqual(["bar"]);
  });

  it("snapshot copies the arrays — mutations to the snapshot don't leak back", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [{ source: "./bar.js", name: "bar", isDefault: true, line: 1 }],
      callees: ["bar"],
    });
    const snap = g.snapshot();
    snap.functions["src/a.ts#foo"].analyzedCallees.push("WRONG");
    expect(g.getFunction("src/a.ts", "foo")!.analyzedCallees).toEqual([
      "bar",
    ]);
  });
});
