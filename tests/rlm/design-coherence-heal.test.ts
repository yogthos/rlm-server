import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { healStructureCoherence } from "../../src/rlm/design-coherence-heal.js";

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

describe("healStructureCoherence", () => {
  it("mechanically drops phantom deps", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["ghost", "real"]));
    g.addFunction("src/a.ts", "real", sig());
    g.setSpec("src/a.ts", "real", spec());
    const result = await healStructureCoherence(g);
    expect(result.healed).toContain("phantom-dep:foo:ghost");
    const s = g.getFunction("src/a.ts", "foo")!.spec!;
    expect(s.dependencies).toEqual(["real"]);
  });

  it("reports cycles as unhealable (no auto-fix)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"]));
    const result = await healStructureCoherence(g);
    expect(result.ok).toBe(false);
    expect(result.unhealed.length).toBeGreaterThan(0);
    expect(result.unhealed.some((u) => u.includes("cycle"))).toBe(true);
  });

  it("returns ok=true when there are no violations", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const result = await healStructureCoherence(g);
    expect(result.ok).toBe(true);
    expect(result.healed).toEqual([]);
  });

  it("decomposition children do not surface as violations", async () => {
    // Regression for the run 9 cascade: prior behavior flagged a
    // decomposition child (parent !== null) whose parent didn't list
    // it in spec.deps as an "orphan" and burned LLM calls trying to
    // re-wire it. Now the child is considered wired by the parent
    // tree link; heal returns ok immediately.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec());
    g.addFunctionChild("root", "src/a.ts", "child", sig());
    g.setSpec("src/a.ts", "child", spec());
    const result = await healStructureCoherence(g);
    expect(result.ok).toBe(true);
    expect(result.unhealed).toEqual([]);
  });
});
