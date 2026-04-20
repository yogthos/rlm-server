import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  createDesignDispatchBridge,
  extractBody,
  extractUnitTests,
  extractIntegrationTests,
  parseReviewVerdict,
} from "../../src/rlm/design-dispatch.js";

describe("extractBody", () => {
  it("pulls a body from a ```js fenced block", () => {
    expect(extractBody("Here:\n```js\nreturn 1;\n```")).toBe("return 1;");
  });
  it("pulls a body from a ```ts fenced block", () => {
    expect(extractBody("```ts\nreturn a + b;\n```")).toBe("return a + b;");
  });
  it("pulls from a bare ``` fenced block", () => {
    expect(extractBody("```\nreturn 42;\n```")).toBe("return 42;");
  });
  it("returns null when no fence is present", () => {
    expect(extractBody("no code here")).toBeNull();
  });
  it("returns the first block when multiple are present", () => {
    expect(extractBody("```js\nreturn 1;\n```\n```js\nreturn 2;\n```")).toBe(
      "return 1;",
    );
  });
  it("tolerates `language:filename` suffix after the fence", () => {
    expect(extractBody("```typescript:src/foo.ts\nreturn 1;\n```")).toBe(
      "return 1;",
    );
  });
  it("normalizes CRLF line endings to LF", () => {
    const body = extractBody("```js\r\nreturn 1;\r\nreturn 2;\r\n```");
    expect(body).toBe("return 1;\nreturn 2;");
    expect(body).not.toContain("\r");
  });
});

describe("extractTestPatch", () => {
  it("pulls a JSON array from a ```tests fence", async () => {
    const { extractTestPatch } = await import(
      "../../src/rlm/design-dispatch.js"
    );
    const r = extractTestPatch(
      '```ts\nreturn 1;\n```\n```tests\n[{"name":"t","code":"expect(1).toBe(1);"}]\n```',
    );
    expect(r).toEqual([{ name: "t", code: "expect(1).toBe(1);" }]);
  });
  it("returns null when no ```tests fence", async () => {
    const { extractTestPatch } = await import(
      "../../src/rlm/design-dispatch.js"
    );
    expect(extractTestPatch("```ts\nreturn 1;\n```")).toBeNull();
  });
  it("returns null for malformed JSON in a ```tests fence", async () => {
    const { extractTestPatch } = await import(
      "../../src/rlm/design-dispatch.js"
    );
    expect(extractTestPatch("```tests\nnot json\n```")).toBeNull();
  });
  it("rejects entries missing name or code", async () => {
    const { extractTestPatch } = await import(
      "../../src/rlm/design-dispatch.js"
    );
    expect(
      extractTestPatch('```tests\n[{"name":"a"}]\n```'),
    ).toBeNull();
  });
});

describe("extractUnitTests / extractIntegrationTests", () => {
  it("extracts unit-tests JSON array", () => {
    const r = extractUnitTests(
      '```unit-tests\n[{"name":"a","code":"expect(1).toBe(1);"}]\n```',
    );
    expect(r).toEqual([{ name: "a", code: "expect(1).toBe(1);" }]);
  });
  it("extracts integration-tests JSON array", () => {
    const r = extractIntegrationTests(
      '```integration-tests\n[{"name":"b","code":"expect(2).toBe(2);"}]\n```',
    );
    expect(r).toEqual([{ name: "b", code: "expect(2).toBe(2);" }]);
  });
  it("returns empty array for an empty integration-tests fence", () => {
    expect(extractIntegrationTests("```integration-tests\n[]\n```")).toEqual([]);
  });
  it("returns null when the fence is absent", () => {
    expect(extractUnitTests("```ts\nreturn 1;\n```")).toBeNull();
  });
  it("extractBody skips unit-tests and integration-tests fences", () => {
    const body = extractBody(
      '```unit-tests\n[]\n```\n```integration-tests\n[]\n```\n```ts\nreturn 99;\n```',
    );
    expect(body).toBe("return 99;");
  });
});

describe("branch decomposition/recomposition enforcement", () => {
  it("branch body that doesn't call a declared child is rejected with actionable feedback", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "childA",
      { params: [], returnType: "void" },
      "first child",
    );
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "childB",
      { params: [], returnType: "void" },
      "second child",
    );
    let attempt = 0;
    const prompts: string[] = [];
    const tests = '```unit-tests\n[{"name":"u","code":"expect(1).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempt++;
        if (attempt === 1) {
          return `\`\`\`ts\nctx.fns.childA(ctx);\n\`\`\`\n${tests}`;
        }
        return `\`\`\`ts\nctx.fns.childA(ctx);\nctx.fns.childB(ctx);\n\`\`\`\n${tests}`;
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "parent");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
    expect(prompts[1]).toMatch(/childB/);
    expect(prompts[1]).toMatch(/call.*ctx\.fns|must.*call|missing/i);
  });

  it("branch body that calls ALL declared children is accepted", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "childA",
      { params: [], returnType: "void" },
    );
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "childB",
      { params: [], returnType: "void" },
    );
    const tests = '```unit-tests\n[{"name":"u","code":"expect(1).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(
      g,
      async () =>
        `\`\`\`ts\nctx.fns.childA(ctx);\nctx.fns.childB(ctx);\n\`\`\`\n${tests}`,
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "parent");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(1);
  });

  it("leaf (children=[]) has no recomposition requirement — any body accepted", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "leaf", { params: [], returnType: "number" });
    const tests = '```unit-tests\n[{"name":"u","code":"expect(1).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(
      g,
      async () => `\`\`\`ts\nreturn 42;\n\`\`\`\n${tests}`,
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "leaf");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(1);
  });
});

