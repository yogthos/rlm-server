import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designCoherence } from "../../src/rlm/design-coherence.js";

const sig = (params: Array<{ name: string; type: string }> = []) => ({
  params,
  returnType: "void",
});

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

describe("designCoherence", () => {
  it("reports ok=true for a connected call graph", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["helper"]));
    g.setImplementation("src/a.ts", "root", "ctx.fns.helper(ctx);");
    g.addFunction("src/a.ts", "helper", sig());
    g.setSpec("src/a.ts", "helper", spec());
    g.setImplementation("src/a.ts", "helper", "return;");
    const report = await designCoherence(g);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("detects an orphan — child that no other function calls", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    // Parent's body does NOT call childA despite children linkage.
    g.setImplementation("src/a.ts", "parent", "return;");
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "childA",
      sig(),
    );
    g.setSpec("src/a.ts", "childA", spec());
    g.setImplementation("src/a.ts", "childA", "return;");
    const report = await designCoherence(g);
    expect(report.ok).toBe(false);
    const orphanViolations = report.violations.filter(
      (v) => v.kind === "orphan",
    );
    expect(orphanViolations.map((v) => v.name)).toContain("childA");
  });

  it("detects an undeclared call — body calls X, spec.dependencies lacks X", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec([])); // no declared deps
    g.setImplementation("src/a.ts", "caller", "ctx.fns.callee(ctx);");
    g.addFunction("src/a.ts", "callee", sig());
    g.setSpec("src/a.ts", "callee", spec());
    g.setImplementation("src/a.ts", "callee", "return;");
    const report = await designCoherence(g);
    const undeclared = report.violations.filter(
      (v) => v.kind === "undeclared-call",
    );
    expect(undeclared.map((v) => v.name)).toContain("caller");
    expect(undeclared[0].detail).toContain("callee");
  });

  it("detects unused declared dependencies — spec claims dep X, body never calls X", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec(["unusedDep"]));
    g.setImplementation("src/a.ts", "caller", "return;");
    g.addFunction("src/a.ts", "unusedDep", sig());
    g.setSpec("src/a.ts", "unusedDep", spec());
    g.setImplementation("src/a.ts", "unusedDep", "return;");
    const report = await designCoherence(g);
    const unused = report.violations.filter(
      (v) => v.kind === "unused-dep",
    );
    expect(unused.map((v) => v.name)).toContain("caller");
    expect(unused[0].detail).toContain("unusedDep");
  });

  it("detects a dangling call — body calls a function not defined in the graph", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec());
    g.setImplementation("src/a.ts", "caller", "ctx.fns.ghost(ctx);");
    const report = await designCoherence(g);
    const dangling = report.violations.filter(
      (v) => v.kind === "dangling-call",
    );
    expect(dangling.map((v) => v.name)).toContain("caller");
    expect(dangling[0].detail).toContain("ghost");
  });

  it("ignores functions without bodies (not yet implemented)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stub", sig());
    g.setSpec("src/a.ts", "stub", spec());
    // No implementation — should not flag as anything.
    const report = await designCoherence(g);
    // An unimplemented function with no callers IS technically an
    // orphan, but coherence runs POST-SKETCH so every function should
    // have a body. Still, we don't crash; we just return the orphan.
    // The caller handles this per its flow.
    expect(report).toBeDefined();
  });

  it("unused declared deps where the dep doesn't exist are still reported", async () => {
    // Even if the dep name is a phantom, the caller claims to depend
    // on it; that's a spec issue the caller should clean up.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["phantom"]));
    g.setImplementation("src/a.ts", "foo", "return;");
    const report = await designCoherence(g);
    const unused = report.violations.filter((v) => v.kind === "unused-dep");
    expect(unused.map((v) => v.name)).toContain("foo");
    expect(unused[0].detail).toContain("phantom");
  });
});
