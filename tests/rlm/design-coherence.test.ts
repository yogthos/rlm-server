import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designCoherence } from "../../src/rlm/design-coherence.js";

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

describe("designCoherence — structure checks (Round 17)", () => {
  it("reports ok=true for a connected call graph", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["helper"]));
    g.addFunction("src/a.ts", "helper", sig());
    g.setSpec("src/a.ts", "helper", spec());
    const report = await designCoherence(g);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("flags phantom deps — spec lists a name not in the graph", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec(["ghost"]));
    const report = await designCoherence(g);
    expect(report.ok).toBe(false);
    const phantom = report.violations.filter((v) => v.kind === "phantom-dep");
    expect(phantom.map((v) => v.name)).toContain("caller");
    expect(phantom[0].detail).toContain("ghost");
  });

  it("flags orphans — decomposition child that no one depends on", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.addFunctionChild("parent", "src/a.ts", "childA", sig());
    g.setSpec("src/a.ts", "childA", spec());
    const report = await designCoherence(g);
    expect(report.ok).toBe(false);
    const orphans = report.violations.filter((v) => v.kind === "orphan");
    expect(orphans.map((v) => v.name)).toContain("childA");
  });

  it("flags dependency cycles", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"]));
    const report = await designCoherence(g);
    expect(report.ok).toBe(false);
    const cycles = report.violations.filter((v) => v.kind === "cycle");
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].detail).toMatch(/a.*b|b.*a/);
  });

  it("does NOT flag roots (parent=null) as orphans — they're legit entry points", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "rootA", sig());
    g.setSpec("src/a.ts", "rootA", spec());
    g.addFunction("src/a.ts", "rootB", sig());
    g.setSpec("src/a.ts", "rootB", spec());
    const report = await designCoherence(g);
    const orphans = report.violations.filter((v) => v.kind === "orphan");
    expect(orphans).toEqual([]);
  });

  it("ignores functions without specs (early-pipeline callers)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stub", sig());
    // No setSpec — treat as unknown, no violations raised.
    const report = await designCoherence(g);
    expect(report).toBeDefined();
    // A specless leaf can still be a root → no orphan violation.
    const orphans = report.violations.filter((v) => v.kind === "orphan");
    expect(orphans).toEqual([]);
  });

  it("self-cycle produces a cycle violation", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "recursive", sig());
    g.setSpec("src/a.ts", "recursive", spec(["recursive"]));
    const report = await designCoherence(g);
    const cycles = report.violations.filter((v) => v.kind === "cycle");
    expect(cycles.length).toBeGreaterThan(0);
  });
});
