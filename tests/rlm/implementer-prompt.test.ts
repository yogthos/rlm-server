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

  it("renders a natural signature — no ctx injection (Phase N3)", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("function connect(path: string): Database");
    expect(p).not.toContain("ctx: Ctx");
    expect(p).not.toContain("ctx.fns");
  });

  it("includes the description when present", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("Open a SQLite database at the given path.");
  });

  it("lists other project functions as importable modules (Phase N3)", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    // Natural mode: siblings are imported directly by file. The prompt
    // shows both the import specifier and the plain call shape so the
    // model knows HOW to use each function.
    expect(p).toContain('import createSchema from "./createSchema.js"');
    expect(p).toContain("createSchema(db: Database): void");
    expect(p).not.toContain("ctx.fns");
  });

  it("embeds the tests the function must pass", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("opens an in-memory db");
    expect(p).toContain("connect(");
  });

  it("tells the implementer to import siblings directly (Phase N3)", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    // Natural TypeScript: import siblings by file, call them as normal
    // functions. No ctx, no framework wrapper.
    expect(p).toMatch(/import\s+\w+\s+from\s+"\.\/\w+\.js"/);
    expect(p).not.toContain("ctx.fns");
  });

  it("defaults to vitest guidance when no projectConfig is set", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/vitest/i);
    expect(p).toMatch(/vi\.(fn|spyOn|mock)/);
    expect(p).toMatch(/jest/); // must flag the jest trap
  });

  it("echoes the architect's testFramework + testImports from the decisions block", async () => {
    // Phase C: framework-specific guidance comes from the architect's
    // phase-0 decisions (testImports, testingNotes), not harness
    // hardcoding. The prompt surfaces both verbatim.
    const g = seedGraph();
    g.setProjectConfig({
      packageJson: '{"name":"x","devDependencies":{"jest":"^29.0.0"}}',
      testFramework: "jest",
      runtime: "node",
      testCommand: "npx jest --reporters=jest-tap-reporter",
      testImports: `import { describe, it, expect, jest } from "@jest/globals";`,
      moduleSystem: "cjs",
    });
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("testFramework:   jest");
    expect(p).toContain("@jest/globals");
    expect(p).toContain("testCommand:");
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
    // Narrow to the sibling-list section only (before the CONTRACT block).
    const siblingSection = p
      .split(/Available sibling functions/i)[1]
      ?.split(/CONTRACT \(mandatory\)/i)[0] ?? "";
    expect(siblingSection).not.toMatch(/import\s+connect\s+from/);
  });

  it("handles functions with no params naturally (Phase N3)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    expect(p).toContain("function foo(): void");
    // No framework-provided ctx anywhere in generated signatures or calls.
    expect(p).not.toContain("ctx:");
    expect(p).not.toContain("ctx.fns");
    expect(p).not.toContain("ctx.state");
    expect(p).not.toMatch(/foo\(ctx[,)]/);
  });

  it("asks the Implementer to emit a unit-test-file when none exists yet", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    // Phase C2 wrapper-kill: the model owns the entire test file.
    expect(p).toContain("```unit-test-file");
  });

  it("tells leaves (no children) to OMIT the integration-test-file", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    // Leaves don't assemble anything — no integration file is rendered
    // for them, so the prompt tells the implementer to omit the fence.
    expect(p).toMatch(/integration-test-file[\s\S]{0,120}OMIT/i);
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

  it("prompt requires a COMPLETE file, not body-only (Phase 4 wrapper-kill)", async () => {
    // Lock-in: since the wrapper kill, implementer emits the full
    // file including imports + signature + body. The prompt must not
    // regress to body-only phrasing.
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("COMPLETE function file");
    expect(p).toContain("imports + default-exported");
    expect(p).not.toMatch(/body statements only/i);
    expect(p).not.toMatch(/no signature|no.*function.*declaration/i);
  });

  it("prompt requires top-level imports for external namespaces (Phase N3 — natural)", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/`import` statements are REQUIRED/);
    expect(p).toMatch(/TS2503|Cannot find namespace/);
    // Natural mode: sibling imports are ENCOURAGED, not banned.
    expect(p).not.toMatch(/Do NOT import siblings/);
  });

  it("prompt surfaces the full decisions block including testingNotes", async () => {
    // Phase C: all project decisions (runtime, framework, commands,
    // notes, strategy) are injected verbatim so the implementer speaks
    // the architect's committed stack.
    const g = seedGraph();
    g.setProjectConfig({
      packageJson: '{"name":"t","type":"module","devDependencies":{"vitest":"^2.0.0"}}',
      testFramework: "vitest",
      runtime: "node",
      testCommand: "npx vitest run --reporter=tap",
      testImports: `import { describe, it, expect, vi } from "vitest";`,
      moduleSystem: "esm",
      testingNotes:
        "- vi.spyOn fails on ESM imports — use vi.mock('node:fs', () => ({...}))",
    });
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("Project decisions");
    expect(p).toContain("runtime:         node");
    expect(p).toContain("testFramework:   vitest");
    expect(p).toContain("testingNotes:");
    expect(p).toContain("vi.mock");
  });

  it("prompt has NO decisions block when no projectConfig is set", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).not.toContain("Project decisions");
  });

  it("prompt states the declared signature as contract (Phase N3 — natural)", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("connect");
    expect(p).toContain("path: string");
    expect(p).toContain("Database");
    expect(p).not.toContain("ctx: Ctx");
    expect(p).toMatch(/harness parses[\s\S]*rejects drift/);
  });

  it("parent prompt emphasizes composition over re-authoring (E2)", async () => {
    // Parent is told that children are authoritative — revise the
    // parent's hypothesis to match the children's actual shapes, not
    // the other way around. Lock-in test for Phase E prompt change.
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
    expect(p).toMatch(/WORKING, TESTED unit/);
    expect(p).toMatch(/REVISE YOUR HYPOTHESIS/);
    expect(p).toMatch(/AUTHORITATIVE/);
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
    expect(p).toContain("async function load(): Promise<string>");
  });
});