describe("body-analyzer integration", () => {
  it("rejects a body containing a top-level import statement", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const response =
      "```ts\nimport fs from 'node:fs';\nreturn 1;\n```\n" +
      '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```';
    const prompts: string[] = [];
    let attempts = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempts++;
        // On retry, return a clean body without imports.
        if (attempts === 1) return response;
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
    // Retry prompt must mention the import violation.
    expect(prompts[1]).toMatch(/import/i);
  });

  it("rejects a body calling an undeclared ctx.fns.<sibling>", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    // Note: no sibling `bogus` exists in the graph.
    let attempts = 0;
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempts++;
        if (attempts === 1) {
          return (
            "```ts\nreturn ctx.fns.bogus(ctx);\n```\n" +
            '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
          );
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
    expect(prompts[1]).toMatch(/bogus/);
  });

  it("analyzer rejection surfaces under 'Static-analysis' section with line numbers, not under Test output", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    let attempts = 0;
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempts++;
        if (attempts === 1) {
          return (
            "```ts\nimport fs from 'node:fs';\nreturn 1;\n```\n" +
            '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
          );
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const retryPrompt = prompts[1];
    expect(retryPrompt).toMatch(/Static-analysis violation/);
    expect(retryPrompt).toMatch(/line 1: import from "node:fs"/);
    // Make sure the violation isn't leaking into the Test output section.
    const testOutputIdx = retryPrompt.indexOf("Test output:");
    if (testOutputIdx >= 0) {
      const testOutputSection = retryPrompt.slice(
        testOutputIdx,
        testOutputIdx + 400,
      );
      expect(testOutputSection).not.toMatch(/node:fs/);
    }
  });

  it("reconciles spec.dependencies from observed ctx.fns calls after green dispatch", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "realA", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "realB", { params: [], returnType: "number" });
    // LLM's phase-2 guess was wrong: listed a phantom dep, missed a real one.
    g.setSpec("src/a.ts", "foo", {
      purpose: "compose",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: ["phantom"],
      edgeCases: [],
      examples: [],
    });
    const response =
      "```ts\nconst x = ctx.fns.realA(ctx);\nreturn ctx.fns.realB(ctx, x);\n```\n" +
      '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(g, async () => response, {
      runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
      maxReviewCycles: 0,
    });
    await b.dispatch("src/a.ts", "foo");
    const fn = g.getFunction("src/a.ts", "foo")!;
    // Derived from the actual body — `phantom` dropped, `realA`+`realB`
    // captured, alphabetical order for stability.
    expect(fn.spec!.dependencies).toEqual(["realA", "realB"]);
  });

  it("leaves spec.dependencies alone when dispatch fails (body-analyzer reject)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "compose",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: ["initial-guess"],
      edgeCases: [],
      examples: [],
    });
    const b = createDesignDispatchBridge(
      g,
      async () =>
        // Every attempt calls a nonexistent sibling — analyzer rejects.
        "```ts\nreturn ctx.fns.nonexistent(ctx);\n```\n" +
        '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```',
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
        maxAttempts: 2,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("failed");
    // LLM's guess survives — we only reconcile on successful save.
    expect(
      g.getFunction("src/a.ts", "foo")!.spec!.dependencies,
    ).toEqual(["initial-guess"]);
  });

  it("pre-test green path also reconciles dependencies", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "helper", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "compose",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: ["wrong"],
      edgeCases: [],
      examples: [],
    });
    // Pre-populate an impl — simulates resume.
    g.setImplementation("src/a.ts", "foo", "return ctx.fns.helper(ctx);");
    const b = createDesignDispatchBridge(
      g,
      async () => "```\nAPPROVE\n```", // only architect is called
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(
      g.getFunction("src/a.ts", "foo")!.spec!.dependencies,
    ).toEqual(["helper"]);
  });

  it("pre-test path rejects a loaded body with a top-level import (analyzer fires before tests)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    // Resume scenario: a stale body from disk with a forbidden import.
    g.setImplementation(
      "src/a.ts",
      "foo",
      "import fs from 'node:fs';\nreturn 1;",
    );
    let testsRan = false;
    let attempts = 0;
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempts++;
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => {
          testsRan = true;
          return { ok: true, passed: 1, failed: 0, output: "ok" };
        },
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    // The regenerate loop runs: at least one Implementer call made.
    expect(attempts).toBeGreaterThanOrEqual(1);
    // First Implementer attempt must carry the analyzer feedback (NOT
    // deferred until attempt 2 like the pre-fix behavior).
    expect(prompts[0]).toMatch(/Static-analysis violation/);
    expect(prompts[0]).toMatch(/import from "node:fs"/);
    // Tests for the stale body were never run — analyzer short-circuits.
    // (tests DO run for the regenerated clean body.)
    expect(testsRan).toBe(true);
  });

  it("pre-test architect REVISE surfaces on attempt 0, not attempt 2", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    g.setImplementation("src/a.ts", "foo", "return 42;");
    const prompts: string[] = [];
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewIdx++;
          if (reviewIdx === 1)
            return "```\nREVISE\nBody returns 42 but spec says 1.\n```";
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // First Implementer prompt (attempt 0) must carry the pre-test
    // architect feedback — the pre-fix bug dropped it until attempt 1+.
    const implementerPrompts = prompts.filter(
      (p) => !p.includes("You are the ARCHITECT reviewing"),
    );
    expect(implementerPrompts.length).toBeGreaterThanOrEqual(1);
    expect(implementerPrompts[0]).toMatch(/Architect review feedback/i);
    expect(implementerPrompts[0]).toMatch(/returns 42/);
  });

  it("accepts a body that calls a declared sibling", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "helper", { params: [], returnType: "number" });
    const b = createDesignDispatchBridge(
      g,
      async () => (
        "```ts\nreturn ctx.fns.helper(ctx);\n```\n" +
        '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
      ),
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(1);
  });
});

