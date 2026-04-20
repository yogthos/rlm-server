import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designCleanup } from "../../src/rlm/design-cleanup.js";

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

describe("designCleanup — body-orphan detection", () => {
  it("reports ok=true when every non-root function is reached", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["helper"]));
    g.setImplementation("src/a.ts", "root", "ctx.fns.helper(ctx);");
    g.addFunctionChild("root", "src/a.ts", "helper", sig());
    g.setSpec("src/a.ts", "helper", spec());
    g.setImplementation("src/a.ts", "helper", "return;");
    const r = await designCleanup(g);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.entryPoints).toEqual(["root"]);
    expect(r.reachable.sort()).toEqual(["helper", "root"]);
  });

  it("flags a decomposition child whose body no caller reaches", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.setImplementation("src/a.ts", "parent", "return;"); // doesn't call child
    g.addFunctionChild("parent", "src/a.ts", "orphanChild", sig());
    g.setSpec("src/a.ts", "orphanChild", spec());
    g.setImplementation("src/a.ts", "orphanChild", "return;");
    const r = await designCleanup(g);
    expect(r.ok).toBe(false);
    const orphans = r.findings.filter((f) => f.kind === "body-orphan");
    expect(orphans.map((o) => o.name)).toContain("orphanChild");
    expect(r.reachable).not.toContain("orphanChild");
  });

  it("does NOT flag a child reached TRANSITIVELY via a sibling", async () => {
    // parent → assembler → [partA, partB]
    // parent's body only calls assembler; assembler calls partA and partB.
    // partA and partB are reachable transitively.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec(["assembler"]));
    g.setImplementation("src/a.ts", "parent", "ctx.fns.assembler(ctx);");
    g.addFunctionChild("parent", "src/a.ts", "assembler", sig());
    g.setSpec("src/a.ts", "assembler", spec(["partA", "partB"]));
    g.setImplementation(
      "src/a.ts",
      "assembler",
      "ctx.fns.partA(ctx); ctx.fns.partB(ctx);",
    );
    g.addFunctionChild("parent", "src/a.ts", "partA", sig());
    g.setSpec("src/a.ts", "partA", spec());
    g.setImplementation("src/a.ts", "partA", "return;");
    g.addFunctionChild("parent", "src/a.ts", "partB", sig());
    g.setSpec("src/a.ts", "partB", spec());
    g.setImplementation("src/a.ts", "partB", "return;");
    const r = await designCleanup(g);
    expect(r.ok).toBe(true);
    expect(r.reachable.sort()).toEqual([
      "assembler",
      "parent",
      "partA",
      "partB",
    ]);
  });

  it("skips functions with no body (not yet implemented — caller's problem)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.setImplementation("src/a.ts", "parent", "return;");
    g.addFunctionChild("parent", "src/a.ts", "unimpl", sig());
    g.setSpec("src/a.ts", "unimpl", spec());
    // No setImplementation for unimpl.
    const r = await designCleanup(g);
    const orphans = r.findings.filter((f) => f.kind === "body-orphan");
    // unimpl has no body → skipped (not reported as body-orphan).
    expect(orphans).toEqual([]);
  });
});

describe("designCleanup — unused-dep detection", () => {
  it("flags a spec dep the body never calls", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec(["usedDep", "unusedDep"]));
    g.setImplementation("src/a.ts", "caller", "ctx.fns.usedDep(ctx);");
    g.addFunction("src/a.ts", "usedDep", sig());
    g.setSpec("src/a.ts", "usedDep", spec());
    g.setImplementation("src/a.ts", "usedDep", "return;");
    g.addFunction("src/a.ts", "unusedDep", sig());
    g.setSpec("src/a.ts", "unusedDep", spec());
    g.setImplementation("src/a.ts", "unusedDep", "return;");
    const r = await designCleanup(g);
    const unused = r.findings.filter((f) => f.kind === "unused-dep");
    expect(unused).toHaveLength(1);
    expect(unused[0].name).toBe("caller");
    expect(unused[0].dep).toBe("unusedDep");
  });

  it("ignores phantom deps (not in graph) — coherence covers those", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["phantom"]));
    g.setImplementation("src/a.ts", "foo", "return;");
    const r = await designCleanup(g);
    const unused = r.findings.filter((f) => f.kind === "unused-dep");
    expect(unused).toEqual([]);
  });
});

describe("designCleanup — edge cases", () => {
  it("empty graph returns ok=true", async () => {
    const g = createDesignGraph();
    const r = await designCleanup(g);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.entryPoints).toEqual([]);
  });

  it("root with no body is NOT flagged (entry points are always reachable)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec());
    // No implementation on root.
    const r = await designCleanup(g);
    expect(r.findings).toEqual([]);
  });
});
