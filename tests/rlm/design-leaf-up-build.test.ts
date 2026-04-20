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

  it("dispatches same-level functions CONCURRENTLY (overlapping awaits)", async () => {
    const g = createDesignGraph();
    for (const n of ["a", "b", "c", "d"]) {
      g.addFunction("src/a.ts", n, sig());
      g.setSpec("src/a.ts", n, spec());
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = async (_g: any, mod: string, name: string) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield for a tick so parallel dispatches actually overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
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
    await designLeafUpBuild(g, { dispatch, maxConcurrent: 4 });
    // With 4 independent L0 functions and maxConcurrent=4, all should
    // have been in flight simultaneously at some point.
    expect(maxInFlight).toBe(4);
  });

  it("clamps maxConcurrent=0 to 1 (doesn't silently block everything)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "solo", sig());
    g.setSpec("src/a.ts", "solo", spec());
    const dispatch = async (_g: any, mod: string, name: string) => {
      _g.setImplementation(mod, name, "// ok");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch, maxConcurrent: 0 });
    // Clamped to 1 → solo dispatched + green.
    expect(report.ok).toBe(true);
    expect(report.blocked).toEqual([]);
  });

  it("forces sequential dispatch when projectDir is set (shared-dir safety)", async () => {
    const g = createDesignGraph();
    for (const n of ["a", "b", "c"]) {
      g.addFunction("src/a.ts", n, sig());
      g.setSpec("src/a.ts", n, spec());
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = async (_g: any, mod: string, name: string) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
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
    await designLeafUpBuild(g, {
      dispatch,
      maxConcurrent: 4,
      projectDir: "/tmp/fake",
    });
    // projectDir set → maxConcurrent clamped to 1.
    expect(maxInFlight).toBe(1);
  });

  it("respects maxConcurrent cap — never dispatches more than N at once", async () => {
    const g = createDesignGraph();
    for (const n of ["a", "b", "c", "d", "e", "f"]) {
      g.addFunction("src/a.ts", n, sig());
      g.setSpec("src/a.ts", n, spec());
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = async (_g: any, mod: string, name: string) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
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
    await designLeafUpBuild(g, { dispatch, maxConcurrent: 2 });
    // 6 functions, concurrency cap 2 → at most 2 in flight simultaneously.
    expect(maxInFlight).toBe(2);
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

  it("stagnated dispatch triggers decompose; parent re-dispatches after children green", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "complex", sig());
    g.setSpec("src/a.ts", "complex", spec());
    const order: string[] = [];
    const decomposeOrder: string[] = [];
    // Dispatch returns "stagnated" for complex on FIRST call.
    // After decompose adds 2 children, next complex dispatch goes green.
    let complexCalls = 0;
    const dispatch = async (_g: any, mod: string, name: string) => {
      order.push(name);
      if (name === "complex") {
        complexCalls++;
        if (complexCalls === 1) {
          return {
            module: mod,
            name,
            status: "stagnated" as const,
            implementation: "// bad",
            attempts: 4,
            testOutput: "",
            error: "stagnation: identical failing-test set across attempts",
          };
        }
      }
      _g.setImplementation(mod, name, "// ok");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const decompose = async (gg: any, fnName: string) => {
      decomposeOrder.push(fnName);
      // Add 2 children to the function.
      gg.addFunctionChild(fnName, "src/a.ts", "c1", sig());
      gg.setSpec("src/a.ts", "c1", spec());
      gg.addFunctionChild(fnName, "src/a.ts", "c2", sig());
      gg.setSpec("src/a.ts", "c2", spec());
      return true;
    };
    const report = await designLeafUpBuild(g, { dispatch, decompose });
    expect(report.ok).toBe(true);
    expect(report.decomposed).toEqual(["complex"]);
    // Expected order: complex (stagnated) → c1 + c2 (children green) →
    // complex (re-dispatched, now green).
    expect(order[0]).toBe("complex");
    expect(order).toContain("c1");
    expect(order).toContain("c2");
    expect(order[order.length - 1]).toBe("complex"); // re-dispatched last
    expect(report.blocked).toEqual([]);
  });

  it("stagnation with no decompose callback blocks the function", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
      error: "stagnation",
    });
    const report = await designLeafUpBuild(g, { dispatch });
    expect(report.ok).toBe(false);
    expect(report.blocked).toContain("stuck");
    expect(report.decomposed).toEqual([]);
  });

  it("blocks the function when decompose returns true but adds no children", async () => {
    // Guard against the empty-decompose infinite loop: if the LLM
    // says "split done" but no children were actually added, we'd
    // re-dispatch the parent against the same deps and stagnate again.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    let decomposeCalls = 0;
    const decompose = async (_g: any, _fn: string) => {
      decomposeCalls++;
      return true; // lies — adds no children
    };
    const report = await designLeafUpBuild(g, { dispatch, decompose });
    expect(report.ok).toBe(false);
    expect(report.blocked).toContain("stuck");
    // Only ONE decompose call — the no-children guard catches the
    // lie on the first return.
    expect(decomposeCalls).toBe(1);
  });

  it("blocks the function on SECOND stagnation after a prior decompose", async () => {
    // Bug guard: a function that stagnates, gets decomposed, and then
    // stagnates again on re-dispatch must be blocked. Decomposing a
    // second time is no-op (designPlan's resume skips phase 1).
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "hard", sig());
    g.setSpec("src/a.ts", "hard", spec());
    let hardCalls = 0;
    const dispatch = async (_g: any, mod: string, name: string) => {
      if (name === "hard") {
        hardCalls++;
        return {
          module: mod,
          name,
          status: "stagnated" as const,
          implementation: "// red",
          attempts: 4,
          testOutput: "",
        };
      }
      _g.setImplementation(mod, name, "// ok");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    let decomposeCalls = 0;
    const decompose = async (gg: any, fnName: string) => {
      decomposeCalls++;
      // Successfully add children on first call.
      gg.addFunctionChild(fnName, "src/a.ts", "ch1", sig());
      gg.setSpec("src/a.ts", "ch1", spec());
      return true;
    };
    const report = await designLeafUpBuild(g, { dispatch, decompose });
    // Decompose fired once. Parent re-dispatched after child green.
    // Parent stagnates again → blocked (not re-decomposed).
    expect(decomposeCalls).toBe(1);
    expect(report.blocked).toContain("hard");
    // hardCalls = 2: initial stagnation + retry stagnation.
    expect(hardCalls).toBe(2);
  });

  it("failed decompose blocks the function (no infinite retry)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "unfixable", sig());
    g.setSpec("src/a.ts", "unfixable", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    const decompose = async () => false; // refuses to split
    const report = await designLeafUpBuild(g, { dispatch, decompose });
    expect(report.ok).toBe(false);
    expect(report.blocked).toContain("unfixable");
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
