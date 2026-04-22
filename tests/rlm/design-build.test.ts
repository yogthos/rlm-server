import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  topoSortFunctions,
  designBuild,
} from "../../src/rlm/design-build.js";

describe("topoSortFunctions", () => {
  it("returns functions in an order where deps precede dependents", () => {
    const g = createDesignGraph();
    g.addFunction("src/util.ts", "helper", { params: [], returnType: "void" });
    g.addFunction("src/app.ts", "main", { params: [], returnType: "void" });
    g.addImport("src/app.ts", "helper", "src/util.ts");
    const order = topoSortFunctions(g);
    const keys = order.map((f) => `${f.module}#${f.name}`);
    expect(keys.indexOf("src/util.ts#helper")).toBeLessThan(
      keys.indexOf("src/app.ts#main"),
    );
  });

  it("ignores external (bare) imports", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addImport("src/a.ts", "readFileSync", "node:fs");
    const order = topoSortFunctions(g);
    expect(order.map((f) => f.name)).toEqual(["foo"]);
  });

  it("returns deterministic order for independent functions (alphabetical by name)", () => {
    // proc-ts layout: names are globally unique. Topo-sort orders
    // siblings by function name (module is metadata).
    const g = createDesignGraph();
    g.addFunction("src/b.ts", "bar", { params: [], returnType: "void" });
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const order = topoSortFunctions(g);
    expect(order.map((f) => f.name)).toEqual(["bar", "foo"]);
  });

  it("tolerates cycles by breaking them deterministically", () => {
    // Cycle: a → b → a. We don't promise a "correct" order (there is
    // none), but we must return every function exactly once without
    // infinite looping.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addFunction("src/b.ts", "bar", { params: [], returnType: "void" });
    g.addImport("src/a.ts", "bar", "src/b.ts");
    g.addImport("src/b.ts", "foo", "src/a.ts");
    const order = topoSortFunctions(g);
    expect(order).toHaveLength(2);
    expect(new Set(order.map((f) => f.name))).toEqual(new Set(["foo", "bar"]));
  });
});

