import { describe, it, expect } from "vitest";
import {
  extractBody,
  extractUnitTestFile,
  extractIntegrationTestFile,
  extractFileAssets,
} from "../../src/rlm/design-dispatch.js";
import { splitCommand, parseTapOutput, parseTestOutput } from "../../src/rlm/test-runner.js";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

describe("Phase C2 — extractUnitTestFile", () => {
  it("returns null when no fence present", () => {
    expect(extractUnitTestFile("no fences here")).toBeNull();
  });

  it("extracts the raw TS content between fences", () => {
    const r = [
      "```unit-test-file",
      "import { it } from \"vitest\";",
      "it(\"x\", () => {});",
      "```",
    ].join("\n");
    const got = extractUnitTestFile(r);
    expect(got).toBe("import { it } from \"vitest\";\nit(\"x\", () => {});\n");
  });

  it("normalizes CRLF to LF", () => {
    const r = "```unit-test-file\r\nit('x', () => {});\r\n```";
    expect(extractUnitTestFile(r)).toBe("it('x', () => {});\n");
  });

  it("ignores body ```ts fences and similar tags", () => {
    const r = [
      "```ts",
      "export default function foo() {}",
      "```",
    ].join("\n");
    expect(extractUnitTestFile(r)).toBeNull();
  });

  it("body extractor skips unit-test-file fences", () => {
    const r = [
      "```unit-test-file",
      "it('x', () => {});",
      "```",
      "```ts",
      "export default function foo() {}",
      "```",
    ].join("\n");
    expect(extractBody(r)).toBe("export default function foo() {}");
    expect(extractUnitTestFile(r)).toContain("it('x', () => {})");
  });
});

describe("Phase C2 — extractIntegrationTestFile", () => {
  it("round-trips a full integration test file", () => {
    const r = [
      "```integration-test-file",
      "import all from './x.js';",
      "it('wires', () => {});",
      "```",
    ].join("\n");
    expect(extractIntegrationTestFile(r)).toBe(
      "import all from './x.js';\nit('wires', () => {});\n",
    );
  });

  it("returns null when only the unit variant is present", () => {
    const r = "```unit-test-file\nit('x', () => {});\n```";
    expect(extractIntegrationTestFile(r)).toBeNull();
  });
});

describe("Phase G — extractFileAssets", () => {
  it("returns an empty map when no file fences present", () => {
    expect(extractFileAssets("no file fences here")).toEqual(new Map());
  });

  it("extracts one asset per fence, keyed by the path after file:", () => {
    const r = [
      "```file:package.json",
      "{ \"name\": \"foo\" }",
      "```",
      "```file:tsconfig.json",
      "{ \"compilerOptions\": {} }",
      "```",
    ].join("\n");
    const got = extractFileAssets(r);
    expect(got.size).toBe(2);
    expect(got.get("package.json")).toBe("{ \"name\": \"foo\" }");
    expect(got.get("tsconfig.json")).toBe("{ \"compilerOptions\": {} }");
  });

  it("preserves internal whitespace but strips the trailing newline before the closing fence", () => {
    const r = [
      "```file:scripts/seed.sql",
      "INSERT INTO t VALUES (1);",
      "INSERT INTO t VALUES (2);",
      "```",
    ].join("\n");
    const got = extractFileAssets(r);
    expect(got.get("scripts/seed.sql")).toBe(
      "INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);",
    );
  });

  it("skips fences with an empty path (```file:)", () => {
    const r = "```file:\ncontent\n```";
    expect(extractFileAssets(r).size).toBe(0);
  });
});

describe("Phase F — splitCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("npx vitest run")).toEqual(["npx", "vitest", "run"]);
  });

  it("preserves double-quoted arguments as a single token", () => {
    expect(splitCommand('npx vitest run --dir "sub dir"')).toEqual([
      "npx",
      "vitest",
      "run",
      "--dir",
      "sub dir",
    ]);
  });

  it("preserves single-quoted arguments", () => {
    expect(splitCommand("bun test 'pattern with space'")).toEqual([
      "bun",
      "test",
      "pattern with space",
    ]);
  });

  it("handles runs of whitespace and leading/trailing space", () => {
    expect(splitCommand("  node   --test  ")).toEqual(["node", "--test"]);
  });
});

