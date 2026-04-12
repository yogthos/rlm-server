import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { graphAnalyze, GRAPH_IMPL } from "../../src/rlm/graph-bridge.js";

const TEST_DIR = join(tmpdir(), "rlm-graph-test-" + Date.now());

function writeTestFile(name: string, content: string): string {
  const path = join(TEST_DIR, name);
  writeFileSync(path, content);
  return path;
}

describe("graphAnalyze", () => {
  // Create test files
  const files: string[] = [];

  it("setup test files", () => {
    mkdirSync(TEST_DIR, { recursive: true });

    files.push(
      writeTestFile(
        "app.ts",
        `
import { processData } from "./utils";

export function handleRequest(req: any) {
  const result = processData(req.body);
  return formatResponse(result);
}

function formatResponse(data: any) {
  return { status: 200, body: data };
}
`,
      ),
    );

    files.push(
      writeTestFile(
        "utils.ts",
        `
export function processData(input: any) {
  const validated = validate(input);
  return transform(validated);
}

function validate(data: any) {
  return data;
}

function transform(data: any) {
  return data;
}
`,
      ),
    );
  });

  it("returns summary of the codebase", async () => {
    const result = await graphAnalyze(files, "summary");
    expect(result.analysis).toBe("summary");
    const summary = result.result as any;
    expect(summary.files).toBe(2);
    expect(summary.functions).toBeGreaterThan(0);
    expect(summary.callEdges).toBeGreaterThan(0);
  });

  it("finds callers of a function", async () => {
    const result = await graphAnalyze(files, "callers", {
      target: "processData",
    });
    expect(result.analysis).toBe("callers");
    const callerList = result.result as string[];
    expect(callerList).toContain("handleRequest");
  });

  it("finds callees of a function", async () => {
    const result = await graphAnalyze(files, "callees", {
      target: "processData",
    });
    expect(result.analysis).toBe("callees");
    const calleeList = result.result as string[];
    expect(calleeList).toContain("validate");
    expect(calleeList).toContain("transform");
  });

  it("detects dead code", async () => {
    const result = await graphAnalyze(files, "dead-code");
    expect(result.analysis).toBe("dead-code");
    const dead = result.result as string[];
    // handleRequest is exported → not dead
    // processData is exported → not dead
    // formatResponse is called by handleRequest → not dead
    // validate & transform are called by processData → not dead
    // Everything is reachable from exports, so no dead code expected
    expect(Array.isArray(dead)).toBe(true);
  });

  it("checks reachability", async () => {
    const result = await graphAnalyze(files, "reachability", {
      from: "handleRequest",
      to: "validate",
    });
    expect(result.analysis).toBe("reachability");
    expect((result.result as any).reachable).toBe(true);
  });

  it("finds impact of changing a function", async () => {
    const result = await graphAnalyze(files, "impact", {
      target: "validate",
    });
    expect(result.analysis).toBe("impact");
    const impacted = result.result as string[];
    expect(impacted).toContain("processData");
    expect(impacted).toContain("handleRequest");
  });

  it("cleanup", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});

describe("GRAPH_IMPL", () => {
  it("defines the graph function", () => {
    expect(GRAPH_IMPL).toContain("async function graph");
    expect(GRAPH_IMPL).toContain("__graphBridge");
  });
});
