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

  // Phase H2 — when projectDir IS set, dispatches must still run in
  // parallel (the old code forced sequential to avoid filesystem races
  // on the shared dir). Each dispatch now gets its own overlay subdir
  // under projectDir so they don't clobber each other's files.
  it("runs same-level dispatches concurrently even when projectDir is set (H2)", async () => {
    const { mkdtemp, rm, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const projectDir = await mkdtemp(path.join(tmpdir(), "rlm-h2-"));
    try {
      const g = createDesignGraph();
      for (const n of ["a", "b", "c", "d"]) {
        g.addFunction("src/a.ts", n, sig());
        g.setSpec("src/a.ts", n, spec());
      }
      let inFlight = 0;
      let maxInFlight = 0;
      const projectDirsSeen = new Set<string>();
      const dispatch = async (
        _g: any,
        mod: string,
        name: string,
        opts?: { projectDir?: string },
      ) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Each dispatch must receive its OWN projectDir (an overlay),
        // not the shared one. Verify the overlay exists on disk WHILE
        // dispatch is running (it'll be cleaned up after — H2b).
        if (opts?.projectDir) {
          projectDirsSeen.add(opts.projectDir);
          const s = await stat(opts.projectDir);
          expect(s.isDirectory()).toBe(true);
        }
        // Yield so parallel dispatches actually overlap.
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
        projectDir,
        maxConcurrent: 4,
      });
      // Parallelism preserved even with projectDir set.
      expect(maxInFlight).toBe(4);
      // Each dispatch got a DIFFERENT overlay (not the raw projectDir).
      expect(projectDirsSeen.size).toBe(4);
      for (const d of projectDirsSeen) {
        expect(d).not.toBe(projectDir);
        // Overlays should be subdirs of projectDir (so node_modules
        // resolution walks up to find the installed deps).
        expect(d.startsWith(projectDir)).toBe(true);
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // Phase H2b — overlay subdirs must be cleaned up after each batch.
  // If left around, later phases (integration tests, fix-dispatches)
  // discover stale `<fn>.test.ts` copies under `.rlm-overlays/*/` via
  // their default test glob and triple-count the same failures.
  it("cleans up overlay subdirs after each dispatch batch (H2b)", async () => {
    const { mkdtemp, rm, stat, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const projectDir = await mkdtemp(path.join(tmpdir(), "rlm-h2b-"));
    try {
      const g = createDesignGraph();
      for (const n of ["a", "b"]) {
        g.addFunction("src/a.ts", n, sig());
        g.setSpec("src/a.ts", n, spec());
      }
      const dispatch = async (
        _g: any,
        mod: string,
        name: string,
        opts?: { projectDir?: string },
      ) => {
        // The overlay must exist during dispatch.
        if (opts?.projectDir) {
          const s = await stat(opts.projectDir);
          expect(s.isDirectory()).toBe(true);
        }
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
        projectDir,
        maxConcurrent: 4,
      });
      // After the batch finishes, the .rlm-overlays dir should be empty
      // (or not exist at all).
      const overlayRoot = path.join(projectDir, ".rlm-overlays");
      try {
        const entries = await readdir(overlayRoot);
        expect(entries).toEqual([]);
      } catch {
        // ENOENT is fine too — means nothing was left behind.
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
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

  it("reflect that throws blocks the function (no pipeline crash)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "x", sig());
    g.setSpec("src/a.ts", "x", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    const reflect = async (): Promise<never> => {
      throw new Error("reflect network error");
    };
    const report = await designLeafUpBuild(g, { dispatch, reflect });
    expect(report.blocked).toContain("x");
    expect(report.error).toBeNull();
  });

  it("reflect revise-child — un-greens the child and re-dispatches it with parent's hint", async () => {
    // E1: parent stagnates because child's shape doesn't fit. Reflect
    // names the child, un-greens it, stashes a hint. Child re-runs
    // with hint; parent retries after child is green.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    g.addFunctionChild("parent", "src/a.ts", "child", sig());
    g.setSpec("src/a.ts", "child", spec());
    const dispatchCalls: Array<{ name: string; feedback?: string }> = [];
    const dispatch = async (gg: any, mod: string, name: string, opts?: any) => {
      dispatchCalls.push({ name, feedback: opts?.feedback });
      // Child always green. Parent stagnates FIRST dispatch only;
      // after reflect un-greens child and child re-greens, parent's
      // next dispatch succeeds.
      if (name === "child") {
        gg.setImplementation(mod, name, "// child impl");
        return {
          module: mod,
          name,
          status: "tests-green" as const,
          implementation: "// child impl",
          attempts: 1,
          testOutput: "",
        };
      }
      // parent
      const parentDispatches = dispatchCalls.filter((c) => c.name === "parent").length;
      if (parentDispatches === 1) {
        return {
          module: mod,
          name,
          status: "stagnated" as const,
          implementation: "// parent red",
          attempts: 4,
          testOutput: "",
        };
      }
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// parent green after child revision",
        attempts: 1,
        testOutput: "",
      };
    };
    const reflect = async () =>
      ({
        kind: "revise-child" as const,
        childName: "child",
        rationale: "child shape",
        hint: "return array, not Map",
      });
    const report = await designLeafUpBuild(g, { dispatch, reflect });
    expect(report.ok).toBe(true);
    // Child dispatched TWICE (once initially, once after revise-child).
    const childCalls = dispatchCalls.filter((c) => c.name === "child");
    expect(childCalls).toHaveLength(2);
    // Second child call got the parent's hint as feedback.
    expect(childCalls[1].feedback).toContain("return array");
    expect(childCalls[1].feedback).toContain("parent");
    // Parent dispatched twice too (stagnated, then retried after child re-green).
    expect(dispatchCalls.filter((c) => c.name === "parent")).toHaveLength(2);
  });

  it("reflect revise-child with nonexistent child — blocks parent", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    const reflect = async () =>
      ({
        kind: "revise-child" as const,
        childName: "imaginary",
        rationale: "bogus",
        hint: "nope",
      });
    const report = await designLeafUpBuild(g, { dispatch, reflect });
    expect(report.blocked).toContain("parent");
  });

  it("reflect retry — re-queues with hint as next dispatch feedback", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    let dispatchN = 0;
    const feedbacks: (string | undefined)[] = [];
    const dispatch = async (_g: any, mod: string, name: string, opts?: any) => {
      dispatchN++;
      feedbacks.push(opts?.feedback);
      if (dispatchN === 1) {
        return {
          module: mod,
          name,
          status: "stagnated" as const,
          implementation: "// red",
          attempts: 4,
          testOutput: "expected 42",
        };
      }
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    let reflectCalls = 0;
    const reflect = async () => {
      reflectCalls++;
      return {
        kind: "retry" as const,
        rationale: "wrong shape",
        hint: "use URLSearchParams",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch, reflect });
    expect(report.ok).toBe(true);
    expect(reflectCalls).toBe(1);
    // First dispatch: no feedback. Second dispatch: hint prefixed.
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("URLSearchParams");
    expect(feedbacks[1]).toContain("retry");
  });

  it("reflect give-up — marks blocked, skips decompose", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "doomed", sig());
    g.setSpec("src/a.ts", "doomed", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    let decomposeCalls = 0;
    const decompose = async () => {
      decomposeCalls++;
      return true;
    };
    const reflect = async () =>
      ({ kind: "give-up" as const, rationale: "impossible" });
    const report = await designLeafUpBuild(g, {
      dispatch,
      decompose,
      reflect,
    });
    expect(report.blocked).toContain("doomed");
    expect(decomposeCalls).toBe(0);
  });

  it("reflect decompose — delegates to the decompose callback", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "complex", sig());
    g.setSpec("src/a.ts", "complex", spec());
    let dispatchN = 0;
    const dispatch = async (gg: any, mod: string, name: string) => {
      dispatchN++;
      if (name === "complex" && dispatchN === 1) {
        return {
          module: mod,
          name,
          status: "stagnated" as const,
          implementation: "// red",
          attempts: 4,
          testOutput: "",
        };
      }
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
      gg.addFunctionChild(fnName, "src/a.ts", "child", sig());
      gg.setSpec("src/a.ts", "child", spec());
      return true;
    };
    const reflect = async () =>
      ({ kind: "decompose" as const, rationale: "three concerns" });
    const report = await designLeafUpBuild(g, {
      dispatch,
      decompose,
      reflect,
    });
    expect(decomposeCalls).toBe(1);
    expect(report.decomposed).toContain("complex");
  });

  it("stagnation AFTER reflect — blocks without a second reflect", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "persistent", sig());
    g.setSpec("src/a.ts", "persistent", spec());
    const dispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "stagnated" as const,
      implementation: "// red",
      attempts: 4,
      testOutput: "",
    });
    let reflectCalls = 0;
    const reflect = async () => {
      reflectCalls++;
      return {
        kind: "retry" as const,
        rationale: "try again",
        hint: "idk",
      };
    };
    const report = await designLeafUpBuild(g, { dispatch, reflect });
    expect(report.blocked).toContain("persistent");
    // Exactly ONE reflect call — the retry stagnated and we don't
    // reflect again (would loop).
    expect(reflectCalls).toBe(1);
  });

  it("refused decompose preserves the prior stagnated body", async () => {
    // A3: when decompose refuses (returns false without adding
    // children), we no longer destroy the body from the stagnation
    // attempt. Keeping the body gives downstream tooling (reflect,
    // finalize) something to work with instead of a null body.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "tried", sig());
    g.setSpec("src/a.ts", "tried", spec());
    const dispatch = async (gg: any, mod: string, name: string) => {
      gg.setImplementation(mod, name, "// best attempt — red but preserved");
      return {
        module: mod,
        name,
        status: "stagnated" as const,
        implementation: "// best attempt — red but preserved",
        attempts: 4,
        testOutput: "",
      };
    };
    const decompose = async () => false; // refuse
    await designLeafUpBuild(g, { dispatch, decompose });
    const fn = g.getFunction("src/a.ts", "tried")!;
    expect(fn.implementation).toBe("// best attempt — red but preserved");
  });

  it("accepted decompose clears the parent's body (child will re-author)", async () => {
    // Complement to the refuse case: when decompose adds children,
    // the parent's prior body is stale (it was written against no
    // children). Clearing it forces a fresh re-dispatch after
    // children are green.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", sig());
    g.setSpec("src/a.ts", "parent", spec());
    let parentDispatchCount = 0;
    const dispatch = async (gg: any, mod: string, name: string) => {
      parentDispatchCount += name === "parent" ? 1 : 0;
      if (name === "parent" && parentDispatchCount === 1) {
        // First parent call: stagnate with a body.
        gg.setImplementation(mod, name, "// stale pre-decompose body");
        return {
          module: mod,
          name,
          status: "stagnated" as const,
          implementation: "// stale pre-decompose body",
          attempts: 4,
          testOutput: "",
        };
      }
      gg.setImplementation(mod, name, "// fresh ok");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// fresh ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const decompose = async (gg: any, fnName: string) => {
      gg.addFunctionChild(fnName, "src/a.ts", "kid", sig());
      gg.setSpec("src/a.ts", "kid", spec());
      return true;
    };
    await designLeafUpBuild(g, { dispatch, decompose });
    // Parent re-dispatched after child green; body must be the fresh
    // one, not the stale pre-decompose body.
    expect(g.getFunction("src/a.ts", "parent")!.implementation).toBe(
      "// fresh ok",
    );
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