describe("parseReviewVerdict", () => {
  it("parses APPROVE from a fenced block", () => {
    expect(parseReviewVerdict("```\nAPPROVE\n```")).toEqual({
      approved: true,
      feedback: "",
    });
  });

  it("parses REVISE with feedback from a fenced block", () => {
    const v = parseReviewVerdict(
      "```\nREVISE\nBody doesn't handle the empty-input case listed in the spec.\n```",
    );
    expect(v.approved).toBe(false);
    expect(v.feedback).toMatch(/empty-input/);
  });

  it("approves by default when no fenced block is present (fail-open)", () => {
    // Tests already passed — a parse-broken review shouldn't block.
    expect(parseReviewVerdict("meh")).toEqual({ approved: true, feedback: "" });
  });

  it("is case-insensitive on the verdict keyword", () => {
    expect(parseReviewVerdict("```\napprove\n```").approved).toBe(true);
    expect(parseReviewVerdict("```\nrevise\nneed more\n```").approved).toBe(false);
  });

  it("parses the spec field tag on a REVISE verdict", () => {
    const v = parseReviewVerdict(
      "```\nREVISE purpose\nBody doesn't match the spec's stated purpose.\n```",
    );
    expect(v.approved).toBe(false);
    expect(v.specField).toBe("purpose");
    expect(v.feedback).toMatch(/stated purpose/);
  });

  it("accepts other valid spec fields (edgeCases, sideEffects, output, inputs, dependencies, examples)", () => {
    for (const field of [
      "edgeCases",
      "sideEffects",
      "output",
      "inputs",
      "dependencies",
      "examples",
    ]) {
      const v = parseReviewVerdict(
        "```\nREVISE " + field + "\nsome feedback\n```",
      );
      expect(v.approved).toBe(false);
      expect(v.specField).toBe(field);
    }
  });

  it("REVISE without a recognized field tag still rejects (no field coerced)", () => {
    const v = parseReviewVerdict("```\nREVISE\ngeneric feedback\n```");
    expect(v.approved).toBe(false);
    expect(v.specField).toBeUndefined();
  });

  it("REVISE with an unknown tag leaves specField undefined (back-compat)", () => {
    const v = parseReviewVerdict(
      "```\nREVISE quality\ncode smell\n```",
    );
    expect(v.approved).toBe(false);
    // `quality` is not in our spec-field allowlist — treat as
    // untagged to avoid giving the Implementer a misleading citation.
    expect(v.specField).toBeUndefined();
  });

  it("handles REVISE with trailing punctuation or markdown", () => {
    expect(parseReviewVerdict("```\nREVISE:\nbody doesn't handle X\n```").approved).toBe(false);
    expect(parseReviewVerdict("```\n**REVISE**\nbody doesn't handle X\n```").approved).toBe(false);
    expect(parseReviewVerdict("```\nREVISE — needs more work\ndetails\n```").approved).toBe(false);
  });

  it("handles APPROVE with trailing punctuation or markdown", () => {
    expect(parseReviewVerdict("```\nAPPROVE.\n```").approved).toBe(true);
    expect(parseReviewVerdict("```\n**APPROVE**\n```").approved).toBe(true);
  });

  it("empty-feedback REVISE fails open (no actionable signal → approve)", () => {
    // The Implementer can't act on empty feedback; rejecting here just
    // burns a retry on nothing. Approve to avoid wasted cycles.
    expect(parseReviewVerdict("```\nREVISE\n```")).toEqual({
      approved: true,
      feedback: "",
    });
    expect(parseReviewVerdict("```\nREVISE\n   \n```")).toEqual({
      approved: true,
      feedback: "",
    });
  });
});

