import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  designPlan,
  extractJson,
  parseFunctionList,
  parseTestList,
  parseFunctionSpec,
} from "../../src/rlm/design-plan.js";

describe("extractJson", () => {
  it("pulls JSON from a ```json fence", () => {
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
  it("pulls JSON from a bare fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("falls back to parsing the whole response when no fence", () => {
    expect(extractJson('  [{"a":1}]  ')).toEqual([{ a: 1 }]);
  });
  it("returns null on unparseable input", () => {
    expect(extractJson("not json at all")).toBeNull();
  });
  it("returns null on an empty fenced block", () => {
    expect(extractJson("```json\n\n```")).toBeNull();
  });
});

describe("parseFunctionList", () => {
  it("accepts valid entries", () => {
    const fns = parseFunctionList([
      {
        module: "src/a.ts",
        name: "foo",
        signature: { params: [], returnType: "void" },
        description: "does stuff",
      },
    ]);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("foo");
  });
  it("rejects missing fields", () => {
    expect(() => parseFunctionList([{ name: "foo" }])).toThrow();
  });
  it("rejects non-array input", () => {
    expect(() => parseFunctionList({ foo: 1 })).toThrow();
  });
});

describe("parseTestList", () => {
  it("accepts valid entries", () => {
    const ts = parseTestList([{ name: "adds", code: "expect(1).toBe(1);" }]);
    expect(ts).toEqual([{ name: "adds", code: "expect(1).toBe(1);" }]);
  });
  it("rejects entries missing a field", () => {
    expect(() => parseTestList([{ name: "adds" }])).toThrow();
  });
});

describe("parseFunctionSpec", () => {
  it("accepts a description + tests object", () => {
    const spec = parseFunctionSpec({
      description: "Adds two numbers.",
      tests: [{ name: "t", code: "expect(1).toBe(1);" }],
    });
    expect(spec.description).toBe("Adds two numbers.");
    expect(spec.tests).toHaveLength(1);
  });
  it("rejects empty description", () => {
    expect(() =>
      parseFunctionSpec({ description: "  ", tests: [] }),
    ).toThrow();
  });
  it("rejects missing tests array", () => {
    expect(() => parseFunctionSpec({ description: "x" })).toThrow();
  });
});

describe("designPlan", () => {
  it("runs phase 1 (list functions) and phase 2 (per-fn tests), then build", async () => {
    const g = createDesignGraph();
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/math.ts",
              name: "add",
              signature: {
                params: [
                  { name: "a", type: "number" },
                  { name: "b", type: "number" },
                ],
                returnType: "number",
              },
              description: "adds two numbers",
            },
          ]) +
          "\n```"
        );
      }
      if (prompt.startsWith("Write PROJECT-LEVEL INTEGRATION TESTS")) {
        // Phase 2b — project integration tests (array).
        return (
          '```json\n[{"name":"e2e","code":"expect(add(ctx,1,1)).toBe(2);"}]\n```'
        );
      }
      // Phase 2 — description + tests for one function.
      return (
        '```json\n{"description":"Adds two numbers.","tests":[{"name":"adds","code":"expect(add(2,3)).toBe(5);"}]}\n```'
      );
    };
    const report = await designPlan(g, "build a math module", {
      chat,
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "tests-green",
        implementation: "return a + b;",
        attempts: 1,
        testOutput: "",
      }),
      finalize: async () => ({
        ok: true,
        files: { "src/math.ts": "ok" },
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 1,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.phase).toBe("done");
    // Function is in the graph with its test + enriched description.
    const fn = g.getFunction("src/math.ts", "add");
    expect(fn).toBeDefined();
    expect(fn!.tests).toHaveLength(1);
    expect(fn!.description).toBe("Adds two numbers.");
    // Three LLM calls: phase 1, phase 2 (per-fn), phase 2b (project integration).
    expect(chatCalls).toHaveLength(3);
    expect(g.listProjectTests()).toHaveLength(1);
  });

  it("retries phase 1 once on bad JSON before giving up", async () => {
    const g = createDesignGraph();
    let call = 0;
    const chat = async () => {
      call++;
      if (call === 1) return "not a JSON array at all";
      return (
        "```json\n" +
        JSON.stringify([
          {
            module: "src/a.ts",
            name: "foo",
            signature: { params: [], returnType: "void" },
            description: "x",
          },
        ]) +
        "\n```"
      );
    };
    await designPlan(g, "do things", {
      chat,
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
    expect(call).toBeGreaterThanOrEqual(2);
    expect(g.getFunction("src/a.ts", "foo")).toBeDefined();
  });

  it("fails with phase=plan when every function's phase 2 returns bad JSON", async () => {
    // Phase 1 succeeds with one function; phase 2 returns garbage for
    // it; the safety net must catch the zero-tests state before dispatch
    // instead of letting 0/0 auto-pass a garbage body through.
    const g = createDesignGraph();
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "x",
            },
          ]) +
          "\n```"
        );
      }
      return "not json"; // phase 2 keeps failing across retries
    };
    const report = await designPlan(g, "task", {
      chat,
      dispatch: async () => {
        throw new Error("should not dispatch — plan should have aborted");
      },
      finalize: async () => {
        throw new Error("should not finalize");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.phase).toBe("plan");
  });

  it("resumes — skips phase 1 only when plan-origin functions exist", async () => {
    const g = createDesignGraph();
    // Pretend a prior design_plan run declared this function.
    g.addFunction(
      "src/a.ts",
      "foo",
      { params: [], returnType: "void" },
      "pre-declared",
      "plan",
    );
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (
        prompt.startsWith("Write PROJECT-LEVEL INTEGRATION TESTS") ||
        prompt.startsWith("Write INTEGRATION TESTS for the assembly")
      ) {
        return '```json\n[{"name":"i","code":"expect(1).toBe(1);"}]\n```';
      }
      return '```json\n{"description":"x","tests":[{"name":"t","code":"expect(1).toBe(1);"}]}\n```';
    };
    await designPlan(g, "task", {
      chat,
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
        testsPassed: 1,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // 2 chat calls: phase 2 for foo + phase 2b project integration.
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]).toContain("foo");
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(1);
  });

  it("does NOT skip phase 1 when only load/manual-origin functions exist", async () => {
    // design_load populated a function; design_plan should still ask
    // for NEW planned functions — otherwise the user's task is ignored.
    const g = createDesignGraph();
    g.addFunction(
      "src/a.ts",
      "loaded",
      { params: [], returnType: "void" },
      "from disk",
      "load",
    );
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (prompt.includes("list the top-level functions needed")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "newFn",
              signature: { params: [], returnType: "void" },
              description: "planned",
            },
          ]) +
          "\n```"
        );
      }
      return '```json\n{"description":"x","tests":[{"name":"t","code":"expect(1).toBe(1);"}]}\n```';
    };
    await designPlan(g, "task", {
      chat,
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
        testsPassed: 2,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // Phase 1 happened — the first call mentions the planning prompt.
    expect(chatCalls[0]).toContain("list the top-level functions needed");
    // The newly-planned function landed in the graph.
    expect(g.getFunction("src/a.ts", "newFn")).toBeDefined();
    expect(g.getFunction("src/a.ts", "newFn")!.origin).toBe("plan");
    expect(g.getFunction("src/a.ts", "loaded")!.origin).toBe("load");
  });

  it("resumes — skips phase 2 for functions that already have tests", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/a.ts",
      "foo",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.addTest("src/a.ts", "foo", {
      name: "existing",
      code: "expect(1).toBe(1);",
    });
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (
        prompt.startsWith("Write PROJECT-LEVEL INTEGRATION TESTS") ||
        prompt.startsWith("Write INTEGRATION TESTS for the assembly")
      ) {
        return '```json\n[{"name":"i","code":"expect(1).toBe(1);"}]\n```';
      }
      return '```json\n{"description":"x","tests":[]}\n```';
    };
    await designPlan(g, "task", {
      chat,
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
        testsPassed: 1,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // Phase 1 + per-fn phase 2 both skipped; phase 2b (project
    // integration) still runs — 1 chat call.
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]).toContain("PROJECT-LEVEL INTEGRATION TESTS");
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(1);
  });

  it("resumes — interleaved: some fns pre-tested, some need phase 2", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "a", { params: [], returnType: "void" }, "", "plan");
    g.addTest("src/a.ts", "a", { name: "t", code: "expect(1).toBe(1);" });
    g.addFunction("src/a.ts", "b", { params: [], returnType: "void" }, "", "plan");
    // b has no tests → phase 2 should run exactly once, for b.
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (
        prompt.startsWith("Write PROJECT-LEVEL INTEGRATION TESTS") ||
        prompt.startsWith("Write INTEGRATION TESTS for the assembly")
      ) {
        return '```json\n[{"name":"i","code":"expect(1).toBe(1);"}]\n```';
      }
      return '```json\n{"description":"x","tests":[{"name":"bt","code":"expect(1).toBe(1);"}]}\n```';
    };
    await designPlan(g, "task", {
      chat,
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
        testsPassed: 2,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // Phase 2 for b + phase 2b project integration = 2 calls.
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]).toMatch(/Function:\s*b\b/);
    expect(g.getFunction("src/a.ts", "a")!.tests).toHaveLength(1);
    expect(g.getFunction("src/a.ts", "b")!.tests).toHaveLength(1);
  });

  it("returns phase=plan when a function ended phase 2 with no tests and no body", async () => {
    const g = createDesignGraph();
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "x",
            },
            {
              module: "src/a.ts",
              name: "bar",
              signature: { params: [], returnType: "void" },
              description: "y",
            },
          ]) +
          "\n```"
        );
      }
      if (turn === 2) {
        // foo gets tests.
        return '```json\n{"description":"x","tests":[{"name":"t","code":"expect(1).toBe(1);"}]}\n```';
      }
      // bar's phase 2 fails across retries.
      return "no json";
    };
    const result = await designPlan(g, "task", {
      chat,
      dispatch: async () => {
        throw new Error("dispatch should not run when plan has holes");
      },
      finalize: async () => {
        throw new Error("finalize should not run");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("plan");
  });

  it("recursive plan — `parent` option adds children under the named function", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/r.ts",
      "handleSign",
      {
        params: [
          { name: "req", type: "any" },
          { name: "res", type: "any" },
        ],
        returnType: "Promise<void>",
        isAsync: true,
      },
      "handle POST /sign",
      "plan",
    );

    const chat = async (prompt: string) => {
      // Phase 1 (parent variant): starts with "You are decomposing".
      if (prompt.startsWith("You are decomposing")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/r.ts",
              name: "parseBody",
              signature: {
                params: [{ name: "req", type: "any" }],
                returnType: "Promise<Record<string,string>>",
                isAsync: true,
              },
              description: "parses form body",
            },
            {
              module: "src/r.ts",
              name: "writeEntry",
              signature: {
                params: [{ name: "entry", type: "any" }],
                returnType: "Promise<void>",
                isAsync: true,
              },
              description: "writes a guestbook entry",
            },
          ]) +
          "\n```"
        );
      }
      // Phase 2b (branch integration).
      if (prompt.startsWith("Write INTEGRATION TESTS for the assembly")) {
        return '```json\n[{"name":"assembly","code":"expect(1).toBe(1);"}]\n```';
      }
      // Phase 2 per-child (FunctionSpec shape).
      return '```json\n{"description":"x","tests":[{"name":"t","code":"expect(1).toBe(1);"}]}\n```';
    };
    const result = await designPlan(g, "add guestbook entry", {
      chat,
      parent: "handleSign",
      dispatch: async () => {
        throw new Error("should not dispatch in subtree plan");
      },
      finalize: async () => {
        throw new Error("should not finalize in subtree plan");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.phase).toBe("plan");
    const parent = g.getFunction("src/r.ts", "handleSign")!;
    expect(parent.children.sort()).toEqual(["parseBody", "writeEntry"]);
    // Parent now has integration tests from phase 2b.
    expect(parent.integrationTests).toHaveLength(1);
    const p = g.getFunction("src/r.ts", "parseBody")!;
    expect(p.parent).toBe("handleSign");
    expect(p.tests).toHaveLength(1);
    expect(p.origin).toBe("plan");
  });

  it("fails with phase=plan when phase 1 never returns valid JSON", async () => {
    const g = createDesignGraph();
    const chat = async () => "still not JSON";
    const report = await designPlan(g, "x", {
      chat,
      dispatch: async () => {
        throw new Error("should not dispatch");
      },
      finalize: async () => {
        throw new Error("should not finalize");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.phase).toBe("plan");
  });
});
