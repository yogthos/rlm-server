import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { enumeratePaths } from "../../src/rlm/design-paths.js";

const sig = () => ({ params: [], returnType: "void" });
function spec(deps: string[] = []) {
  return {
    purpose: "x",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: deps,
    edgeCases: [],
    examples: [],
  };
}

describe("enumeratePaths", () => {
  it("returns one path for a linear chain", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["c"]));
    g.addFunction("src/a.ts", "c", sig());
    g.setSpec("src/a.ts", "c", spec());
    const paths = enumeratePaths(g);
    expect(paths).toHaveLength(1);
    expect(paths[0].nodes).toEqual(["a", "b", "c"]);
    expect(paths[0].kind).toBe("complete");
  });

  it("returns two paths for a diamond (common root, common leaf)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["left", "right"]));
    g.addFunction("src/a.ts", "left", sig());
    g.setSpec("src/a.ts", "left", spec(["leaf"]));
    g.addFunction("src/a.ts", "right", sig());
    g.setSpec("src/a.ts", "right", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const paths = enumeratePaths(g);
    expect(paths).toHaveLength(2);
    const names = paths.map((p) => p.nodes.join(">"));
    expect(names).toContain("root>left>leaf");
    expect(names).toContain("root>right>leaf");
  });

  it("flags cyclical paths and truncates at first repeat", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"])); // cycle
    const paths = enumeratePaths(g);
    const cyclical = paths.filter((p) => p.kind === "cyclical");
    expect(cyclical.length).toBeGreaterThan(0);
    // Truncated at the repeat — cyclical path nodes end on the repeated node.
    expect(cyclical[0].nodes[0]).toBe("a");
  });

  it("produces multiple paths when there are multiple roots", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "r1", sig());
    g.setSpec("src/a.ts", "r1", spec(["leaf"]));
    g.addFunction("src/a.ts", "r2", sig());
    g.setSpec("src/a.ts", "r2", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const paths = enumeratePaths(g);
    // r1 and r2 are BOTH call-graph roots (neither is called); leaf is
    // shared. Two distinct entry paths.
    expect(paths).toHaveLength(2);
    const roots = new Set(paths.map((p) => p.nodes[0]));
    expect(roots).toEqual(new Set(["r1", "r2"]));
  });

  it("unused-dep (dep listed but function doesn't exist) does not crash", () => {
    // Robustness: coherence should have caught this, but enumeratePaths
    // shouldn't panic on phantom deps.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["phantom"]));
    const paths = enumeratePaths(g);
    // The phantom dep is treated as a leaf the path ends on — or dropped.
    // Either way, we shouldn't crash and should return at least one path.
    expect(paths.length).toBeGreaterThanOrEqual(1);
  });

  it("respects maxPaths cap — appends a truncated sentinel when exceeded", () => {
    // Build a branchy graph: root → {c1, c2, c3, c4} → {l1, l2, l3, l4}.
    // 16 paths total; cap at 5 and expect 5 + 1 truncated sentinel.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["c1", "c2", "c3", "c4"]));
    for (const c of ["c1", "c2", "c3", "c4"]) {
      g.addFunction("src/a.ts", c, sig());
      g.setSpec("src/a.ts", c, spec(["l1", "l2", "l3", "l4"]));
    }
    for (const l of ["l1", "l2", "l3", "l4"]) {
      g.addFunction("src/a.ts", l, sig());
      g.setSpec("src/a.ts", l, spec());
    }
    const paths = enumeratePaths(g, { maxPaths: 5 });
    // Should cap at 5 complete paths + 1 truncated sentinel.
    expect(paths.length).toBe(6);
    expect(paths.filter((p) => p.kind === "truncated")).toHaveLength(1);
    expect(paths[paths.length - 1].kind).toBe("truncated");
  });

  it("isolated node (no deps, no callers) returns a single-node path", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "solo", sig());
    g.setSpec("src/a.ts", "solo", spec());
    const paths = enumeratePaths(g);
    expect(paths).toHaveLength(1);
    expect(paths[0].nodes).toEqual(["solo"]);
    expect(paths[0].kind).toBe("complete");
  });

  it("falls back to decomposition tree when no specs are attached", () => {
    // If specs haven't landed yet (pre-phase-2), enumeratePaths should
    // still return something sensible using the parent/child tree so
    // callers early in the pipeline don't get an empty list.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.addFunctionChild("root", "src/a.ts", "child", sig());
    const paths = enumeratePaths(g);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0].nodes).toContain("root");
  });
});