describe("architect review (post-green gate)", () => {
  const specResp = {
    purpose: "returns 1",
    inputs: [],
    output: { type: "number", description: "the literal 1" },
    sideEffects: [],
    dependencies: [],
    edgeCases: [],
    examples: [],
  };

  function seed(): ReturnType<typeof createDesignGraph> {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", specResp);
    return g;
  }

  it("APPROVE after tests green → dispatch returns tests-green as usual", async () => {
    const g = seed();
    const calls: string[] = [];
    const response =
      "```ts\nreturn 1;\n```\n" +
      '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        calls.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return response;
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    // One Implementer call + one Architect review.
    expect(calls.filter((c) => c.includes("You are the ARCHITECT reviewing"))).toHaveLength(1);
  });

  it("review prompt shows the full wrapped function (signature + body), not body-only", async () => {
    // Without this, the architect sees a body like `const x = ...; return x;`
    // and mistakenly concludes "no ctx parameter" — the wrapping
    // signature is invisible. The review must show the rendered
    // `export default function <name>(ctx: Ctx, ...) { <body> }` form.
    const g = createDesignGraph();
    g.addFunction(
      "src/a.ts",
      "foo",
      { params: [{ name: "n", type: "number" }], returnType: "string" },
    );
    g.setSpec("src/a.ts", "foo", {
      purpose: "stringify n",
      inputs: [{ name: "n", type: "number", description: "the number" }],
      output: { type: "string", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn String(n);\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx,1)).toBe(\\"1\\");"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const review = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(review).toBeDefined();
    // Must show the FULL signature, not just the body statements.
    expect(review).toMatch(/function foo\(ctx: Ctx, n: number\): string/);
  });

  it("review prompt enumerates the spec's edgeCases verbatim + says NOT to invent new ones", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "does x",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [
        "empty input returns []",
        "null throws TypeError",
      ],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"foo(ctx);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const review = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(review).toBeDefined();
    // Must show the edgeCases verbatim so the architect anchors to them.
    expect(review).toContain("empty input returns []");
    expect(review).toContain("null throws TypeError");
    // Must tell the architect NOT to invent edgeCases outside the list.
    expect(review).toMatch(/NOT.*invent|only.*(?:listed|above)/i);
  });

  it("review prompt instructs REVISE with a spec-field tag (structured verdict)", async () => {
    const g = seed();
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const review = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(review).toBeDefined();
    // The prompt must advertise the allowed spec fields so the LLM
    // cites one — this traces critiques back to the spec.
    expect(review).toContain("purpose");
    expect(review).toContain("edgeCases");
    expect(review).toContain("sideEffects");
    expect(review).toMatch(/REVISE <\w+>|REVISE <[\w|]+>/);
  });

  it("review prompt includes proc-ts convention reminder (ctx, ctx.fns, no imports)", async () => {
    const g = seed();
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const review = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(review).toBeDefined();
    // proc-ts reminder must appear so the architect doesn't flag
    // ctx-passing or ctx.fns.<name>(ctx, …) as incorrect.
    expect(review).toMatch(/proc-ts/i);
    expect(review).toMatch(/ctx\.fns/);
  });

  it("review prompt anchors critique to the spec (no general-quality feature creep)", async () => {
    const g = seed();
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const review = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(review).toBeDefined();
    // Must tell the architect to anchor to the SPEC and not invent
    // requirements outside it.
    expect(review).toMatch(/only (?:raise|flag|reject) .* (?:in|from) the SPEC|DO NOT .* outside|anchor .* spec/i);
  });

  it("stagnation hint fires at most ONCE per dispatch even if conditions persist", async () => {
    const g = seed();
    const prompts: string[] = [];
    // All attempts return the same body + same failures — stagnation
    // conditions persist. We should see the hint once, then not again.
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return (
          "```ts\nreturn 0;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: false, passed: 0, failed: 2, output: "red" }),
        maxReviewCycles: 0,
        maxAttempts: 6,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const stagnationPrompts = prompts.filter((p) =>
      /Stagnation detected/.test(p),
    );
    // Hint fires at most once even though conditions persist across
    // multiple attempts. Nagging doesn't help.
    expect(stagnationPrompts.length).toBeLessThanOrEqual(1);
  });

  it("stagnation does NOT flag on review-driven iterations (tests green but architect REVISE)", async () => {
    // Attempts that go GREEN and get REVISE'd by the architect are not
    // "cosmetic tweaks" — the Implementer is responding to reviewer
    // feedback. Flagging them as stagnation sends a misleading nudge.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    const prompts: string[] = [];
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewIdx++;
          // Two REVISE cycles, then APPROVE.
          if (reviewIdx < 3) return "```\nREVISE purpose\nkeep iterating\n```";
          return "```\nAPPROVE\n```";
        }
        // Each attempt returns a similar-length body (triggers the
        // length heuristic) and tests always pass.
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 3,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const implementerPrompts = prompts.filter(
      (p) => !p.includes("You are the ARCHITECT reviewing"),
    );
    // None of the retries should claim stagnation — tests never
    // failed, and failures going from 0 to 0 isn't stagnation.
    for (const p of implementerPrompts) {
      expect(p).not.toMatch(/Stagnation detected/);
    }
  });

  it("pre-test green → REVISE → regenerate-loop red exhaust preserves the pre-loaded body", async () => {
    // Repro: stored body was green AND architect REVISE'd in pre-test.
    // The regenerate loop then burns all attempts on broken bodies.
    // On exhaustion the pre-loaded green body must be restored —
    // without the fix, lastGreenBody is null and we drop to stub.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    // Seed a working body on the graph — simulates a loaded/stored impl.
    g.setImplementation("src/a.ts", "foo", "return 1;");
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nREVISE purpose\nnever happy\n```";
        }
        // All Implementer responses produce a broken body (fails tests).
        return (
          "```ts\nreturn 0;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async (_g, c) => ({
          ok: c.body === "return 1;",
          passed: c.body === "return 1;" ? 1 : 0,
          failed: c.body === "return 1;" ? 0 : 1,
          output: c.body === "return 1;" ? "pass" : "red",
        }),
        maxReviewCycles: 3,
        maxAttempts: 3,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // Pre-loaded green body must survive the failed regenerate loop.
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBe("return 1;");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("architect-rejected");
  });

  it("preserves a tests-green body when architect cap exhausts (never regress to null)", async () => {
    // Attempt 1: tests green → architect REVISE (cycle 1).
    // Attempt 2: tests green → architect REVISE (cycle 2).
    // Attempt 3: tests green → architect REVISE (cycle 3 = cap).
    // At cap exhaustion, the LAST green body must be saved to the
    // graph with architect-rejected status — better to have
    // functional-but-unreviewed code than a null implementation.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nREVISE purpose\nnever happy\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 3,
        maxAttempts: 5,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    // Dispatch is marked failed per the architect-cap policy, but
    // the last tests-green body is preserved on the graph so
    // finalize can emit real code.
    expect(result.status).toBe("failed");
    expect(result.implementation).toBe("return 1;");
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBe("return 1;");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("architect-rejected");
  });

  it("preserves the last tests-green body when attempts exhaust after regression (handleRequest pattern)", async () => {
    // Attempt 1: tests green → architect REVISE.
    // Attempt 2+: tests RED (regression triggered by chasing review).
    // On attempts-exhausted, the attempt-1 green body must be saved
    // (this is the `handleRequest` regression pattern from the run).
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    let attempt = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nREVISE purpose\nneeds more\n```";
        }
        attempt++;
        if (attempt === 1) {
          // Green body that satisfies the spec directly.
          return (
            "```ts\nreturn 1;\n```\n" +
            '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
          );
        }
        // All subsequent attempts emit a wrong body that fails tests.
        return (
          "```ts\nreturn 0;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async (_g, c) => ({
          ok: c.body === "return 1;",
          passed: c.body === "return 1;" ? 1 : 0,
          failed: c.body === "return 1;" ? 0 : 1,
          output: c.body === "return 1;" ? "pass" : "red",
        }),
        maxReviewCycles: 3,
        maxAttempts: 4,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.implementation).toBe("return 1;");
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBe("return 1;");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("architect-rejected");
  });

  it("cycle 2+ review prompt includes the PRIOR cycle's feedback (no flip-flops)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["zero", "negative"],
      examples: [],
    });
    const reviewPrompts: string[] = [];
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewPrompts.push(p);
          reviewIdx++;
          if (reviewIdx === 1)
            return "```\nREVISE edgeCases\nMissing the zero-input case explicitly.\n```";
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // Cycle 2's review prompt must embed cycle 1's critique so the
    // architect can confirm it was addressed (vs silently contradict).
    expect(reviewPrompts.length).toBe(2);
    expect(reviewPrompts[1]).toMatch(/previous.*feedback|prior.*cycle|cycle 1/i);
    expect(reviewPrompts[1]).toContain("zero-input case");
  });

  it("REVISE with a spec-field tag → retry prompt leads with the cited field", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["zero", "negative"],
      examples: [],
    });
    const prompts: string[] = [];
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewIdx++;
          if (reviewIdx === 1) {
            return "```\nREVISE edgeCases\nMissing the zero-input case.\n```";
          }
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const implementerPrompts = prompts.filter(
      (p) => !p.includes("You are the ARCHITECT reviewing"),
    );
    // Second Implementer prompt must name the cited spec field so the
    // Implementer knows which part of the spec to consult.
    expect(implementerPrompts[1]).toMatch(/spec\.edgeCases|edgeCases/);
  });

  it("REVISE after tests-green → second Implementer prompt contains architect feedback", async () => {
    const g = seed();
    const prompts: string[] = [];
    let implIdx = 0;
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewIdx++;
          if (reviewIdx === 1) {
            return (
              "```\nREVISE\nThe unit test only asserts truthiness — it must assert equality to 1.\n```"
            );
          }
          return "```\nAPPROVE\n```";
        }
        implIdx++;
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        // Both Implementer submissions pass tests. Only the architect
        // rejects the first one.
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    // Two Implementer calls + two Architect reviews.
    const implementerCalls = prompts.filter(
      (p) => !p.includes("You are the ARCHITECT reviewing"),
    );
    expect(implementerCalls).toHaveLength(2);
    // Second Implementer prompt must carry the architect feedback.
    expect(implementerCalls[1]).toMatch(/Architect review feedback/i);
    expect(implementerCalls[1]).toContain("truthiness");
  });

  it("REVISE exhausts maxReviewCycles → dispatch returns failed", async () => {
    const g = seed();
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nREVISE\nNever satisfied.\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
        maxAttempts: 5,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/architect/i);
  });

  it("architect-exhaust marks fn.status='architect-rejected', not 'tests-red'", async () => {
    const g = seed();
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nREVISE\nNot aligned with spec.\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
        maxAttempts: 5,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // Tests passed — status must NOT be "tests-red". It's a distinct
    // architect-rejection outcome.
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.status).toBe("architect-rejected");
  });

  it("pre-test path (loaded body) still runs architect review", async () => {
    const g = seed();
    // Pre-populate an implementation — simulates resume/loaded graph.
    g.setImplementation("src/a.ts", "foo", "return 1;");
    let reviewCalled = false;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewCalled = true;
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    // Pre-test path must not skip architect review.
    expect(reviewCalled).toBe(true);
  });

  it("architect review prompt lists children for a branch function", async () => {
    const g = seed();
    g.addFunctionChild(
      "foo",
      "src/a.ts",
      "childA",
      { params: [{ name: "x", type: "number" }], returnType: "number" },
      "doubles x",
    );
    g.addFunctionChild(
      "foo",
      "src/a.ts",
      "childB",
      { params: [], returnType: "string" },
      "returns tag",
    );
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        // Branch body must call all declared children (new
        // decomposition/recomposition check).
        return (
          "```ts\nctx.fns.childA(ctx, 2);\nctx.fns.childB(ctx);\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```\n' +
          '```integration-tests\n[{"name":"i","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 2,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const reviewPrompt = prompts.find((p) =>
      p.includes("You are the ARCHITECT reviewing"),
    );
    expect(reviewPrompt).toBeDefined();
    expect(reviewPrompt).toContain("childA");
    expect(reviewPrompt).toContain("childB");
    expect(reviewPrompt).toContain("doubles x");
  });

  it("REVISE second-attempt Implementer prompt labels feedback as architect, not test output", async () => {
    const g = seed();
    const prompts: string[] = [];
    let reviewIdx = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("You are the ARCHITECT reviewing")) {
          reviewIdx++;
          if (reviewIdx === 1)
            return "```\nREVISE\nBody returns a tautology.\n```";
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "pass" }),
        maxReviewCycles: 2,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const implementerCalls = prompts.filter(
      (p) => !p.includes("You are the ARCHITECT reviewing"),
    );
    expect(implementerCalls).toHaveLength(2);
    const retryPrompt = implementerCalls[1];
    // Architect feedback must appear under a dedicated section —
    // stuffing it under "Test output:" misleads the Implementer.
    expect(retryPrompt).toMatch(/Architect review feedback/i);
    expect(retryPrompt).toContain("tautology");
    // The canonical "Test output:" block, if present, should not
    // contain the architect feedback string.
    const testOutputIdx = retryPrompt.indexOf("Test output:");
    if (testOutputIdx >= 0) {
      const testOutputSection = retryPrompt.slice(
        testOutputIdx,
        testOutputIdx + 400,
      );
      expect(testOutputSection).not.toMatch(/tautology/);
    }
  });

  it("'all tests failed' flag clears when the next attempt fails extraction (no tests ran)", async () => {
    // Staleness repro:
    //   attempt 1 → tests red 0/N (flag TRUE)
    //   attempt 2 → chat returns no fenced block → extraction fails
    //               → continue without running tests
    //   attempt 3 → prompt must NOT say "every test failed" because
    //               no tests ran on attempt 2. Without the fix the
    //               stale flag bleeds into this prompt.
    const g = seed();
    const prompts: string[] = [];
    let attempt = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        attempt++;
        if (attempt === 1) {
          return (
            "```ts\nreturn 0;\n```\n" +
            '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
          );
        }
        if (attempt === 2) {
          // No fenced block — extraction fails.
          return "no fence at all";
        }
        // Attempt 3: valid body that goes green so dispatch terminates.
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async (_g, c) => {
          const passes = c.body === "return 1;";
          return {
            ok: passes,
            passed: passes ? 1 : 0,
            failed: passes ? 0 : 1,
            output: passes ? "ok" : "red",
          };
        },
        maxReviewCycles: 0,
        maxAttempts: 5,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // Attempt 2 SHOULD carry the hint — attempt 1 was 0/1.
    expect(prompts[1]).toMatch(/every test failed/i);
    // Attempt 3 must NOT — attempt 2 didn't run tests (extraction fail).
    expect(prompts[2]).toBeDefined();
    expect(prompts[2]).not.toMatch(/every test failed/i);
  });

  it("maxReviewCycles=0 disables review (existing behavior)", async () => {
    const g = seed();
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(prompts.some((p) => p.includes("You are the ARCHITECT reviewing"))).toBe(false);
  });
});

