import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  designPlan,
  extractJson,
  parseFunctionList,
  parseTestList,
  parseFunctionSpec,
  parsePackageJson,
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

describe("parseFunctionList — module path sanity", () => {
  it("rejects module paths that escape the project (..)", () => {
    expect(() =>
      parseFunctionList([
        {
          module: "../escape.ts",
          name: "foo",
          signature: { params: [], returnType: "void" },
          description: "",
        },
      ]),
    ).toThrow(/module path/i);
  });

  it("rejects empty module paths", () => {
    expect(() =>
      parseFunctionList([
        {
          module: "",
          name: "foo",
          signature: { params: [], returnType: "void" },
          description: "",
        },
      ]),
    ).toThrow(/module/i);
  });

  it("rejects absolute module paths", () => {
    expect(() =>
      parseFunctionList([
        {
          module: "/etc/passwd",
          name: "foo",
          signature: { params: [], returnType: "void" },
          description: "",
        },
      ]),
    ).toThrow(/module path/i);
  });

  it("accepts well-formed relative paths", () => {
    const fns = parseFunctionList([
      {
        module: "src/server.js",
        name: "foo",
        signature: { params: [], returnType: "void" },
        description: "",
      },
    ]);
    expect(fns[0].module).toBe("src/server.js");
  });
});

describe("parsePackageJson", () => {
  it("accepts valid JSON with vitest in devDependencies", () => {
    const raw = JSON.stringify({
      name: "proj",
      type: "module",
      devDependencies: { vitest: "^2.0.0" },
    });
    const cfg = parsePackageJson(raw);
    expect(cfg.testFramework).toBe("vitest");
    expect(cfg.packageJson).toBe(raw);
  });

  it("accepts valid JSON with jest in devDependencies", () => {
    const raw = JSON.stringify({
      name: "proj",
      type: "module",
      devDependencies: { jest: "^29.0.0", "@jest/globals": "^29.0.0" },
    });
    const cfg = parsePackageJson(raw);
    expect(cfg.testFramework).toBe("jest");
  });

  it("rejects a package.json with BOTH vitest and jest (ambiguous)", () => {
    const raw = JSON.stringify({
      name: "proj",
      type: "module",
      devDependencies: { vitest: "^2.0.0", jest: "^29.0.0" },
    });
    expect(() => parsePackageJson(raw)).toThrow(/both/i);
  });

  it("rejects a package.json with NEITHER vitest nor jest", () => {
    const raw = JSON.stringify({
      name: "proj",
      type: "module",
      devDependencies: { typescript: "^5.0.0" },
    });
    expect(() => parsePackageJson(raw)).toThrow(/vitest|jest/i);
  });

  it("rejects missing devDependencies", () => {
    const raw = JSON.stringify({ name: "proj", type: "module" });
    expect(() => parsePackageJson(raw)).toThrow(/devDependencies/i);
  });

  it('requires "type": "module" (ESM is mandatory for proc-ts emitter)', () => {
    const raw = JSON.stringify({
      name: "proj",
      devDependencies: { vitest: "^2.0.0" },
    });
    expect(() => parsePackageJson(raw)).toThrow(/type.*module/i);
  });

  it("rejects non-JSON input", () => {
    expect(() => parsePackageJson("not json")).toThrow();
  });

  it("rejects non-object JSON (array / string / number)", () => {
    expect(() => parsePackageJson("[]")).toThrow();
    expect(() => parsePackageJson('"hi"')).toThrow();
  });
});