describe("Phase F — parseTapOutput", () => {
  it("returns null when the stdout contains no TAP lines", () => {
    expect(parseTapOutput("nothing interesting here")).toBeNull();
  });

  it("counts passing tests", () => {
    const tap = [
      "TAP version 13",
      "1..2",
      "ok 1 - first test",
      "ok 2 - second test",
    ].join("\n");
    const parsed = parseTapOutput(tap);
    expect(parsed).not.toBeNull();
    expect(parsed!.passed).toBe(2);
    expect(parsed!.failed).toBe(0);
  });

  it("captures failing test names and YAML diagnostic block", () => {
    const tap = [
      "ok 1 - alpha",
      "not ok 2 - beta",
      "  ---",
      "  message: expected 1 to be 2",
      "  ...",
      "ok 3 - gamma",
    ].join("\n");
    const parsed = parseTapOutput(tap)!;
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.failingTestNames).toEqual(["beta"]);
    expect(parsed.fullFailureMessages.get("beta")).toContain("expected 1 to be 2");
  });

  it("treats # SKIP as passed and # TODO as failed", () => {
    const tap = [
      "ok 1 - a # SKIP boring",
      "ok 2 - b # TODO write body",
      "not ok 3 - c # SKIP deferred",
    ].join("\n");
    const parsed = parseTapOutput(tap)!;
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
  });

  it("parseTestOutput falls back to JSON when stdout is not TAP", () => {
    const json = JSON.stringify({
      numPassedTests: 3,
      numFailedTests: 0,
      testResults: [],
    });
    const parsed = parseTestOutput(json)!;
    expect(parsed.passed).toBe(3);
    expect(parsed.failed).toBe(0);
  });
});

import { extractProjectTestFile } from "../../src/rlm/design-project-tests.js";

describe("Phase C2 unified — extractProjectTestFile", () => {
  it("returns null when the fence is absent", () => {
    expect(extractProjectTestFile("no fences here")).toBeNull();
  });

  it("returns null when the fence is present but blank", () => {
    // Preserves the invariant that 'no authored file' maps to null,
    // so the resume check doesn't mistakenly skip the LLM.
    expect(extractProjectTestFile("```project-test-file\n\n```")).toBeNull();
    expect(
      extractProjectTestFile("```project-test-file\n   \n\t\n```"),
    ).toBeNull();
  });

  it("returns the file content when the fence is populated", () => {
    const r = [
      "```project-test-file",
      "import { it } from 'vitest';",
      "it('x', () => {});",
      "```",
    ].join("\n");
    expect(extractProjectTestFile(r)).toBe(
      "import { it } from 'vitest';\nit('x', () => {});\n",
    );
  });
});

describe("setProjectTestFile defense-in-depth", () => {
  it("treats a whitespace-only payload like null", () => {
    const g = createDesignGraph();
    g.setProjectTestFile("   \n\t  ");
    expect(g.getProjectTestFile()).toBeNull();
  });
});

describe("Phase C2 unified — project-test-file round-trip", () => {
  it("setProjectTestFile stores the file and materialize emits it verbatim", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const fileContent = [
      'import { describe, it, expect } from "vitest";',
      'import foo from "./foo.js";',
      "",
      "const ctx: any = { fns: { foo }, state: {}, t: null };",
      "",
      'describe("project", () => {',
      '  it("works", async () => {',
      "    foo(ctx);",
      "  });",
      "});",
      "",
    ].join("\n");
    g.setProjectTestFile(fileContent);
    expect(g.getProjectTestFile()).toBe(fileContent);
    const files = g.materialize();
    expect(files["project.integration.test.ts"]).toBe(fileContent);
  });

  it("setProjectTestFile(null) drops the file — no output without a file (Phase U6)", () => {
    // Under U6 there is no legacy wrap: materialize only emits the
    // project test file when the architect authored one via
    // setProjectTestFile. projectTests[] alone produces nothing.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setProjectTestFile("// verbatim");
    g.setProjectTestFile(null);
    g.addProjectTest({ name: "wrapped", code: "// body" });
    const files = g.materialize();
    expect(files["project.integration.test.ts"]).toBeUndefined();
  });

  it("snapshot includes projectTestFile", () => {
    const g = createDesignGraph();
    g.setProjectTestFile("// x");
    expect(g.snapshot().projectTestFile).toBe("// x");
  });
});

describe("Phase D — asset map round-trip", () => {
  it("setAsset, getAsset, listAssets reflect the current state", () => {
    const g = createDesignGraph();
    expect(g.getAsset("package.json")).toBeNull();
    g.setAsset("package.json", "{\"name\":\"x\"}");
    expect(g.getAsset("package.json")).toBe("{\"name\":\"x\"}");
    expect(g.listAssets()).toEqual({ "package.json": "{\"name\":\"x\"}" });
    g.setAsset("package.json", null);
    expect(g.getAsset("package.json")).toBeNull();
    expect(g.listAssets()).toEqual({});
  });

  it("assets land in the materialize output verbatim", () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    g.setAsset("custom.config", "hello\nworld");
    const files = g.materialize();
    expect(files["custom.config"]).toBe("hello\nworld");
  });

  it("snapshot includes the assets map", () => {
    const g = createDesignGraph();
    g.setAsset("tsconfig.json", "{}");
    const snap = g.snapshot();
    expect(snap.assets).toEqual({ "tsconfig.json": "{}" });
  });
});
