import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  designCleanup,
  autoRepairCleanup,
} from "../../src/rlm/design-cleanup.js";

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
    g.setImplementation(
      "src/a.ts",
      "root",
      `import helper from "./helper.js";\nexport default function root(): void { helper(); }`,
    );
    g.setAnalyzedEdges("src/a.ts", "root", {
      imports: [{ source: "./helper.js", name: "helper", isDefault: true, line: 1 }],
      callees: ["helper"],
    });
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
    g.setImplementation(
      "src/a.ts",
      "parent",
      `import assembler from "./assembler.js";\nexport default function parent(): void { assembler(); }`,
    );
    g.setAnalyzedEdges("src/a.ts", "parent", {
      imports: [
        { source: "./assembler.js", name: "assembler", isDefault: true, line: 1 },
      ],
      callees: ["assembler"],
    });
    g.addFunctionChild("parent", "src/a.ts", "assembler", sig());
    g.setSpec("src/a.ts", "assembler", spec(["partA", "partB"]));
    g.setImplementation(
      "src/a.ts",
      "assembler",
      `import partA from "./partA.js";\nimport partB from "./partB.js";\nexport default function assembler(): void { partA(); partB(); }`,
    );
    g.setAnalyzedEdges("src/a.ts", "assembler", {
      imports: [
        { source: "./partA.js", name: "partA", isDefault: true, line: 1 },
        { source: "./partB.js", name: "partB", isDefault: true, line: 2 },
      ],
      callees: ["partA", "partB"],
    });
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
    g.setImplementation(
      "src/a.ts",
      "caller",
      `import usedDep from "./usedDep.js";\nexport default function caller(): void { usedDep(); }`,
    );
    g.setAnalyzedEdges("src/a.ts", "caller", {
      imports: [
        { source: "./usedDep.js", name: "usedDep", isDefault: true, line: 1 },
      ],
      callees: ["usedDep"],
    });
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

// Phase U8 — the arity-mismatch cleanup check was retired. It parsed
// `ctx.fns.X(ctx, ...args)` call sites and compared arg-count against
// the callee's declared params. Under natural mode the TypeScript
// compiler catches arity mismatches at tsc time, so the heuristic
// became redundant. Tests removed with the machinery.

describe("autoRepairCleanup", () => {
  it("re-dispatches the orphan's DECOMPOSITION PARENT with wire-in feedback", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.setImplementation("src/a.ts", "parent", "return;"); // doesn't call child
    g.addFunctionChild("parent", "src/a.ts", "child", sig());
    g.setSpec("src/a.ts", "child", spec());
    g.setImplementation("src/a.ts", "child", "return;");
    const cleanup = await designCleanup(g);
    expect(cleanup.findings.some((f) => f.name === "child")).toBe(true);

    const calls: Array<{ name: string; feedback?: string }> = [];
    const dispatch = async (_g: any, mod: string, name: string, opts?: any) => {
      calls.push({ name, feedback: opts?.feedback });
      _g.setImplementation(mod, name, "ctx.fns.child(ctx);");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "ctx.fns.child(ctx);",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await autoRepairCleanup(g, cleanup.findings, dispatch);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("parent"); // target is parent, not child
    expect(calls[0].feedback).toMatch(/child/);
    expect(calls[0].feedback).toMatch(/wire|call.*ctx\.fns/i);
    expect(report.repaired).toContain("parent");
  });

  it("re-dispatches the caller with unused-dep feedback", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.setSpec("src/a.ts", "caller", spec(["unusedDep"]));
    g.setImplementation("src/a.ts", "caller", "return;");
    g.addFunction("src/a.ts", "unusedDep", sig());
    g.setSpec("src/a.ts", "unusedDep", spec());
    g.setImplementation("src/a.ts", "unusedDep", "return;");
    const cleanup = await designCleanup(g);
    const calls: Array<{ name: string; feedback?: string }> = [];
    const dispatch = async (_g: any, mod: string, name: string, opts?: any) => {
      calls.push({ name, feedback: opts?.feedback });
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    await autoRepairCleanup(g, cleanup.findings, dispatch);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("caller");
    expect(calls[0].feedback).toMatch(/unusedDep/);
    expect(calls[0].feedback).toMatch(/drop.*or.*call|spec\.dependencies/i);
  });

  it("groups multiple findings for the same target into ONE dispatch", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.setImplementation("src/a.ts", "parent", "return;");
    g.addFunctionChild("parent", "src/a.ts", "childA", sig());
    g.setSpec("src/a.ts", "childA", spec());
    g.setImplementation("src/a.ts", "childA", "return;");
    g.addFunctionChild("parent", "src/a.ts", "childB", sig());
    g.setSpec("src/a.ts", "childB", spec());
    g.setImplementation("src/a.ts", "childB", "return;");
    const cleanup = await designCleanup(g);
    // Two body-orphan findings, both targeting parent.
    expect(
      cleanup.findings.filter((f) => f.kind === "body-orphan"),
    ).toHaveLength(2);
    const calls: Array<{ name: string; feedback?: string }> = [];
    const dispatch = async (_g: any, mod: string, name: string, opts?: any) => {
      calls.push({ name, feedback: opts?.feedback });
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    await autoRepairCleanup(g, cleanup.findings, dispatch);
    // ONE dispatch, not two.
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("parent");
    // Both children mentioned in feedback.
    expect(calls[0].feedback).toMatch(/childA/);
    expect(calls[0].feedback).toMatch(/childB/);
  });

  it("reports failed repairs when dispatch doesn't go green", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.setImplementation("src/a.ts", "parent", "return;");
    g.addFunctionChild("parent", "src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    g.setImplementation("src/a.ts", "stuck", "return;");
    const cleanup = await designCleanup(g);
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// stuck",
      attempts: 4,
      testOutput: "",
      error: "stagnation",
    });
    const report = await autoRepairCleanup(g, cleanup.findings, dispatch);
    expect(report.repaired).toEqual([]);
    expect(report.failed).toContain("parent");
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
