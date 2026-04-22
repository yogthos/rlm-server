// Phase P2 — tool backend tests. Each tool maps an (args, session)
// pair to a string result that goes back to the model. These are pure
// functions of the graph state except the exec tools (typecheck /
// run_tests), which delegate to injectable backends for tests.

import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  runTool,
  createAgentSession,
} from "../../src/rlm/design-dispatch-agent.js";

function seed() {
  const g = createDesignGraph();
  g.addFunction(
    "src/db.ts",
    "initDatabase",
    { params: [{ name: "path", type: "string" }], returnType: "Database" },
    "open and initialize the sqlite db",
  );
  g.setSpec("src/db.ts", "initDatabase", {
    purpose: "open db + create guestbook table",
    inputs: [],
    output: { type: "Database", description: "handle" },
    sideEffects: ["creates table"],
    dependencies: [],
    edgeCases: ["invalid path", "readonly fs"],
    examples: [],
  });
  g.addFunction(
    "src/db.ts",
    "insertEntry",
    {
      params: [
        { name: "db", type: "Database" },
        { name: "name", type: "string" },
        { name: "message", type: "string" },
      ],
      returnType: "void",
    },
    "insert a single entry",
  );
  g.setSpec("src/db.ts", "insertEntry", {
    purpose: "insert row",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: ["writes to db"],
    dependencies: [],
    edgeCases: [],
    examples: [],
  });
  g.setImplementation(
    "src/db.ts",
    "insertEntry",
    "export default function insertEntry(db, name, message) { /* body */ }",
  );
  g.setUnitTestFile(
    "src/db.ts",
    "insertEntry",
    "import { it } from 'vitest'; it('inserts', () => {});",
  );
  g.setProjectConfig({
    runtime: "node",
    moduleSystem: "esm",
    testFramework: "vitest",
    testCommand: "npx vitest run --reporter=tap",
    singleTestCommand: "npx vitest run --reporter=tap {file}",
    testImports: "import { it, expect } from 'vitest';",
    packageJson: '{"name":"t","type":"module"}',
    tsconfig: '{"compilerOptions":{"strict":true}}',
  });
  return g;
}

describe("graph-context tools", () => {
  it("get_task returns the task string from options", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase", {
      task: "Build a guestbook app.",
    });
    const r = await runTool(session, "get_task", {});
    expect(r).toContain("Build a guestbook app.");
  });

  it("get_spec returns the function's spec", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "get_spec", {});
    expect(r).toContain("open db + create guestbook table");
    expect(r).toContain("invalid path");
  });

  it("get_decisions returns the project config", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "get_decisions", {});
    expect(r).toContain("vitest");
    expect(r).toContain("esm");
  });

  it("list_siblings returns siblings (excluding self)", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "list_siblings", {});
    expect(r).toContain("insertEntry");
    expect(r).not.toMatch(/^- initDatabase$/m);
  });

  it("get_sibling returns a sibling's spec + body + tests", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "get_sibling", { name: "insertEntry" });
    expect(r).toContain("insertEntry");
    expect(r).toContain("/* body */");
    expect(r).toContain("inserts");
  });

  it("get_sibling errors cleanly when the name is not in the graph", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "get_sibling", { name: "nonexistent" });
    expect(r).toMatch(/no function|not found|unknown/i);
  });
});

describe("file-view tools", () => {
  it("read_file reads project assets (package.json, tsconfig.json)", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const pkg = await runTool(session, "read_file", { path: "package.json" });
    expect(pkg).toContain("\"name\"");
    const ts = await runTool(session, "read_file", { path: "tsconfig.json" });
    expect(ts).toContain("strict");
  });

  it("read_file reads sibling source files via graph.materialize", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "read_file", { path: "insertEntry.ts" });
    expect(r).toContain("insertEntry");
  });

  it("read_file returns a clear error for paths that don't exist", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "read_file", { path: "missing.ts" });
    expect(r).toMatch(/not found|does not exist/i);
  });

  it("list_files returns every materializable file", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "list_files", {});
    expect(r).toContain("package.json");
    expect(r).toContain("tsconfig.json");
    expect(r).toContain("insertEntry.ts");
  });
});