describe("askDecompose complexity floor (skip the LLM call)", () => {
  it("does NOT auto-IMPLEMENT when spec.purpose is long (>300 chars — proxy for scope)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "x".repeat(400),
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["a", "b"],
      examples: [],
    });
    let decomposeAsked = false;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("deciding how to implement")) {
          decomposeAsked = true;
          return "```\nIMPLEMENT\n```";
        }
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    // Long purpose indicates scope — LLM must be consulted for the
    // DECOMPOSE decision even if deps=0 and edgeCases are few.
    expect(decomposeAsked).toBe(true);
  });

  it("does NOT auto-IMPLEMENT when spec.sideEffects.length > 1 (multiple concerns)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "short",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: ["writes a file", "sends an HTTP response", "logs to console"],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    let decomposeAsked = false;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("deciding how to implement")) {
          decomposeAsked = true;
          return "```\nIMPLEMENT\n```";
        }
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"foo(ctx);"}]\n```'
        );
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    expect(decomposeAsked).toBe(true);
  });

  it("auto-IMPLEMENT when spec has 0 deps and <=5 edgeCases — no chat call for decompose", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "returns 1",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["zero", "negative"],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        if (p.includes("deciding how to implement")) {
          throw new Error("askDecompose LLM call must be skipped for leaf spec");
        }
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 1,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
  });

  it("still calls the LLM when deps > 0", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "dep", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "orchestrates",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: ["dep"],
      edgeCases: [],
      examples: [],
    });
    let decomposeAsked = false;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("deciding how to implement")) {
          decomposeAsked = true;
          return "```\nIMPLEMENT\n```";
        }
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn ctx.fns.dep(ctx);\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    expect(decomposeAsked).toBe(true);
  });

  it("still calls the LLM when edgeCases > 5", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "many cases",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: ["a", "b", "c", "d", "e", "f"], // 6 > 5
      examples: [],
    });
    let decomposeAsked = false;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        if (p.includes("deciding how to implement")) {
          decomposeAsked = true;
          return "```\nIMPLEMENT\n```";
        }
        if (p.includes("You are the ARCHITECT reviewing")) {
          return "```\nAPPROVE\n```";
        }
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo");
    expect(decomposeAsked).toBe(true);
  });
});

describe("askDecompose prompt wording (reuse + 30-line budget)", () => {
  it("strongly prefers IMPLEMENT and mentions the ~30-line budget", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "dep", { params: [], returnType: "number" });
    g.setSpec("src/a.ts", "foo", {
      purpose: "orchestrates one dep",
      inputs: [],
      output: { type: "number", description: "" },
      sideEffects: [],
      dependencies: ["dep"],
      edgeCases: [],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return "```\nIMPLEMENT\n```";
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo").catch(() => {});
    const decomposePrompt = prompts.find((p) =>
      p.includes("deciding how to implement"),
    );
    expect(decomposePrompt).toBeDefined();
    // Budget framing — "30 lines" appears as concrete guidance.
    expect(decomposePrompt).toMatch(/30 lines/i);
    // IMPLEMENT is the default; DECOMPOSE requires justification.
    expect(decomposePrompt).toMatch(/prefer IMPLEMENT/i);
  });

  it("lists existing functions with their PURPOSES so the LLM can reuse them", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.addFunction(
      "src/a.ts",
      "loadEntries",
      { params: [], returnType: "Entry[]" },
      "Read guestbook entries from disk",
    );
    g.setSpec("src/a.ts", "loadEntries", {
      purpose: "Read guestbook entries from guestbook.json",
      inputs: [],
      output: { type: "Entry[]", description: "" },
      sideEffects: ["reads filesystem"],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    g.setSpec("src/a.ts", "foo", {
      purpose: "uses something",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: ["writes a response"],
      dependencies: ["bogus"],
      edgeCases: ["a", "b", "c", "d", "e"],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return "```\nIMPLEMENT\n```";
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
        maxReviewCycles: 0,
      },
    );
    await b.dispatch("src/a.ts", "foo").catch(() => {});
    const decomposePrompt = prompts.find((p) =>
      p.includes("deciding how to implement"),
    );
    expect(decomposePrompt).toBeDefined();
    // Existing function shown with its purpose (not just name).
    expect(decomposePrompt).toContain("loadEntries");
    expect(decomposePrompt).toMatch(/Read guestbook entries/);
    // Reuse framing is explicit.
    expect(decomposePrompt).toMatch(/reuse|REUSE/);
  });
});

describe("askDecompose prompt (spec-driven)", () => {
  it("tells the model to read the spec, not the tests", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.setSpec("src/a.ts", "parent", {
      purpose: "compose sub-steps",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: ["a", "b"],
      edgeCases: [],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return "```\nIMPLEMENT\n```";
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
      },
    );
    await b.dispatch("src/a.ts", "parent").catch(() => {});
    const decomposePrompt = prompts[0];
    expect(decomposePrompt).toBeTruthy();
    // The old wording said "Read the purpose and tests carefully"; now
    // tests are not shown until the Implementer writes them.
    expect(decomposePrompt).not.toMatch(/purpose and tests/i);
    // Spec purpose is rendered directly in the prompt.
    expect(decomposePrompt).toMatch(/Purpose:\s*compose sub-steps/);
  });

  it("includes spec.dependencies in the decompose prompt", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.setSpec("src/a.ts", "parent", {
      purpose: "compose",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: ["parseX", "writeY"],
      edgeCases: [],
      examples: [],
    });
    const prompts: string[] = [];
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        return "```\nIMPLEMENT\n```";
      },
      {
        decompose: async () => true,
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
      },
    );
    await b.dispatch("src/a.ts", "parent").catch(() => {});
    const decomposePrompt = prompts[0];
    expect(decomposePrompt).toContain("parseX");
    expect(decomposePrompt).toContain("writeY");
  });
});

describe("dispatch stores unit + integration tests from the Implementer", () => {
  it("first attempt populates fn.tests and fn.integrationTests (branch)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunctionChild(
      "foo",
      "src/a.ts",
      "helper",
      { params: [], returnType: "number" },
      "",
    );
    // Branch body must call the declared child (new
    // decomposition/recomposition check).
    const response =
      "```ts\nreturn ctx.fns.helper(ctx);\n```\n" +
      '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```\n' +
      '```integration-tests\n[{"name":"i","code":"expect(foo(ctx)).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(g, async () => response, {
      runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
    });
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    const fn = g.getFunction("src/a.ts", "foo")!;
    expect(fn.tests.map((t) => t.name)).toEqual(["u"]);
    expect(fn.integrationTests.map((t) => t.name)).toEqual(["i"]);
  });

  it("no unit-tests fence on first attempt triggers a retry", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    let attempt = 0;
    const b = createDesignDispatchBridge(
      g,
      async () => {
        attempt++;
        if (attempt === 1) return "```ts\nreturn 1;\n```"; // no tests fence
        return (
          "```ts\nreturn 1;\n```\n" +
          '```unit-tests\n[{"name":"u","code":"expect(foo(ctx)).toBe(1);"}]\n```'
        );
      },
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(1);
  });
});

