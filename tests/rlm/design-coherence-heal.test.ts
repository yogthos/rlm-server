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
  it("mechanically drops phantom deps (no LLM call)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["ghost", "real"]));
    g.addFunction("src/a.ts", "real", sig());
    g.setSpec("src/a.ts", "real", spec());
    let chatCalled = false;
    const chat = async () => {
      chatCalled = true;
      return "";
    };
    const result = await healStructureCoherence(g, { chat });
    expect(result.healed).toContain("phantom-dep:foo:ghost");
    expect(chatCalled).toBe(false);
    // Phantom dropped; real kept.
    const s = g.getFunction("src/a.ts", "foo")!.spec!;
    expect(s.dependencies).toEqual(["real"]);
  });

  it("wires an orphan into the parent the LLM picks", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec());
    g.addFunctionChild("root", "src/a.ts", "child", sig());
    g.setSpec("src/a.ts", "child", spec());
    const chat = async () =>
      '```json\n{"caller":"root","action":"add-dep"}\n```';
    const result = await healStructureCoherence(g, { chat });
    expect(result.healed).toContain("orphan:child");
    const rootSpec = g.getFunction("src/a.ts", "root")!.spec!;
    expect(rootSpec.dependencies).toContain("child");
  });

  it("drops the orphan when the LLM says so", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec());
    g.addFunctionChild("root", "src/a.ts", "junk", sig());
    g.setSpec("src/a.ts", "junk", spec());
    const chat = async () =>
      '```json\n{"caller":null,"action":"drop"}\n```';
    const result = await healStructureCoherence(g, { chat });
    expect(result.healed).toContain("orphan:junk");
    // Function removed from the graph.
    expect(g.getFunction("src/a.ts", "junk")).toBeUndefined();
  });

  it("reverts orphan wiring when it would create a cycle", async () => {
    // Setup: orphan `dep` already depends on `caller`. LLM nominates
    // `caller` as the parent to take dep as a dep — this would create
    // `caller` → `dep` → `caller`. Heal must revert and mark unhealed.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec()); // no deps yet
    g.addFunctionChild("caller", "src/a.ts", "dep", sig());
    g.setSpec("src/a.ts", "dep", spec(["caller"])); // dep → caller (makes "dep" an orphan: no one calls it)
    const chat = async () =>
      '```json\n{"caller":"caller","action":"add-dep"}\n```';
    const result = await healStructureCoherence(g, { chat });
    // The heal attempted to wire caller → dep, but that would complete
    // the cycle caller → dep → caller. Must revert.
    expect(result.ok).toBe(false);
    expect(result.unhealed.some((u) => u.includes("orphan:dep"))).toBe(true);
    // Caller's deps must NOT include dep (revert worked).
    const callerSpec = g.getFunction("src/a.ts", "caller")!.spec!;
    expect(callerSpec.dependencies).not.toContain("dep");
  });

  it("reports cycles as unhealable (no auto-fix)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"]));
    const chat = async () => "";
    const result = await healStructureCoherence(g, { chat });
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
    const result = await healStructureCoherence(g, {
      chat: async () => "should not run",
    });
    expect(result.ok).toBe(true);
    expect(result.healed).toEqual([]);
  });

  it("leaves the orphan in place when LLM response is unparseable", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec());
    g.addFunctionChild("root", "src/a.ts", "child", sig());
    g.setSpec("src/a.ts", "child", spec());
    const result = await healStructureCoherence(g, {
      chat: async () => "garbage",
    });
    expect(result.ok).toBe(false);
    expect(result.unhealed.some((u) => u.includes("orphan:child"))).toBe(true);
    // Child still in graph, root's deps unchanged.
    expect(g.getFunction("src/a.ts", "child")).toBeDefined();
    expect(g.getFunction("src/a.ts", "root")!.spec!.dependencies).toEqual([]);
  });
});
