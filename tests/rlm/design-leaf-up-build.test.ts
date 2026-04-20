import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  designLeafUpBuild,
  computeDependencyLevels,
} from "../../src/rlm/design-leaf-up-build.js";

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

describe("computeDependencyLevels", () => {
  it("puts leaves at level 0 and their parents at level 1", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const levels = computeDependencyLevels(g);
    expect(levels.get("leaf")).toBe(0);
    expect(levels.get("root")).toBe(1);
  });

  it("handles a diamond (leaf shared across two parents)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["left", "right"]));
    g.addFunction("src/a.ts", "left", sig());
    g.setSpec("src/a.ts", "left", spec(["leaf"]));
    g.addFunction("src/a.ts", "right", sig());
    g.setSpec("src/a.ts", "right", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const levels = computeDependencyLevels(g);
    expect(levels.get("leaf")).toBe(0);
    expect(levels.get("left")).toBe(1);
    expect(levels.get("right")).toBe(1);
    expect(levels.get("root")).toBe(2);
  });

  it("ignores phantom deps (names not in graph)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["phantom"]));
    const levels = computeDependencyLevels(g);
    expect(levels.get("foo")).toBe(0);
  });

  it("detects a cycle and throws (caller must handle)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"]));
    expect(() => computeDependencyLevels(g)).toThrow(/cycle/i);
  });
});

describe("designLeafUpBuild", () => {
  it("dispatches leaves before parents; dispatches in level order", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const order: string[] = [];
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      _g.setImplementation(mod, name, "// ok");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch });
    expect(report.ok).toBe(true);
    expect(order).toEqual(["leaf", "root"]);
    expect(report.dispatched.sort()).toEqual(["leaf", "root"]);
    expect(report.blocked).toEqual([]);
  });

  it("blocks a parent when its leaf dep returns no body (implementation=null)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const order: string[] = [];
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      return {
        module: mod,
        name,
        status: name === "leaf" ? ("failed" as const) : ("tests-green" as const),
        // null body on the leaf → genuinely blocks parent.
        implementation: name === "leaf" ? null : "// ok",
        attempts: 1,
        testOutput: "",
        error: "stuck",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch });
    expect(report.ok).toBe(false);
    expect(order).toEqual(["leaf"]); // root never dispatched
    expect(report.blocked.sort()).toEqual(["leaf", "root"]);
  });

  it("blocks a parent when the leaf dispatch returns status=failed even with a body", async () => {
    // Pure-TDD pass 2: the Implementer owns body AND tests. If it
    // returns "failed", it couldn't make its own tests pass — the
    // contract is broken. Parents must NOT build on that.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", sig());
    g.setSpec("src/a.ts", "root", spec(["leaf"]));
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    const order: string[] = [];
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      return {
        module: mod,
        name,
        status: name === "leaf" ? ("failed" as const) : ("tests-green" as const),
        // Leaf returned a body (red one) — shouldn't help, parent blocks.
        implementation: "// red body",
        attempts: 1,
        testOutput: "",
        error: "stagnation",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch });
    // Parent NOT dispatched — leaf's tests red means the contract is broken.
    expect(order).toEqual(["leaf"]);
    expect(report.blocked.sort()).toEqual(["leaf", "root"]);
  });

  it("dispatches same-level functions in alphabetical order (deterministic)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "zeta", sig());
    g.setSpec("src/a.ts", "zeta", spec());
    g.addFunction("src/a.ts", "alpha", sig());
    g.setSpec("src/a.ts", "alpha", spec());
    const order: string[] = [];
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      _g.setImplementation(mod, name, "// ok");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    await designLeafUpBuild(g, { dispatch });
    expect(order).toEqual(["alpha", "zeta"]);
  });

  it("flags (but doesn't dispatch) functions with unresolvable cycles", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", sig());
    g.setSpec("src/a.ts", "a", spec(["b"]));
    g.addFunction("src/a.ts", "b", sig());
    g.setSpec("src/a.ts", "b", spec(["a"]));
    const dispatch = async () => {
      throw new Error("should not be called on cycle");
    };
    const report = await designLeafUpBuild(g, { dispatch });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/cycle/i);
  });

  it("reports specless functions as blocked without dispatch (structure check)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "noSpec", sig()); // no setSpec call
    g.addFunction("src/a.ts", "withSpec", sig());
    g.setSpec("src/a.ts", "withSpec", spec());
    const order: string[] = [];
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      _g.setImplementation(mod, name, "// ok");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch });
    expect(report.blocked).toContain("noSpec");
    expect(order).not.toContain("noSpec"); // never dispatched
    expect(order).toContain("withSpec");
  });
});