describe("edit tools", () => {
  it("write_body replaces the function's current body", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "write_body", {
      content:
        "export default function initDatabase(path: string) { return {}; }",
    });
    expect(r).toMatch(/ok|wrote|saved/i);
    expect(g.getFunction("src/db.ts", "initDatabase")!.implementation).toContain(
      "return {};",
    );
  });

  it("write_test_file replaces the function's unit test file", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    await runTool(session, "write_test_file", {
      content: "import { it } from 'vitest'; it('opens db', () => {});",
    });
    expect(g.getFunction("src/db.ts", "initDatabase")!.unitTestFile).toContain(
      "opens db",
    );
  });

  it("patch_body replaces a unique substring in the body", async () => {
    const g = seed();
    g.setImplementation(
      "src/db.ts",
      "initDatabase",
      "export default function initDatabase() { return 1; }",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "patch_body", {
      search: "return 1;",
      replace: "return 2;",
    });
    expect(r).toMatch(/ok|applied/i);
    expect(g.getFunction("src/db.ts", "initDatabase")!.implementation).toContain(
      "return 2;",
    );
  });

  it("patch_body rejects when search string is not found", async () => {
    const g = seed();
    g.setImplementation(
      "src/db.ts",
      "initDatabase",
      "export default function initDatabase() { return 1; }",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "patch_body", {
      search: "not in body",
      replace: "whatever",
    });
    expect(r).toMatch(/not found|did not match/i);
    // Body unchanged.
    expect(g.getFunction("src/db.ts", "initDatabase")!.implementation).toContain(
      "return 1;",
    );
  });

  it("patch_body rejects when search string appears more than once (ambiguous)", async () => {
    const g = seed();
    g.setImplementation(
      "src/db.ts",
      "initDatabase",
      "const x = 1; const y = 1;",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "patch_body", {
      search: "1",
      replace: "2",
    });
    expect(r).toMatch(/multiple|ambiguous|not unique/i);
    // Body unchanged.
    expect(g.getFunction("src/db.ts", "initDatabase")!.implementation).toContain(
      "const x = 1",
    );
  });

  it("patch_test_file behaves identically against the unit test file", async () => {
    const g = seed();
    g.setUnitTestFile(
      "src/db.ts",
      "initDatabase",
      "it('old name', () => {});",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "patch_test_file", {
      search: "'old name'",
      replace: "'new name'",
    });
    expect(r).toMatch(/ok|applied/i);
    expect(g.getFunction("src/db.ts", "initDatabase")!.unitTestFile).toContain(
      "'new name'",
    );
  });
});

describe("exec tools (injected backends)", () => {
  it("run_tests delegates to the injected test runner and returns a structured result", async () => {
    const g = seed();
    g.setImplementation(
      "src/db.ts",
      "initDatabase",
      "export default function initDatabase() {}",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase", {
      runTests: async () => ({
        ok: false,
        passed: 2,
        failed: 1,
        output: "tap output",
        failingTestNames: ["creates table"],
        fullFailureMessages: new Map([["creates table", "assertion failed"]]),
      }),
    });
    const r = await runTool(session, "run_tests", {});
    expect(r).toContain("failed: 1");
    expect(r).toContain("creates table");
    // Structured enough for the model to act on.
    expect(r).toMatch(/passed/i);
  });

  it("run_tests response signals TESTS GREEN + REVIEW transition", async () => {
    // Critical signal — the dominant failure mode in early scenarios
    // was the model continuing to edit after green and regressing.
    // The harness now auto-transitions to REVIEW; the tool response
    // tells the model it's locked out of further edits + names the
    // verbs it gets in review (approve / revise).
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase", {
      runTests: async () => ({
        ok: true,
        passed: 5,
        failed: 0,
        output: "TAP ok",
        failingTestNames: [],
        fullFailureMessages: new Map(),
      }),
    });
    const r = await runTool(session, "run_tests", {});
    expect(r).toMatch(/TESTS GREEN/);
    expect(r).toMatch(/REVIEW/);
    expect(r).toMatch(/approve/);
    expect(r).toMatch(/revise/);
    // Side effect: session is flagged green so the main loop can
    // flip to review without re-parsing the tool text.
    expect(session.lastTestsGreen).toBe(true);
    expect(session.greenBody).toBeDefined();
  });

  it("typecheck delegates to the injected tsc runner", async () => {
    const g = seed();
    g.setImplementation(
      "src/db.ts",
      "initDatabase",
      "export default function initDatabase() {}",
    );
    const session = createAgentSession(g, "src/db.ts", "initDatabase", {
      runTypecheck: async () => ({
        ran: true,
        ok: false,
        diagnostics:
          "initDatabase.ts(3,25): error TS2304: Cannot find name 'Database'.",
      }),
    });
    const r = await runTool(session, "typecheck", {});
    expect(r).toContain("TS2304");
    expect(r).toContain("Cannot find name 'Database'");
  });
});

describe("unknown tool", () => {
  it("returns a clear error message for an unrecognized tool name", async () => {
    const g = seed();
    const session = createAgentSession(g, "src/db.ts", "initDatabase");
    const r = await runTool(session, "frobnicate", {});
    expect(r).toMatch(/unknown tool|not a valid tool/i);
  });
});