describe("extractBody — ignores ```tests fence", () => {
  it("skips the tests fence and picks the code fence", () => {
    const body = extractBody(
      '```tests\n[]\n```\n```ts\nreturn 42;\n```',
    );
    expect(body).toBe("return 42;");
  });
});

describe("createDesignDispatchBridge", () => {
  it("throws when the target function is not declared", async () => {
    const g = createDesignGraph();
    const b = createDesignDispatchBridge(g, async () => "ignored");
    await expect(b.dispatch("src/a.ts", "foo")).rejects.toThrow(/not found/);
  });

  it("extracts the body, runs tests, and saves on green", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const response =
      "```js\nreturn 42;\n```\n" +
      '```unit-tests\n[{"name":"t","code":"expect(foo(ctx)).toBe(42);"}]\n```';
    const b = createDesignDispatchBridge(g, async () => response, {
      runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
    });
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.implementation).toBe("return 42;");
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBe("return 42;");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("tests-green");
    // Implementer's unit tests were stored on the graph.
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(1);
    expect(g.getFunction("src/a.ts", "foo")!.tests[0].name).toBe("t");
  });

  it("retries with failure output when tests fail, then succeeds", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const bodies = ["return 0;", "return 42;"];
    const prompts: string[] = [];
    let i = 0;
    const b = createDesignDispatchBridge(
      g,
      async (p) => {
        prompts.push(p);
        const body = bodies[i++];
        const tests =
          '```unit-tests\n[{"name":"t","code":"expect(foo(ctx)).toBe(42);"}]\n```';
        return "```js\n" + body + "\n```\n" + tests;
      },
      {
        runTests: async (_g, candidate) => ({
          ok: candidate.body === "return 42;",
          passed: candidate.body === "return 42;" ? 1 : 0,
          failed: candidate.body === "return 42;" ? 0 : 1,
          output: candidate.body === "return 42;" ? "pass" : "expected 42",
        }),
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous body");
    expect(prompts[1]).toContain("return 0;");
    expect(prompts[1]).toContain("expected 42");
  });

  it("returns status=failed after exhausting attempts", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const b = createDesignDispatchBridge(
      g,
      async () => "```js\nreturn 0;\n```",
      {
        maxAttempts: 3,
        runTests: async () => ({
          ok: false,
          passed: 0,
          failed: 1,
          output: "nope",
        }),
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(result.implementation).toBeNull();
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("tests-red");
  });

  it("retries when the model doesn't return a fenced block", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    let i = 0;
    const valid =
      "```js\nreturn 1;\n```\n" +
      '```unit-tests\n[{"name":"t","code":"expect(foo(ctx)).toBe(1);"}]\n```';
    const b = createDesignDispatchBridge(
      g,
      async () => (i++ === 0 ? "no fence here" : valid),
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
  });

  it("applies a test patch when the Implementer fixes a buggy test", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addTest("src/a.ts", "foo", {
      name: "buggy",
      code: "expect(foo(ctx)).toBe(999);", // wrong — actual body returns 1
    });
    // First attempt: Implementer returns a body AND a test patch that
    // corrects the assertion to match the body.
    let attempt = 0;
    const b = createDesignDispatchBridge(
      g,
      async () => {
        attempt++;
        if (attempt === 1) {
          return (
            "```ts\nreturn 1;\n```\n" +
            '```tests\n[{"name":"buggy","code":"expect(foo(ctx)).toBe(1);"}]\n```'
          );
        }
        return "```ts\nreturn 1;\n```";
      },
      {
        runTests: async (_g, c) => {
          // After the patch, the new test expects 1 — body returns 1 → pass.
          const fn = _g.getFunction("src/a.ts", "foo")!;
          const passes =
            fn.tests.some((t) => t.code.includes("toBe(1)")) &&
            c.body === "return 1;";
          return {
            ok: passes,
            passed: passes ? 1 : 0,
            failed: passes ? 0 : 1,
            output: "",
          };
        },
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    // The test was patched: now asserts .toBe(1).
    expect(g.getFunction("src/a.ts", "foo")!.tests[0].code).toContain(
      "toBe(1)",
    );
  });

  it("replaces unit tests wholesale on each regen — no accumulation of contradictory assertions", async () => {
    // Before Round 6, mergeTests appended new tests to existing ones,
    // deduping only by name. A model that emitted two differently-named
    // tests asserting contradictory things about the same input would
    // keep both, stalling forever at N/M. After the fix, each regen
    // replaces the test set with whatever the LLM emits.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addTest("src/a.ts", "foo", {
      name: "stale A",
      code: "expect(foo(ctx)).toBe(1);",
    });
    g.addTest("src/a.ts", "foo", {
      name: "stale B",
      code: "expect(foo(ctx)).toBe(2);",
    });
    expect(g.getFunction("src/a.ts", "foo")!.tests).toHaveLength(2);
    const b = createDesignDispatchBridge(
      g,
      async () =>
        '```ts\nreturn 1;\n```\n' +
        '```unit-tests\n[{"name":"fresh","code":"expect(foo(ctx)).toBe(1);"}]\n```',
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const tests = g.getFunction("src/a.ts", "foo")!.tests;
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe("fresh");
  });

  it("leaves existing unit tests untouched when the LLM emits no test fence", async () => {
    // Replace-on-regen must only fire when the LLM actually emits a
    // unit-tests patch. A response that omits the fence leaves stored
    // tests alone (otherwise we'd erase valid tests every cycle).
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addTest("src/a.ts", "foo", {
      name: "keep me",
      code: "expect(foo(ctx)).toBe(1);",
    });
    const b = createDesignDispatchBridge(
      g,
      async () => "```ts\nreturn 1;\n```",
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "" }),
      },
    );
    await b.dispatch("src/a.ts", "foo");
    const tests = g.getFunction("src/a.ts", "foo")!.tests;
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe("keep me");
  });

  it("bails early when two consecutive test-red runs produce identical signatures (stagnation)", async () => {
    // The dispatcher used to spin through all maxAttempts even when the
    // test output plateaued at an unchanging failure. After Round 13,
    // a streak of identical failure signatures halts the loop and
    // returns status=failed with error="stagnation: ..." so the
    // orchestrator can move on to the next function.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    let attempts = 0;
    const b = createDesignDispatchBridge(
      g,
      async () => {
        attempts++;
        return (
          '```ts\nreturn 1;\n```\n' +
          '```unit-tests\n[{"name":"t","code":"expect(foo(ctx)).toBe(2);"}]\n```'
        );
      },
      {
        // Same failure output every time → stagnation kicks in.
        runTests: async () => ({
          ok: false,
          passed: 0,
          failed: 1,
          output: "expected 1 to be 2",
        }),
        maxAttempts: 8,
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/stagnation/i);
    // 2-streak threshold → bail fires on the 2nd red run. Some additional
    // attempts happen before tests are parsed (pre-test path etc.), so we
    // just assert we didn't burn all 8 attempts.
    expect(attempts).toBeLessThan(8);
  });

  it("captures chat errors and reports failed", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const b = createDesignDispatchBridge(g, async () => {
      throw new Error("chat failed");
    });
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/chat failed/);
  });
});