describe("parseFunctionSpec (signature-driven)", () => {
  // New shape: LLM authors ONLY descriptions. name/type come from the
  // stored signature, so the LLM can't drift from phase 1's commitment.
  const twoArgSig = {
    params: [
      { name: "a", type: "number" },
      { name: "b", type: "number" },
    ],
    returnType: "number",
  };
  const validRawSpec = {
    purpose: "Add two numbers.",
    inputs: ["lhs", "rhs"], // descriptions only, aligned to signature.params
    output: "sum of the two numbers", // description only
    sideEffects: [],
    dependencies: [],
    edgeCases: ["a + 0 === a"],
    examples: [{ input: "a=1,b=2", output: "3" }],
  };

  it("synthesizes inputs[].name/type from the signature and keeps descriptions", () => {
    const spec = parseFunctionSpec(validRawSpec, twoArgSig);
    expect(spec.inputs).toEqual([
      { name: "a", type: "number", description: "lhs" },
      { name: "b", type: "number", description: "rhs" },
    ]);
  });

  it("synthesizes output.type from signature.returnType", () => {
    const spec = parseFunctionSpec(validRawSpec, twoArgSig);
    expect(spec.output).toEqual({
      type: "number",
      description: "sum of the two numbers",
    });
  });

  it("rejects inputs array with wrong length vs signature.params", () => {
    expect(() =>
      parseFunctionSpec({ ...validRawSpec, inputs: ["only-one"] }, twoArgSig),
    ).toThrow(/inputs/);
  });

  it("accepts empty inputs when signature has no params", () => {
    const noArgSig = { params: [], returnType: "void" };
    const spec = parseFunctionSpec(
      {
        purpose: "does nothing",
        inputs: [],
        output: "nothing",
        sideEffects: [],
        dependencies: [],
        edgeCases: [],
        examples: [],
      },
      noArgSig,
    );
    expect(spec.inputs).toEqual([]);
  });

  it("rejects missing purpose", () => {
    const { purpose: _p, ...rest } = validRawSpec;
    expect(() => parseFunctionSpec(rest, twoArgSig)).toThrow(/purpose/);
  });

  it("rejects missing output", () => {
    const { output: _o, ...rest } = validRawSpec;
    expect(() => parseFunctionSpec(rest, twoArgSig)).toThrow(/output/);
  });

  it("JSON-stringifies non-string example inputs/outputs instead of [object Object]", () => {
    const raw = {
      ...validRawSpec,
      examples: [
        { input: { a: 1, b: 2 }, output: { sum: 3 } },
        { input: [1, 2, 3], output: 6 },
      ],
    };
    const spec = parseFunctionSpec(raw, twoArgSig);
    expect(spec.examples[0].input).toBe('{"a":1,"b":2}');
    expect(spec.examples[0].output).toBe('{"sum":3}');
    expect(spec.examples[1].input).toBe("[1,2,3]");
    // Numbers stay readable too.
    expect(spec.examples[1].output).toBe("6");
  });

  it("rejects empty output string", () => {
    expect(() =>
      parseFunctionSpec({ ...validRawSpec, output: "" }, twoArgSig),
    ).toThrow(/output/);
    expect(() =>
      parseFunctionSpec({ ...validRawSpec, output: "   " }, twoArgSig),
    ).toThrow(/output/);
  });
});

// New spec shape (signature-driven): LLM supplies only descriptions.
// Works for any signature because phase-1 fixtures use `params: []`.
const specJson = JSON.stringify({
  purpose: "x",
  inputs: [],
  output: "nothing",
  sideEffects: [],
  dependencies: [],
  edgeCases: [],
  examples: [],
});
const specResp = `\`\`\`json\n${specJson}\n\`\`\``;

/**
 * Seed a project config so existing root-level tests skip phase 0.
 * Phase 0 is exercised directly by the dedicated phase-0 tests; other
 * designPlan tests focus on phase 1 / 2 / build and don't need to
 * re-walk the package.json flow.
 */
function seedVitestProjectConfig(g: ReturnType<typeof createDesignGraph>): void {
  g.setProjectConfig({
    packageJson:
      '{"name":"test","version":"0.1.0","type":"module","scripts":{"test":"vitest run"},"dependencies":{},"devDependencies":{"vitest":"^2.0.0"}}',
    testFramework: "vitest",
  });
}

