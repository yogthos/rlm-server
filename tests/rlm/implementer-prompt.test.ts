import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { buildImplementerPrompt } from "../../src/rlm/implementer-prompt.js";

function seedGraph() {
  const g = createDesignGraph();
  g.addModule("src/db.ts");
  g.addModule("src/schema.ts");
  g.addFunction(
    "src/db.ts",
    "connect",
    {
      params: [{ name: "path", type: "string" }],
      returnType: "Database",
    },
    "Open a SQLite database at the given path.",
  );
  g.addFunction(
    "src/schema.ts",
    "createSchema",
    { params: [{ name: "db", type: "Database" }], returnType: "void" },
    "Install the guestbook schema.",
  );
  g.addImport("src/db.ts", "Database", "better-sqlite3");
  g.addTest("src/db.ts", "connect", {
    name: "opens an in-memory db",
    code: 'const db = connect(":memory:");\nexpect(db).toBeDefined();',
  });
  return g;
}

describe("buildImplementerPrompt", () => {
  it("throws when the target function is not declared", async () => {
    const g = createDesignGraph();
    await expect(
      buildImplementerPrompt(g, "src/db.ts", "connect"),
    ).rejects.toThrow(/not found/);
  });

  it("includes identity line naming the function", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/Implementer of `connect`/);
  });

  it("renders the proc-ts signature with ctx: Ctx injected", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain(
      "function connect(ctx: Ctx, path: string): Database",
    );
  });

  it("includes the description when present", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("Open a SQLite database at the given path.");
  });

  it("lists other project functions as ctx.fns entries without descriptions", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    // The new format surfaces the call shape directly so the Implementer
    // knows HOW to invoke each sibling.
    expect(p).toContain("ctx.fns.createSchema(ctx, db: Database): void");
    expect(p).not.toContain("throw new Error");
    // Sibling descriptions are dropped — keep the prompt focused on
    // the target. The target's own description is still shown.
    expect(p).not.toContain("Install the guestbook schema");
  });

  it("embeds the tests the function must pass", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("opens an in-memory db");
    expect(p).toContain("connect(");
  });

  it("tells the implementer to call siblings via ctx.fns", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("ctx.fns");
  });

  it("defaults to vitest guidance when no projectConfig is set", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/vitest/i);
    expect(p).toMatch(/vi\.(fn|spyOn|mock)/);
    expect(p).toMatch(/jest/); // must flag the jest trap
  });

  it("switches to jest guidance when projectConfig.testFramework is jest", async () => {
    const g = seedGraph();
    g.setProjectConfig({
      packageJson:
        '{"name":"x","devDependencies":{"jest":"^29.0.0","@jest/globals":"^29.0.0"}}',
      testFramework: "jest",
    });
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/jest/);
    expect(p).toMatch(/jest\.(fn|spyOn|mock)/);
  });

  it("tells the implementer NOT to call test_run or design_implement", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("do not call test_run");
    expect(p).toContain("do not call design_implement");
  });

  it("does not include the target function in the sibling list", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    const siblingSection = p.split(/Other functions/i)[1] ?? "";
    expect(siblingSection).not.toMatch(/connect\(ctx: Ctx,/);
  });

  it("handles functions with no user params — ctx: Ctx only", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    expect(p).toContain("function foo(ctx: Ctx): void");
  });

  it("asks the Implementer to emit unit-tests when none exist yet", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    expect(p).toContain("```unit-tests");
  });

  it("tells leaves (no children) that integration tests must be an empty array", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    // Leaves don't assemble anything — their integration fence must be `[]`.
    // Storing leaf integration tests is a lie: renderIntegrationTestFile
    // drops them for children-less functions.
    expect(p).toMatch(/integration-tests[\s\S]{0,120}empty/i);
    expect(p).not.toMatch(/OPTIONAL for leaves/);
  });

  it("tells branches (with children) that integration tests are REQUIRED", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "child",
      { params: [], returnType: "void" },
      "child",
    );
    const p = await buildImplementerPrompt(g, "src/a.ts", "parent");
    expect(p).toContain("REQUIRED");
  });

  it("adds a 're-read spec' hint when ALL tests failed on the previous attempt", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 1,
      maxAttempts: 8,
      previousBody: "return null;",
      testOutput: "passed=0 failed=6",
      allTestsFailed: true,
    });
    // When every test fails, the tests themselves may be wrong (same
    // Implementer wrote both). A nudge to re-read the spec helps
    // break the identical-retry loop.
    expect(p).toMatch(/every test failed|all .* tests failed/i);
    expect(p).toMatch(/re-read|TESTS.*match/i);
  });

  it("adds a stagnation hint when the body is near-identical and failures repeat", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 2,
      maxAttempts: 8,
      previousBody: "return null;",
      testOutput: "passed=3 failed=2",
      stagnating: true,
    });
    expect(p).toMatch(/stagnat|nearly identical|different approach/i);
  });

  it("warns when the previous body is large (>2000 chars) — spec may be under-decomposed", async () => {
    const g = seedGraph();
    const largeBody = "// ".repeat(800) + "return;"; // ~2407 chars
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 2,
      maxAttempts: 8,
      previousBody: largeBody,
      testOutput: "passed=3 failed=2",
    });
    expect(p).toMatch(/large|too big|decompos|30-line/i);
  });

  it("does NOT warn about size when the previous body is small", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 1,
      maxAttempts: 8,
      previousBody: "return 1;",
      testOutput: "passed=3 failed=2",
    });
    expect(p).not.toMatch(/body is large|too big|under-decomposed/i);
  });

  it("shows previous-attempt test counts + 'do not regress' directive when provided", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 1,
      maxAttempts: 8,
      previousBody: "return null;",
      testOutput: "passed=9 failed=0",
      previousPassed: 9,
      previousFailed: 0,
    });
    // The Implementer must know attempt N-1's test counts so it
    // doesn't accidentally regress while responding to other feedback.
    expect(p).toMatch(/9 (?:tests?\s+)?pass|9 passing|passed=9/i);
    expect(p).toMatch(/do not regress|don'?t regress|preserve.*passing/i);
  });

  it("does NOT add the stagnation hint on normal retries", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 1,
      maxAttempts: 8,
      previousBody: "return null;",
      testOutput: "passed=3 failed=2",
    });
    expect(p).not.toMatch(/stagnat|nearly identical/i);
  });

  it("does NOT add the 're-read spec' hint when SOME tests passed", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect", {
      attempt: 1,
      maxAttempts: 8,
      previousBody: "return null;",
      testOutput: "passed=3 failed=2",
      allTestsFailed: false,
    });
    expect(p).not.toMatch(/every test failed/i);
  });

  it("renders async functions with the async keyword", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "load", {
      params: [],
      returnType: "Promise<string>",
      isAsync: true,
    });
    const p = await buildImplementerPrompt(g, "src/a.ts", "load");
    expect(p).toContain(
      "async function load(ctx: Ctx): Promise<string>",
    );
  });
});
