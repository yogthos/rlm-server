import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  materializeWithOverride,
  runTests,
  buildTestOutput,
} from "../../src/rlm/test-runner.js";
import { stubFunctionFile, mirrorTestsToFiles } from "./fixtures.js";

const addSig = {
  params: [
    { name: "a", type: "number" },
    { name: "b", type: "number" },
  ],
  returnType: "number",
};
const intSig = { params: [], returnType: "number" };

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
      body: stubFunctionFile("add", "return a + b;", addSig),
    });
    expect(files["add.ts"]).toContain(
      "function add(a: number, b: number): number",
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
      body: stubFunctionFile("add", "return a + b;", addSig),
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
      body: stubFunctionFile("foo", "return 1;", intSig),
    });
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBeNull();
  });

  it("safe under concurrent materialize calls (no cross-contamination)", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "number" });
    const barFile = stubFunctionFile("bar", "return 99;", intSig);
    g.setImplementation("src/a.ts", "bar", barFile);
    // Override only foo — bar must retain its persisted body in its own file.
    const files = materializeWithOverride(g, {
      module: "src/a.ts",
      name: "foo",
      body: stubFunctionFile("foo", "return 1;", intSig),
    });
    expect(files["foo.ts"]).toContain("return 1;");
    expect(files["bar.ts"]).toContain("return 99;");
    // The stored foo must still be null (no mutation leaked through finally).
    expect(g.getFunction("src/a.ts", "foo")!.implementation).toBeNull();
    expect(g.getFunction("src/a.ts", "bar")!.implementation).toBe(barFile);
  });

  it("includes a <name>.test.ts test file when the function has tests", () => {
    const g = createDesignGraph();
    g.addFunction("src/math.ts", "add", {
      params: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
      returnType: "number",
    });
    g.addTest("src/math.ts", "add", {
      name: "adds two numbers",
      code: "expect(add(2, 3)).toBe(5);",
    });
    mirrorTestsToFiles(g);
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
      code: "expect(add(2, 3)).toBe(5);",
    });
    mirrorTestsToFiles(g);
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: stubFunctionFile("add", "return a + b;", addSig),
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
      code: "expect(add(2, 3)).toBe(5);",
    });
    g.addTest("src/math.ts", "broken", {
      name: "broken test",
      code: "expect(broken()).toBe(1);",
    });
    mirrorTestsToFiles(g);
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: stubFunctionFile("add", "return a + b;", addSig),
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
      code: "expect(statusOf({ statusCode: 201 } as any)).toBe(201);",
    });
    mirrorTestsToFiles(g);
    const result = await runTests(g, {
      module: "src/http.ts",
      name: "statusOf",
      body: stubFunctionFile("statusOf", "return res.statusCode;", {
        params: [{ name: "res", type: "import('node:http').ServerResponse" }],
        returnType: "number",
      }),
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
      code: "expect(main()).toBe(42);",
    });
    // Simulate a completed earlier dispatch: helper is green on disk.
    g.setImplementation(
      "src/util.ts",
      "helper",
      stubFunctionFile("helper", "return 42;", intSig),
    );
    g.setTestStatus("src/util.ts", "helper", "tests-green", "");
    mirrorTestsToFiles(g);

    const projectDir = await createProjectDir(g);
    try {
      const r = await runTests(
        g,
        {
          module: "src/app.ts",
          name: "main",
          body:
            `import helper from "./helper.js";\n` +
            stubFunctionFile("main", "return helper();", intSig),
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
      code: "expect(add(2, 3)).toBe(5);",
    });
    mirrorTestsToFiles(g);
    const projectDir = await createProjectDir(g);
    try {
      const addFile = stubFunctionFile("add", "return a + b;", addSig);
      const cold = await runTests(
        g,
        { module: "src/math.ts", name: "add", body: addFile },
        { projectDir: projectDir.path },
      );
      expect(cold.ok).toBe(true);
      // Second run reuses cached compilations — result must stay green.
      const warm = await runTests(
        g,
        { module: "src/math.ts", name: "add", body: addFile },
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
      code: "expect(root()).toBe(7);",
    });
    g.addIntegrationTest("src/r.ts", "root", {
      name: "integration-level",
      code: "expect(root()).toBe(7);",
    });
    g.addTest("src/r.ts", "child", {
      name: "child unit",
      code: "expect(child()).toBe(7);",
    });
    g.setImplementation(
      "src/r.ts",
      "child",
      stubFunctionFile("child", "return 7;", intSig),
    );
    g.setTestStatus("src/r.ts", "child", "tests-green", "");
    mirrorTestsToFiles(g);

    const result = await runTests(g, {
      module: "src/r.ts",
      name: "root",
      body:
        `import child from "./child.js";\n` +
        stubFunctionFile("root", "return child();", intSig),
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
      code: "expect(add(2, 3)).toBe(5);",
    });
    mirrorTestsToFiles(g);
    const result = await runTests(g, {
      module: "src/math.ts",
      name: "add",
      body: stubFunctionFile("add", "return a - b;", addSig),
    });
    expect(result.ok).toBe(false);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.output.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("createProjectDir scaffolding — minimalism (Phase U5)", () => {
  it("does NOT emit a jest.config.js (architect owns it via decisions.packageJson)", async () => {
    const { createDesignGraph } = await import(
      "../../src/rlm/design-graph.js"
    );
    const { createProjectDir } = await import("../../src/rlm/test-runner.js");
    const fs = await import("node:fs/promises");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setProjectConfig({
      packageJson:
        '{"name":"p","type":"module","devDependencies":{"jest":"^29.0.0"}}',
      testFramework: "jest", runtime: "node", testCommand: "npx jest --json", testImports: "",
      moduleSystem: "esm",
    });
    const dir = await createProjectDir(g);
    try {
      await expect(fs.access(`${dir.path}/jest.config.js`)).rejects.toThrow();
    } finally {
      await dir.dispose();
    }
  });

  it("does NOT emit jest.config.js when framework is vitest", async () => {
    const { createDesignGraph } = await import(
      "../../src/rlm/design-graph.js"
    );
    const { createProjectDir } = await import("../../src/rlm/test-runner.js");
    const fs = await import("node:fs/promises");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setProjectConfig({
      packageJson:
        '{"name":"p","type":"module","devDependencies":{"vitest":"^2.0.0"}}',
      testFramework: "vitest", runtime: "node", testCommand: "npx vitest run --reporter=json", testImports: "", moduleSystem: "esm",
    });
    const dir = await createProjectDir(g);
    try {
      await expect(
        fs.access(`${dir.path}/jest.config.js`),
      ).rejects.toThrow();
    } finally {
      await dir.dispose();
    }
  });
});

describe("buildTestOutput — stdout diagnostic (jest test-load errors)", () => {
  it("surfaces a jest 'Test suite failed to run' block from stdout", () => {
    // Jest prints test-load errors to stdout (even under --json reporter).
    // Previously buildTestOutput only scanned stderr → the implementer
    // saw "[TEST FILE DID NOT LOAD]" with no actual error. Regression
    // guard from run 14.
    const stdout = `FAIL src/foo.test.ts
  ● Test suite failed to run

    SyntaxError: Missing semicolon. (12:5)

      10 |   it("x", async () => {
      11 |     const x = 1
    > 12 |     return x
         |     ^
      13 |   })

Test Suites: 1 failed, 0 total
`;
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      "",
      true,
      stdout,
    );
    expect(out).toMatch(/TEST FILE DID NOT LOAD/);
    expect(out).toContain("Test suite failed to run");
    expect(out).toContain("SyntaxError: Missing semicolon");
  });

  it("includes stdout tail even when stderr has content", () => {
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      "some stderr noise",
      true,
      "vitest transform error: /tmp/x.test.ts:5:10\nSyntaxError: Unexpected token",
    );
    expect(out).toContain("stdout tail");
    expect(out).toContain("stderr tail");
    // Stdout's SyntaxError must be findable.
    expect(out).toContain("SyntaxError");
  });

  it("falls back to stdout when parseVitestJson fails and stderr is empty", () => {
    const out = buildTestOutput(null, "", true, "jest crash output on stdout");
    expect(out).toContain("jest crash output");
  });
});