describe("designBuild", () => {
  // Note: the old "consistency violations abort" test was removed in
  // Phase B — proc-ts consistency no longer validates import edges (no
  // imports are emitted between project files).

  it("dispatches each function in topo order and finalizes", async () => {
    const g = createDesignGraph();
    g.addFunction("src/util.ts", "helper", { params: [], returnType: "void" });
    g.addFunction("src/app.ts", "main", { params: [], returnType: "void" });
    g.addImport("src/app.ts", "helper", "src/util.ts");
    g.addTest("src/util.ts", "helper", { name: "t", code: "expect(1).toBe(1);" });

    const dispatchOrder: string[] = [];
    const result = await designBuild(g, {
      dispatch: async (_g, mod, name) => {
        dispatchOrder.push(`${mod}#${name}`);
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "// ok",
          attempts: 1,
          testOutput: "",
        };
      },
      finalize: async () => ({
        ok: true,
        files: { "src/app.ts": "ok" },
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 2,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(dispatchOrder).toEqual(["src/util.ts#helper", "src/app.ts#main"]);
    expect(result.ok).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.finalize?.files["src/app.ts"]).toBe("ok");
  });

  it("returns phase=dispatch with failing functions when any dispatch fails", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "void" });
    g.addTest("src/a.ts", "foo", { name: "t", code: "expect(1).toBe(1);" });

    const result = await designBuild(g, {
      dispatch: async (_g, _m, name) =>
        name === "bar"
          ? {
              module: "src/a.ts",
              name: "bar",
              status: "failed",
              implementation: null,
              attempts: 3,
              testOutput: "nope",
              error: "tests never went green",
            }
          : {
              module: "src/a.ts",
              name: "foo",
              status: "tests-green",
              implementation: "// ok",
              attempts: 1,
              testOutput: "",
            },
      finalize: async () => ({
        ok: true,
        files: {},
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: null,
        typecheckOutput: "",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("dispatch");
    expect(result.failed.map((f) => f.name)).toContain("bar");
  });

  it("aborts at consistency when no function has tests", async () => {
    // Without at least one declared test anywhere, dispatch pre-test
    // would accept any body for any function (0/0 = ok) and produce
    // uncovered code. Fail loudly instead.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const result = await designBuild(g, {
      dispatch: async () => {
        throw new Error("should not dispatch");
      },
      finalize: async () => {
        throw new Error("should not finalize");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("consistency");
  });

  it("allowUntested: true lets callers skip the safety gate", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const result = await designBuild(g, {
      allowUntested: true,
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "tests-green",
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      }),
      finalize: async () => ({
        ok: true,
        files: {},
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(result.ok).toBe(true);
  });

  it("captures a thrown dispatch as a failed result (no crash)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "void" });
    g.addTest("src/a.ts", "foo", { name: "t", code: "expect(1).toBe(1);" });
    const result = await designBuild(g, {
      dispatch: async (_g, _m, name) => {
        if (name === "foo") throw new Error("network boom");
        return {
          module: "src/a.ts",
          name: "bar",
          status: "tests-green",
          implementation: "// ok",
          attempts: 1,
          testOutput: "",
        };
      },
      finalize: async () => ({
        ok: true,
        files: {},
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: null,
        typecheckOutput: "",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("dispatch");
    const fooResult = result.dispatched.find((d) => d.name === "foo");
    expect(fooResult?.status).toBe("failed");
    expect(fooResult?.error).toMatch(/network boom/);
    // bar still ran, ensuring the build kept going after the throw.
    expect(result.dispatched.find((d) => d.name === "bar")?.status).toBe(
      "tests-green",
    );
  });

  // (Legacy "decompose callback returning false marks the parent
  // failed" test deleted: the in-dispatch IMPLEMENT-vs-DECOMPOSE gate
  // went away with the legacy single-shot dispatcher. Decomposition
  // is now driven by the outer leaf-up + reflect flow; a decompose
  // callback returning false is handled there, not in dispatch.)

  it("recursive build: children dispatched before parent when decompose returns children", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "root", { params: [], returnType: "void" });
    g.addTest("src/a.ts", "root", {
      name: "t",
      code: "expect(1).toBe(1);",
    });
    const order: string[] = [];
    const result = await designBuild(g, {
      allowUntested: true,
      dispatch: async (gg, mod, name) => {
        order.push(name);
        // First time root is dispatched, simulate a "decompose" —
        // add two children to the graph and return the decomposed
        // marker so the build re-queues.
        if (name === "root" && gg.listChildren("root").length === 0) {
          gg.addFunctionChild("root", mod, "childA", {
            params: [],
            returnType: "void",
          });
          gg.addFunctionChild("root", mod, "childB", {
            params: [],
            returnType: "void",
          });
          gg.addTest(mod, "childA", { name: "ca", code: "expect(1).toBe(1);" });
          gg.addTest(mod, "childB", { name: "cb", code: "expect(1).toBe(1);" });
          return {
            module: mod,
            name,
            status: "failed",
            implementation: null,
            attempts: 0,
            testOutput: "",
            error: "decomposed — children need to be dispatched first",
          };
        }
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "// ok",
          attempts: 1,
          testOutput: "",
        };
      },
      finalize: async () => ({
        ok: true,
        files: {},
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 3,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(result.ok).toBe(true);
    // Children first, then root second time.
    expect(order).toEqual(["root", "childA", "childB", "root"]);
  });

  it("skips dispatch for functions already tests-green", async () => {
    // Having an implementation is NOT sufficient — a pre-existing body
    // may have been loaded from disk and still need its declared tests
    // run. The skip rule is "status === tests-green".
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addTest("src/a.ts", "foo", { name: "t", code: "expect(1).toBe(1);" });
    g.setImplementation("src/a.ts", "foo", "// already done");
    g.setTestStatus("src/a.ts", "foo", "tests-green", "verified");

    const dispatched: string[] = [];
    const result = await designBuild(g, {
      dispatch: async (_g, mod, name) => {
        dispatched.push(`${mod}#${name}`);
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "// ok",
          attempts: 1,
          testOutput: "",
        };
      },
      finalize: async () => ({
        ok: true,
        files: { "src/a.ts": "ok" },
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(dispatched).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
