import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  createDesignDispatchBridge,
  extractBody,
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
    const b = createDesignDispatchBridge(
      g,
      async () => "```js\nreturn 42;\n```",
      {
        runTests: async () => ({ ok: true, passed: 1, failed: 0, output: "ok" }),
      },
    );
    const result = await b.dispatch("src/a.ts", "foo");
    expect(result.status).toBe("tests-green");
    expect(result.implementation).toBe("return 42;");
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBe("return 42;");
    expect(g.getFunction("src/a.ts", "foo")!.status).toBe("tests-green");
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
        return "```js\n" + bodies[i++] + "\n```";
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
    const b = createDesignDispatchBridge(
      g,
      async () => (i++ === 0 ? "no fence here" : "```js\nreturn 1;\n```"),
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