describe("buildTestOutput — 0/0 load-failure signal", () => {
  it("leads with a clear banner when 0/0 and hasTests=true (file failed to load)", () => {
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      "SyntaxError: Unexpected token '}'\n    at Parser.js:42",
      true,
    );
    // First line tells the Implementer the test file didn't load —
    // distinct from "tests ran and some failed".
    expect(out.split("\n")[0]).toMatch(/TEST FILE DID NOT LOAD/);
    // stderr tail must be prominent so the syntax error is visible.
    expect(out).toContain("SyntaxError");
  });

  it("no banner when hasTests=false and 0/0 (legitimate no-tests case)", () => {
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      "",
      false,
    );
    expect(out).not.toMatch(/TEST FILE DID NOT LOAD/);
  });

  it("no banner when tests actually ran (passed>0 or failed>0)", () => {
    const outPassed = buildTestOutput(
      { passed: 3, failed: 0, failureDigest: "" },
      "",
      true,
    );
    expect(outPassed).not.toMatch(/TEST FILE DID NOT LOAD/);
    const outFailed = buildTestOutput(
      {
        passed: 2,
        failed: 1,
        failureDigest: "✗ adds: expected 3 to be 4",
      },
      "",
      true,
    );
    expect(outFailed).not.toMatch(/TEST FILE DID NOT LOAD/);
    expect(outFailed).toContain("expected 3 to be 4");
  });

  it("falls back to stdout+stderr when parsed is null (JSON parse failed)", () => {
    const out = buildTestOutput(null, "kaboom", true);
    expect(out).toContain("kaboom");
  });

  it("extracts a SyntaxError line from stderr even when buried in noise", () => {
    // Simulate vitest stderr where a giant deprecation warning + stack
    // push the key diagnostic out of the last-800 window.
    const noise = "x".repeat(1500);
    const stderr =
      noise +
      "\n(node:123) DeprecationWarning: foo\n" +
      "SyntaxError: Unexpected token '}' at src/foo.ts:12\n" +
      "x".repeat(1000);
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      stderr,
      true,
    );
    // The extracted diagnostic surfaces the SyntaxError regardless of
    // where it sits in the stderr.
    expect(out).toMatch(/SyntaxError: Unexpected token '\}' at src\/foo\.ts:12/);
    // And it appears near the top (in a "key error" section), not only
    // in the tail.
    const bannerEnd = out.indexOf("----- stderr tail -----");
    expect(bannerEnd).toBeGreaterThan(-1);
    const before = out.slice(0, bannerEnd);
    expect(before).toMatch(/SyntaxError/);
  });

  it("extracts other Error subclasses too (TypeError, ReferenceError)", () => {
    const stderr = "noise\nTypeError: foo is not a function\nmore noise";
    const out = buildTestOutput(
      { passed: 0, failed: 0, failureDigest: "" },
      stderr,
      true,
    );
    expect(out).toMatch(/TypeError: foo is not a function/);
  });
});
