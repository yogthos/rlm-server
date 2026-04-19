import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  materializeWithOverride,
  runTests,
} from "../../src/rlm/test-runner.js";

describe("materializeWithOverride", () => {
  it("substitutes the candidate body into the target's own file", () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
    });
    const files = materializeWithOverride(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a + b;",
    });
    expect(files["add.ts"]).toContain(
      "function add(ctx: Ctx, a: number, b: number): number",
    );
    expect(files["add.ts"]).toContain("return a + b;");
    expect(files["add.ts"]).not.toContain("not implemented");
  });

  it("leaves other functions as stubs", () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addFunction("src/math.ts", "sub", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    const files = materializeWithOverride(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a + b;",
    });
    expect(files["sub.ts"]).toContain("sub: not implemented");
  });

  it("throws if the target function is not declared", () => {
    const g = createDesignGraph();
    expect(() =>
      materializeWithOverride(g, {
        module: "src/a.ts",
        name: "foo",
        body: "return;",
      }),
    ).toThrow(/not found/);
  });

  it("does not mutate the original graph's implementation", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    materializeWithOverride(g, {
      module: "src/a.ts",
      name: "foo",
      body: "return 1;",
    });
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBeNull();
  });

  it("safe under concurrent materialize calls (no cross-contamination)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "number" });
    g.setImplementation("src/a.ts", "bar", "return 99;");
    // Override only foo — bar must retain its persisted body in its own file.
    const files = materializeWithOverride(g, {
      module: "src/a.ts",
      name: "foo",
      body: "return 1;",
    });
    expect(files["foo.ts"]).toContain("return 1;");
    expect(files["bar.ts"]).toContain("return 99;");
    // The stored foo must still be null (no mutation leaked through finally).
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBeNull();
    expect(g.getFunction("src/a.ts", "bar")!.implementation).toBe("return 99;");
  });

  it("includes a <name>.test.ts test file when the function has tests", () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds two numbers",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    const files = materializeWithOverride(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a + b;",
    });
    expect(Object.keys(files)).toContain("add.test.ts");
    expect(files["add.test.ts"]).toContain("adds two numbers");
  });
});

describe("runTests — end-to-end via vitest", () => {
  it("reports ok=true when the candidate body passes its tests", async () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds two numbers",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a + b;",
    });
    expect(result.ok).toBe(true);
    expect(result.passed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
  }, 30_000);

  it("scopes tests to the target function (sibling stub failures don't count)", async () => {
    // Sibling `broken` is unimplemented (stub throws). Without scoping,
    // running vitest would fail broken's test and penalize `add` — even
    // though add's own test passes.
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addFunction("src/math.ts", "broken", { params: [], returnType: "number" });
    g.addTest("src/math.ts", "add", {
      name: "adds two numbers",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    g.addTest("src/math.ts", "broken", {
      name: "broken test",
      code: "expect(broken()).toBe(1);",
    });
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a + b;",
    });
    expect(result.ok).toBe(true);
    expect(result.passed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
  }, 30_000);

  it("resolves Node built-in types (IncomingMessage etc.) in emitted files", async () => {
    // Regression: prior runs failed with 0/0 because the emitted
    // function signature referenced IncomingMessage/ServerResponse
    // without @types/node in scope. The scaffolding now symlinks the
    // host's node_modules so Node types resolve.
    const g = createDesignGraph();
    g.addFunction("src/http.ts", "statusOf", {
      params: [{ name: "res", type: "import('node:http').ServerResponse" }],
      returnType: "number",
    });
    g.addTest("src/http.ts", "statusOf", {
      name: "returns the statusCode",
      code: "expect(statusOf(ctx, { statusCode: 201 } as any)).toBe(201);",
    });
    const result = await runTests(g, {
      module: "src/http.ts",
      name: "statusOf",
      body: "return res.statusCode;",
    });
    expect(result.ok).toBe(true);
    expect(result.passed).toBeGreaterThanOrEqual(1);
  }, 45_000);

  it("persistent project dir sees a sibling's just-committed body", async () => {
    // Regression: sibling files must be rewritten too, not just the
    // target's — otherwise the test sees the stale stub throw when
    // calling ctx.fns.<sibling>.
    const { createProjectDir } = await import("../../src/rlm/test-runner.js");
    const g = createDesignGraph();
    g.addFunction("src/util.ts", "helper", {
      params: [],
      returnType: "number",
    });
    g.addFunction("src/app.ts", "main", {
      params: [],
      returnType: "number",
    });
    g.addTest("src/app.ts", "main", {
      name: "delegates to helper",
      code: "expect(main(ctx)).toBe(42);",
    });
    // Simulate a completed earlier dispatch: helper is green on disk.
    g.setImplementation("src/util.ts", "helper", "return 42;");
    g.setTestStatus("src/util.ts", "helper", "tests-green", "");

    const projectDir = await createProjectDir(g);
    try {
      const r = await runTests(
        g,
        {
          module: "src/app.ts",
          name: "main",
          body: "return ctx.fns.helper(ctx);",
        },
        { projectDir: projectDir.path },
      );
      expect(r.ok).toBe(true);
      expect(r.passed).toBeGreaterThanOrEqual(1);
    } finally {
      await projectDir.dispose();
    }
  }, 45_000);

  it("reuses a persistent project dir across attempts", async () => {
    const { createProjectDir } = await import("../../src/rlm/test-runner.js");
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    const projectDir = await createProjectDir(g);
    try {
      const cold = await runTests(
        g,
        { module: "src/math.ts", name: "add", body: "return a + b;" },
        { projectDir: projectDir.path },
      );
      expect(cold.ok).toBe(true);
      // Second run reuses cached compilations — result must stay green.
      const warm = await runTests(
        g,
        { module: "src/math.ts", name: "add", body: "return a + b;" },
        { projectDir: projectDir.path },
      );
      expect(warm.ok).toBe(true);
    } finally {
      await projectDir.dispose();
    }
  }, 45_000);

  it("runs both unit AND integration tests for a branch function", async () => {
    // Dispatch of a branch (children already green) should run the
    // branch's own unit tests AND its integration tests against real
    // wired children. The vitest --testNamePattern ^<name>\\b picks up
    // both describe blocks: `describe("foo")` and `describe("foo (integration)")`.
    const g = createDesignGraph();
    g.addFunction("src/r.ts", "root", { params: [], returnType: "number" });
    g.addFunctionChild("root", "src/r.ts", "child", { params: [], returnType: "number" });
    g.addTest("src/r.ts", "root", {
      name: "unit-level",
      code: "expect(root(ctx)).toBe(7);",
    });
    g.addIntegrationTest("src/r.ts", "root", {
      name: "integration-level",
      code: "expect(root(ctx)).toBe(7);",
    });
    g.addTest("src/r.ts", "child", {
      name: "child unit",
      code: "expect(child(ctx)).toBe(7);",
    });
    g.setImplementation("src/r.ts", "child", "return 7;");
    g.setTestStatus("src/r.ts", "child", "tests-green", "");

    const result = await runTests(g, {
      module: "src/r.ts",
      name: "root",
      body: "return ctx.fns.child(ctx);",
    });
    expect(result.ok).toBe(true);
    // 2 passes = 1 unit + 1 integration for `root`. child's test is
    // filtered out by --testNamePattern ^root\\b.
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  }, 45_000);

  it("reports ok=false with failure details when the body is wrong", async () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds two numbers",
      code: "expect(add(ctx, 2, 3)).toBe(5);",
    });
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: "return a - b;",
    });
    expect(result.ok).toBe(false);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.output.length).toBeGreaterThan(0);
  }, 30_000);
});
