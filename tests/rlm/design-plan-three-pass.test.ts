import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designPlanThreePass } from "../../src/rlm/design-plan-three-pass.js";

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

const projectTestsResp = `\`\`\`json\n${JSON.stringify([
  { name: "boots", code: "// integration test" },
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

describe("designPlanThreePass — happy path", () => {
  it("runs sketch → coherence → project tests → harden → finalize", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);

    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) return fnListResp;
      if (prompt.includes("PROJECT-LEVEL integration tests")) return projectTestsResp;
      return specResp; // phase 2 specs
    };

    const dispatchCalls: Array<{ mode: string; name: string; status?: string }> = [];
    const sketchDispatch = async (_g: any, mod: string, name: string) => {
      dispatchCalls.push({ mode: "sketch", name });
      _g.setImplementation(mod, name, "// sketched body");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// sketched body",
        attempts: 1,
        testOutput: "",
      };
    };
    const hardenDispatch = async (_g: any, mod: string, name: string) => {
      // Capture node status at dispatch time so the test can assert
      // the orchestrator reset it off "tests-green" before calling us.
      const node = _g.getFunction(mod, name);
      dispatchCalls.push({ mode: "harden", name, status: node?.status });
      _g.setImplementation(mod, name, "// hardened body");
      _g.setTestStatus(mod, name, "tests-green", "");
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "// hardened body",
        attempts: 1,
        testOutput: "",
      };
    };

    let finalizeCalled = false;
    const finalize = async () => {
      finalizeCalled = true;
      return (await okFinalize()());
    };

    const report = await designPlanThreePass(g, "build a guestbook", {
      chat,
      sketchDispatch,
      hardenDispatch,
      finalize,
      useProjectDir: false,
    });

    expect(report.ok).toBe(true);
    expect(dispatchCalls.map((c) => c.mode)).toEqual(["sketch", "harden"]);
    expect(dispatchCalls.every((c) => c.name === "startServer")).toBe(true);
    // Harden was called with status reset off "tests-green" — otherwise
    // the real dispatcher's pre-test path would short-circuit the LLM.
    const hardenCall = dispatchCalls.find((c) => c.mode === "harden");
    expect(hardenCall?.status).not.toBe("tests-green");
    expect(g.listProjectTests()).toHaveLength(1);
    expect(finalizeCalled).toBe(true);
  });
});

describe("designPlanThreePass — coherence feedback", () => {
  it("passes feedback describing the violation when re-dispatching", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);
    const validSpec = () => ({
      purpose: "x",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" }, "", "plan");
    g.setSpec("src/a.ts", "parent", validSpec());
    g.setImplementation("src/a.ts", "parent", "return;");
    g.setTestStatus("src/a.ts", "parent", "tests-green", "");
    g.addFunctionChild("parent", "src/a.ts", "child", { params: [], returnType: "void" }, "", "plan");
    g.setSpec("src/a.ts", "child", validSpec());
    g.setImplementation("src/a.ts", "child", "return;");
    g.setTestStatus("src/a.ts", "child", "tests-green", "");

    const chat = async (prompt: string) => {
      if (prompt.includes("PROJECT-LEVEL integration tests")) return projectTestsResp;
      return specResp;
    };

    const feedbackSeen: Array<string | undefined> = [];
    const sketchDispatch = async (
      _g: any,
      mod: string,
      name: string,
      opts?: { feedback?: string },
    ) => {
      feedbackSeen.push(opts?.feedback);
      if (name === "parent") {
        _g.setImplementation(mod, name, "ctx.fns.child(ctx);");
        _g.setTestStatus(mod, name, "tests-green", "");
      }
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "ctx.fns.child(ctx);",
        attempts: 1,
        testOutput: "",
      };
    };
    const hardenDispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "tests-green" as const,
      implementation: "// h",
      attempts: 1,
      testOutput: "",
    });

    await designPlanThreePass(g, "task", {
      chat,
      sketchDispatch,
      hardenDispatch,
      finalize: okFinalize(),
      useProjectDir: false,
      maxCoherenceCycles: 2,
    });

    // At least one re-dispatch carried feedback text referencing the orphan.
    const withFeedback = feedbackSeen.filter(
      (f) => typeof f === "string" && f.length > 0,
    );
    expect(withFeedback.length).toBeGreaterThan(0);
    expect(withFeedback[0]).toMatch(/orphan|child|not called/i);
  });
});

describe("designPlanThreePass — coherence fix cycle", () => {
  it("re-dispatches affected functions in sketch mode when coherence flags violations", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);
    // Pre-seed a sketched graph where coherence will flag an orphan:
    // parent declares child in the tree but body never calls it.
    const validSpec = () => ({
      purpose: "x",
      inputs: [],
      output: { type: "void", description: "" },
      sideEffects: [],
      dependencies: [],
      edgeCases: [],
      examples: [],
    });
    g.addFunction(
      "src/a.ts",
      "parent",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.setSpec("src/a.ts", "parent", validSpec());
    g.setImplementation("src/a.ts", "parent", "return;");
    g.setTestStatus("src/a.ts", "parent", "tests-green", "");
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "child",
      { params: [], returnType: "void" },
      "",
      "plan",
    );
    g.setSpec("src/a.ts", "child", validSpec());
    g.setImplementation("src/a.ts", "child", "return;");
    g.setTestStatus("src/a.ts", "child", "tests-green", "");

    const chat = async (prompt: string) => {
      if (prompt.includes("PROJECT-LEVEL integration tests")) return projectTestsResp;
      return specResp;
    };

    const sketchCalls: string[] = [];
    const sketchDispatch = async (_g: any, mod: string, name: string) => {
      sketchCalls.push(name);
      // On coherence re-dispatch, wire parent → child so next cycle passes.
      if (name === "parent") {
        _g.setImplementation(mod, name, "ctx.fns.child(ctx);");
        _g.setTestStatus(mod, name, "tests-green", "");
      }
      return {
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "ctx.fns.child(ctx);",
        attempts: 1,
        testOutput: "",
      };
    };
    const hardenDispatch = async (_g: any, mod: string, name: string) => ({
      module: mod,
      name,
      status: "tests-green" as const,
      implementation: "// harden",
      attempts: 1,
      testOutput: "",
    });

    const report = await designPlanThreePass(g, "task", {
      chat,
      sketchDispatch,
      hardenDispatch,
      finalize: okFinalize(),
      maxCoherenceCycles: 3,
      useProjectDir: false,
    });

    expect(report.ok).toBe(true);
    // Coherence fix re-dispatched the orphan-producing parent.
    expect(sketchCalls).toContain("parent");
  });
});

describe("designPlanThreePass — project tests failure surfaces", () => {
  it("returns ok=false when project test generation exhausts retries", async () => {
    const g = createDesignGraph();
    seedVitestConfig(g);

    const chat = async (prompt: string) => {
      if (prompt.includes("list the top-level functions")) return fnListResp;
      if (prompt.includes("PROJECT-LEVEL integration tests")) return "garbage";
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

    const report = await designPlanThreePass(g, "task", {
      chat,
      sketchDispatch: okDispatch,
      hardenDispatch: okDispatch,
      finalize: okFinalize(),
      maxShapeRetries: 0,
      useProjectDir: false,
    });

    expect(report.ok).toBe(false);
    expect(report.phase).toBe("project-tests");
  });
});
