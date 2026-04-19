import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  extractCallsFromCode,
  buildFacts,
  computeRelevantFunctions,
} from "../../src/rlm/prompt-scope.js";

describe("extractCallsFromCode", () => {
  it("finds ctx.fns.<name>(", () => {
    const src = "await ctx.fns.readEntries(ctx); ctx.fns.save(ctx, e);";
    expect(extractCallsFromCode(src).sort()).toEqual(["readEntries", "save"]);
  });
  it("ignores unrelated dot chains", () => {
    const src = "ctx.state.x; other.fns.noop();";
    expect(extractCallsFromCode(src)).toEqual([]);
  });
  it("dedupes", () => {
    expect(
      extractCallsFromCode("ctx.fns.a(ctx); ctx.fns.a(ctx);"),
    ).toEqual(["a"]);
  });
});

function sig(params: Array<{ name: string; type: string }> = [], ret = "void") {
  return { params, returnType: ret };
}

describe("buildFacts", () => {
  it("emits fn, parent_of, and calls facts", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.addFunctionChild("root", "src/a.ts", "child", sig());
    g.addTest("src/a.ts", "root", {
      name: "t",
      code: "await ctx.fns.child(ctx);",
    });
    const facts = buildFacts(g);
    expect(facts).toContain("fn('root').");
    expect(facts).toContain("fn('child').");
    expect(facts).toContain("parent_of('child', 'root').");
    expect(facts).toContain("calls('root', 'child').");
  });

  it("drops calls that reference non-existent functions", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.addTest("src/a.ts", "foo", {
      name: "t",
      code: "ctx.fns.ghostCall(ctx);",
    });
    const facts = buildFacts(g);
    expect(facts).not.toContain("ghostCall");
  });
});

describe("computeRelevantFunctions", () => {
  it("returns just the target when the graph has no edges", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "solo", sig());
    const r = await computeRelevantFunctions(g, "solo");
    expect(r.map((f) => f.name)).toEqual(["solo"]);
  });

  it("pulls in parents, children, siblings, and call deps", async () => {
    const g = createDesignGraph();
    //           root
    //           / \
    //        mid1 mid2
    //         /
    //      leaf
    //      leaf calls lib (unrelated fn) via test code
    g.addFunction("src/a.ts", "root", sig());
    g.addFunctionChild("root", "src/a.ts", "mid1", sig());
    g.addFunctionChild("root", "src/a.ts", "mid2", sig());
    g.addFunctionChild("mid1", "src/a.ts", "leaf", sig());
    g.addFunction("src/a.ts", "lib", sig());
    g.addFunction("src/a.ts", "unrelated", sig());
    g.addTest("src/a.ts", "leaf", {
      name: "t",
      code: "ctx.fns.lib(ctx);",
    });

    const r = await computeRelevantFunctions(g, "leaf");
    const names = r.map((f) => f.name).sort();
    // Expected: leaf (self) + mid1 (parent) + root (ancestor) + lib (call).
    // NOT: mid2 (ancestor's sibling; not leaf's direct sibling),
    //      unrelated (no path).
    expect(names).toContain("leaf");
    expect(names).toContain("mid1");
    expect(names).toContain("root");
    expect(names).toContain("lib");
    expect(names).not.toContain("unrelated");
  });

  it("includes siblings of the target", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.addFunctionChild("root", "src/a.ts", "a", sig());
    g.addFunctionChild("root", "src/a.ts", "b", sig());
    const r = await computeRelevantFunctions(g, "a");
    expect(r.map((f) => f.name).sort()).toEqual(["a", "b", "root"]);
  });

  it("always includes the target even if Prolog misses it", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "self", sig());
    const r = await computeRelevantFunctions(g, "self");
    expect(r.map((f) => f.name)).toContain("self");
  });

  it("returns [] for an unknown target without crashing", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "x", sig());
    const r = await computeRelevantFunctions(g, "ghost");
    expect(r).toEqual([]);
  });
});
