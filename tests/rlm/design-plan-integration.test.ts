import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designPlanIntegration } from "../../src/rlm/design-plan-integration.js";

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

const fnListResp = `\`\`\`json\n${JSON.stringify([
  {
    module: "src/server.js",
    name: "startServer",
    signature: { params: [], returnType: "void" },
    description: "starts",
  },
])}\n\`\`\``;

const integrationTestsResp = `\`\`\`json\n${JSON.stringify([
  { name: "path startServer — boots", code: "// ok" },
])}\n\`\`\``;

function seedVitestConfig(g: ReturnType<typeof createDesignGraph>): void {
  g.setProjectConfig({
    packageJson:
      '{"name":"t","version":"0.1.0","type":"module","scripts":{"test":"vitest run"},"dependencies":{},"devDependencies":{"vitest":"^2.0.0"}}',
    testFramework: "vitest",
  });
}

function okFinalize() {
  return async () => ({
    ok: true,
    files: { "README.md": "hi" },
    unimplemented: [],
    consistency: { ok: true, violations: [], advisories: [] },
    testsPassed: 0,
    testsFailed: 0,
    testOutput: "",
    typecheckOk: true,
    typecheckOutput: "",
  });
}

describe("designPlanIntegration — happy path", () => {
  it("runs structure → coherence → leaf-up → paths → tests → review → loop → finalize", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);
    const events: string[] = [];

    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) return fnListResp;
      if (prompt.startsWith("You are reviewing")) {
        events.push("integration-test-reviewed");
        return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
      }
      if (prompt.includes("You are authoring PROJECT-LEVEL")) {
        events.push("integration-tests-authored");
        return integrationTestsResp;
      }
      return specResp;
    };

    const hardenDispatch = async (_g: any, mod: string, name: string) => {
      events.push(`harden:${name}`);
      _g.setImplementation(mod, name, "// hardened");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// hardened",
        attempts: 1,
        testOutput: "",
      };
    };
    const fixDispatch = async (_g: any, mod: string, name: string) => {
      events.push(`fix:${name}`);
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// fixed",
        attempts: 1,
        testOutput: "",
      };
    };
    const integrationRunner = async () => {
      events.push("run");
      return { ok: true, failures: [] };
    };

    const report = await designPlanIntegration(g, "build a guestbook", {
      chat,
      hardenDispatch,
      fixDispatch,
      integrationRunner,
      finalize: okFinalize(),
      useProjectDir: false,
    });

    expect(report.ok).toBe(true);
    expect(report.phase).toBe("done");
    expect(events).toContain("harden:startServer");
    expect(events).toContain("integration-tests-authored");
    expect(events).toContain("integration-test-reviewed");
    expect(events).toContain("run");
    expect(events.filter((e) => e.startsWith("fix:"))).toHaveLength(0);
  });
});

describe("designPlanIntegration — bottom-up gating", () => {
  it("skips hardening a parent when its leaf dep returns NO body (implementation=null)", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);
    // Pre-seed structure: parent depends on child.
    const specWithDeps = (deps: string[] = []) => ({
      purpose: "x",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: deps,
      edgeCases: [],
      examples: [],
    });
    g.addFunction(
      "src/a.ts",
      "child",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.setSpec("src/a.ts", "child", specWithDeps());
    g.addFunction(
      "src/a.ts",
      "parent",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.setSpec("src/a.ts", "parent", specWithDeps(["child"]));

    const hardenCalls: string[] = [];
    const hardenDispatch = async (_g: any, mod: string, name: string) => {
      hardenCalls.push(name);
      return {
        module: mod,
        name,
        status: name === "child" ? ("failed" as const) : ("tests-green" as const),
        // Child returns null body → genuinely unusable → parent must skip.
        implementation: name === "child" ? null : "// h",
        attempts: 1,
        testOutput: "",
      };
    };
    const chat = async (prompt: string) => {
      if (prompt.startsWith("You are reviewing")) {
        return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
      }
      if (prompt.includes("You are authoring PROJECT-LEVEL")) {
        return integrationTestsResp;
      }
      return specResp;
    };
    await designPlanIntegration(g, "task", {
      chat,
      hardenDispatch,
      fixDispatch: hardenDispatch,
      integrationRunner: async () => ({ ok: true, failures: [] }),
      finalize: okFinalize(),
      useProjectDir: false,
    });
    expect(hardenCalls).toContain("child");
    expect(hardenCalls).not.toContain("parent");
  });
});

describe("designPlanIntegration — integration loop fires on red", () => {
  it("dispatches fixDispatch when the first integration run fails and passes afterward", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);
    let runCount = 0;
    let fixed = false;

    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) return fnListResp;
      if (prompt.startsWith("You are reviewing")) {
        return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
      }
      if (prompt.includes("You are authoring PROJECT-LEVEL")) {
        return integrationTestsResp;
      }
      return specResp;
    };
    const okDispatch = async (_g: any, mod: string, name: string) => {
      _g.setImplementation(mod, name, "// ok");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const fixDispatch = async (_g: any, mod: string, name: string) => {
      fixed = true;
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// fixed",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await designPlanIntegration(g, "task", {
      chat,
      hardenDispatch: okDispatch,
      fixDispatch,
      integrationRunner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "fail",
                stackTrace:
                  "at startServer (/tmp/proj/startServer.ts:1:1)",
                message: "boom",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      finalize: okFinalize(),
      useProjectDir: false,
      maxIntegrationIterations: 3,
    });
    expect(report.ok).toBe(true);
    expect(fixed).toBe(true);
    expect(runCount).toBe(2);
  });
});

describe("designPlanIntegration — surfaces integration loop failure", () => {
  it("returns ok=false with phase=integration when the loop exhausts", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);

    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) return fnListResp;
      if (prompt.startsWith("You are reviewing")) {
        return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
      }
      if (prompt.includes("You are authoring PROJECT-LEVEL")) {
        return integrationTestsResp;
      }
      return specResp;
    };
    const okDispatch = async (_g: any, mod: string, name: string) => {
      _g.setImplementation(mod, name, "// ok");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      };
    };
    const report = await designPlanIntegration(g, "task", {
      chat,
      hardenDispatch: okDispatch,
      fixDispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "failed",
        implementation: null,
        attempts: 1,
        testOutput: "",
        error: "stuck",
      }),
      integrationRunner: async () => ({
        ok: false,
        failures: [
          {
            testName: "always red",
            stackTrace: "at startServer (/tmp/proj/startServer.ts:1:1)",
            message: "nope",
          },
        ],
      }),
      finalize: okFinalize(),
      useProjectDir: false,
      maxIntegrationIterations: 2,
    });
    expect(report.ok).toBe(false);
    expect(report.phase).toBe("integration");
  });
});