describe("designPlan", () => {
  it("phase 0 asks the Architect for a package.json and stores the config", async () => {
    const g = createDesignGraph();
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("fill in this package.json")) {
        return (
          "```json\n" +
          JSON.stringify({
            name: "guestbook",
            version: "0.1.0",
            type: "module",
            scripts: { test: "vitest run" },
            dependencies: {},
            devDependencies: { vitest: "^2.0.0" },
          }) +
          "\n```"
        );
      }
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "does foo",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    const cfg = g.getProjectConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.testFramework).toBe("vitest");
    expect(cfg!.packageJson).toContain('"name":"guestbook"');
  });

  it("resume — phase 0 skipped when projectConfig already set", async () => {
    const g = createDesignGraph();
    g.setProjectConfig({
      packageJson:
        '{"name":"x","devDependencies":{"jest":"^29.0.0"}}',
      testFramework: "jest",
    });
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "does foo",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // The phase-0 prompt must not have been emitted.
    expect(prompts.some((p) => p.includes("fill in this package.json"))).toBe(
      false,
    );
    // Original config preserved.
    expect(g.getProjectConfig()!.testFramework).toBe("jest");
  });

  it("phase 0 failure fails the plan with phase='plan' and includes failedSpecs=[]", async () => {
    const g = createDesignGraph();
    const chat = async (prompt: string) => {
      if (prompt.includes("fill in this package.json")) {
        return "total garbage not JSON at all";
      }
      throw new Error("should not reach phase 1");
    };
    const report = await designPlan(g, "task", {
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
    // Consistency with phase-1 and phase-2 failure paths — report
    // shape should include the failedSpecs field.
    expect(report.failedSpecs).toEqual([]);
  });

  it("phase 1 lists functions; phase 2 attaches specs; build runs", async () => {
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "does stuff",
            },
          ]) +
          "\n```"
        );
      }
      return specResp; // phase 2 spec
    };
    const report = await designPlan(g, "task", {
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
        files: { "foo.ts": "ok" },
        unimplemented: [],
        consistency: { ok: true, violations: [], advisories: [] },
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.phase).toBe("done");
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.spec).not.toBeNull();
    // Two chat calls: phase 1 + phase 2 per fn. No phase 2b anymore.
    expect(chatCalls).toHaveLength(2);
  });

  it("resume — skips phase 1 when plan-origin fns exist", async () => {
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    g.addFunction(
      "src/a.ts",
      "foo",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // Phase 1 skipped; only phase 2 (spec for foo) hits the LLM.
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]).toContain("Fill in the SPEC");
    expect(g.getFunction("src/a.ts", "foo")!.spec).not.toBeNull();
  });

  it("resume — skips phase 2 when spec already attached", async () => {
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    g.addFunction(
      "src/a.ts",
      "foo",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.setSpec("src/a.ts", "foo", {
      purpose: "pre-existing",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    const chatCalls: string[] = [];
    const chat = async (prompt: string) => {
      chatCalls.push(prompt);
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // Both phases skipped — zero LLM calls.
    expect(chatCalls).toHaveLength(0);
    expect(g.getFunction("src/a.ts", "foo")!.spec!.purpose).toBe("pre-existing");
  });

  it("recursive — `parent` option adds children via addFunctionChild", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/r.ts",
      "handleSign",
      { params: [], returnType: "void" },
      "handle sign",
      "plan",
    );
    const chat = async (prompt: string) => {
      if (prompt.startsWith("You are decomposing")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/r.ts",
              name: "parseBody",
              signature: { params: [], returnType: "void" },
              description: "parses",
            },
            {
              module: "src/r.ts",
              name: "writeEntry",
              signature: { params: [], returnType: "void" },
              description: "writes",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
    };
    const result = await designPlan(g, "task", {
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
    expect(g.getFunction("src/r.ts", "parseBody")!.spec).not.toBeNull();
    expect(g.getFunction("src/r.ts", "parseBody")!.parent).toBe("handleSign");
  });

  it("drops unknown dependency names from the LLM spec before storing", async () => {
    // LLM claims dependency on `nonexistent` — harness must filter it
    // out at store time so the Implementer prompt doesn't advertise a
    // sibling that isn't wired.
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "does foo",
            },
            {
              module: "src/a.ts",
              name: "bar",
              signature: { params: [], returnType: "void" },
              description: "does bar",
            },
          ]) +
          "\n```"
        );
      }
      // Phase 2: both functions claim a dep on a nonexistent sibling
      // and one on a real one.
      return (
        "```json\n" +
        JSON.stringify({
          purpose: "x",
          inputs: [],
          output: "nothing",
          sideEffects: [],
          dependencies: ["bar", "nonexistent"],
          edgeCases: [],
          examples: [],
        }) +
        "\n```"
      );
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    // "nonexistent" must be filtered; "bar" must be preserved.
    const foo = g.getFunction("src/a.ts", "foo")!;
    expect(foo.spec!.dependencies).toEqual(["bar"]);
  });

  it("caps decompose children at a fixed maximum", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/p.ts",
      "parent",
      { params: [], returnType: "void" },
      "parent",
      "plan",
    );
    const chat = async (prompt: string) => {
      if (prompt.startsWith("You are decomposing")) {
        // 10 children — over the cap
        return (
          "```json\n" +
          JSON.stringify(
            Array.from({ length: 10 }, (_, i) => ({
              name: `child${i}`,
              signature: { params: [], returnType: "void" },
              description: `child ${i}`,
            })),
          ) +
          "\n```"
        );
      }
      return specResp;
    };
    const result = await designPlan(g, "task", {
      chat,
      parent: "parent",
      dispatch: async () => {
        throw new Error("not used");
      },
      finalize: async () => {
        throw new Error("not used");
      },
    });
    // A hard cap trips the shape-retry loop; with maxShapeRetries=1 and
    // both attempts returning 10, the plan fails with phase=plan.
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("plan");
  });

  it("phase-2 prompt tells the LLM NOT to bloat dependencies", async () => {
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    const phase2Prompt = prompts.find(
      (p) => p.includes("Fill in the SPEC") && p.includes("Function: foo"),
    );
    expect(phase2Prompt).toBeDefined();
    // Must tell the LLM to list only deps it will DEFINITELY call.
    expect(phase2Prompt).toMatch(/definitely|only.*actually|never-called|do not list/i);
  });

  it("phase-2 prompt emphasizes the exact inputs length + param names", async () => {
    // Without this emphasis, models systematically emit inputs with
    // length +1 (one extra entry), forcing a retry per spec.
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: {
                params: [
                  { name: "req", type: "IncomingMessage" },
                  { name: "entries", type: "Entry[]" },
                ],
                returnType: "string",
              },
              description: "handles things",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    const phase2Prompt = prompts.find(
      (p) => p.includes("Fill in the SPEC") && p.includes("Function: foo"),
    );
    expect(phase2Prompt).toBeDefined();
    // The literal param count and names must appear prominently.
    expect(phase2Prompt).toMatch(/EXACTLY 2 description strings?/);
    expect(phase2Prompt).toMatch(/\breq\b.*\bentries\b/);
  });

  it("decompose phase-2 sibling list includes top-level siblings and the parent", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/server.js",
      "loadEntries",
      { params: [], returnType: "void" },
      "loads all entries from disk",
      "plan",
    );
    g.addFunction(
      "src/server.js",
      "handleSign",
      { params: [], returnType: "void" },
      "handle signing",
      "plan",
    );
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith("You are decomposing")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              name: "parseBody",
              signature: { params: [], returnType: "void" },
              description: "parses",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
    };
    await designPlan(g, "task", {
      chat,
      parent: "handleSign",
      dispatch: async () => {
        throw new Error("not used");
      },
      finalize: async () => {
        throw new Error("not used");
      },
    });
    // Find the phase-2 prompt for the child. It's the one asking to
    // fill the SPEC for the new child `parseBody`.
    const phase2Prompt = prompts.find(
      (p) => p.includes("Fill in the SPEC") && p.includes("Function: parseBody"),
    );
    expect(phase2Prompt).toBeDefined();
    // Both the top-level sibling AND the parent must appear in the
    // sibling section so the Implementer can list them as dependencies.
    expect(phase2Prompt).toContain("loadEntries");
    expect(phase2Prompt).toContain("handleSign");
  });

  it("phase-2 prompt renders the graph's normalized signature (isAsync + Promise)", async () => {
    // Phase 1 declares `load` with isAsync:false but returnType Promise.
    // The graph normalizes at ingest. The phase-2 prompt must reflect
    // the normalized signature, not the LLM's original claim.
    // (Seed the project config so phase 0 is skipped.)
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "load",
              signature: {
                params: [],
                returnType: "Promise<string>",
                isAsync: false, // LLM slip
              },
              description: "loads",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
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
        testsPassed: 0,
        testsFailed: 0,
        testOutput: "",
        typecheckOk: true,
        typecheckOutput: "",
      }),
    });
    const phase2Prompt = prompts.find(
      (p) => p.includes("Fill in the SPEC") && p.includes("Function: load"),
    );
    expect(phase2Prompt).toBeDefined();
    // Normalization forces `async` keyword in the displayed signature.
    expect(phase2Prompt).toContain("async function load(ctx: Ctx): Promise<string>");
  });

  it("surfaces cross-module name collision as a plan failure (not a silent skip)", async () => {
    // A colliding-name error from addFunction must NOT be silently
    // swallowed — it indicates the LLM picked a bad name.
    const g = createDesignGraph();
    g.addFunction(
      "src/existing.ts",
      "foo",
      { params: [], returnType: "void" },
      "already here",
      "manual",
    );
    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/new.ts",
              name: "foo", // collides with existing top-level `foo`
              signature: { params: [], returnType: "void" },
              description: "dup",
            },
          ]) +
          "\n```"
        );
      }
      return specResp; // phase 2 would succeed if we got that far
    };
    const report = await designPlan(g, "task", {
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

  it("recursive — child modules inherit the parent's module (LLM's claim is ignored)", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/server.js",
      "handleSign",
      { params: [], returnType: "void" },
      "handle sign",
      "plan",
    );
    const chat = async (prompt: string) => {
      if (prompt.startsWith("You are decomposing")) {
        // LLM returns children with a WRONG module path — the harness
        // must discard the LLM's module and use the parent's.
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "server.js",
              name: "parseBody",
              signature: { params: [], returnType: "void" },
              description: "parses",
            },
            {
              module: "elsewhere/wrong.ts",
              name: "writeEntry",
              signature: { params: [], returnType: "void" },
              description: "writes",
            },
          ]) +
          "\n```"
        );
      }
      return specResp;
    };
    await designPlan(g, "task", {
      chat,
      parent: "handleSign",
      dispatch: async () => {
        throw new Error("should not dispatch");
      },
      finalize: async () => {
        throw new Error("should not finalize");
      },
    });
    // Both children must live in the PARENT's module, regardless of
    // what the LLM claimed.
    expect(g.getFunction("src/server.js", "parseBody")).toBeDefined();
    expect(g.getFunction("src/server.js", "writeEntry")).toBeDefined();
    expect(g.getFunction("server.js", "parseBody")).toBeUndefined();
    expect(g.getFunction("elsewhere/wrong.ts", "writeEntry")).toBeUndefined();
  });

  it("reports failedSpecs when phase 2 fails for a subset of functions", async () => {
    const g = createDesignGraph();
    seedVitestProjectConfig(g);
    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) {
        return (
          "```json\n" +
          JSON.stringify([
            {
              module: "src/a.ts",
              name: "foo",
              signature: { params: [], returnType: "void" },
              description: "does foo",
            },
            {
              module: "src/a.ts",
              name: "bar",
              signature: { params: [], returnType: "void" },
              description: "does bar",
            },
          ]) +
          "\n```"
        );
      }
      // Fail phase-2 for `bar`, succeed for `foo`.
      if (prompt.includes("Function: bar")) return "garbage not JSON";
      return specResp;
    };
    const report = await designPlan(g, "task", {
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
    // `bar` should appear in failedSpecs, build still proceeds.
    expect(report.failedSpecs).toEqual(["src/a.ts#bar"]);
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
