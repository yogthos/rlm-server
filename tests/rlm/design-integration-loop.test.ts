import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  runIntegrationLoop,
  type IntegrationRunResult,
} from "../../src/rlm/design-integration-loop.js";

const sig = () => ({ params: [], returnType: "void" });
function spec(deps: string[] = []) {
  return {
    purpose: "x",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: deps,
    edgeCases: [],
    examples: [],
  };
}

function seed() {
  const g = createDesignGraph();
  g.addFunction("src/a.ts", "startServer", sig());
  g.setSpec("src/a.ts", "startServer", spec(["handleRequest"]));
  g.addFunction("src/a.ts", "handleRequest", sig());
  g.setSpec("src/a.ts", "handleRequest", spec());
  return g;
}

const ok = (): IntegrationRunResult => ({ ok: true, failures: [] });

describe("runIntegrationLoop", () => {
  it("returns ok=true on first green run, no dispatches", async () => {
    const g = seed();
    let dispatches = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => ok(),
      dispatch: async () => {
        dispatches++;
        return {
          module: "src/a.ts",
          name: "handleRequest",
          status: "tests-green",
          implementation: "// x",
          attempts: 0,
          testOutput: "",
        };
      },
      chat: async () => "unused",
    });
    expect(report.ok).toBe(true);
    expect(dispatches).toBe(0);
    expect(report.iterations).toBe(1);
  });

  it("dispatches the function named in the stack trace then converges", async () => {
    const g = seed();
    let runCount = 0;
    const dispatched: string[] = [];
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "GET / returns 200",
                stackTrace:
                  "at handleRequest (/tmp/proj/handleRequest.ts:5:1)",
                message: "expected 500 to be 200",
              },
            ],
          };
        }
        return ok();
      },
      dispatch: async (_g, mod, name, opts) => {
        dispatched.push(name);
        // Feedback should carry the test failure text so the
        // implementer knows what to fix.
        expect(opts?.feedback).toBeTruthy();
        expect(opts?.feedback).toContain("GET / returns 200");
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "// fixed",
          attempts: 1,
          testOutput: "",
        };
      },
      chat: async () => "unused",
    });
    expect(report.ok).toBe(true);
    expect(dispatched).toEqual(["handleRequest"]);
    expect(report.iterations).toBe(2);
  });

  it("bounds by maxIterations when failures never resolve", async () => {
    const g = seed();
    let dispatches = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => ({
        ok: false,
        failures: [
          {
            testName: "t",
            stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
            message: "nope",
          },
        ],
      }),
      dispatch: async (_g, mod, name) => {
        dispatches++;
        return {
          module: mod,
          name,
          status: "failed",
          implementation: null,
          attempts: 1,
          testOutput: "",
          error: "stuck",
        };
      },
      chat: async () => "unused",
      maxIterations: 3,
    });
    expect(report.ok).toBe(false);
    expect(report.iterations).toBe(3);
    expect(dispatches).toBe(3);
    expect(report.error).toMatch(/iterations/i);
  });

  it("skips failures whose attribution is unknown (no function named)", async () => {
    const g = seed();
    let dispatches = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => ({
        ok: false,
        failures: [
          {
            testName: "t",
            stackTrace: "at totally_unknown (???:0:0)",
            message: "boom",
          },
        ],
      }),
      dispatch: async () => {
        dispatches++;
        return {
          module: "src/a.ts",
          name: "?",
          status: "tests-green",
          implementation: "",
          attempts: 0,
          testOutput: "",
        };
      },
      chat: async () => "garbage", // fallback can't decide
      maxIterations: 2,
    });
    // No function to dispatch → no calls → exhaustion with nothing fixed.
    expect(dispatches).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("augments tests on a recurring failure (2nd consecutive cycle) via LLM", async () => {
    const g = seed();
    let runCount = 0;
    let augmentPrompted = false;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount < 3) {
          return {
            ok: false,
            failures: [
              {
                testName: "same failing test",
                stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
                message: "still broken",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "tests-green",
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      }),
      chat: async (prompt: string) => {
        if (prompt.includes("additional integration test")) {
          augmentPrompted = true;
          return (
            '```json\n{"name":"recurrence witness","code":"// new assertion"}\n```'
          );
        }
        return "unused";
      },
      maxIterations: 5,
    });
    expect(augmentPrompted).toBe(true);
    // New test was added to the graph.
    const tests = g.listProjectTests();
    expect(tests.some((t) => t.name === "recurrence witness")).toBe(true);
    // Still converges once the runner goes green.
    expect(report.ok).toBe(true);
  });

  it("does NOT augment when augmentOnRecurrence: false", async () => {
    const g = seed();
    let runCount = 0;
    let augmentPrompted = false;
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount < 3) {
          return {
            ok: false,
            failures: [
              {
                testName: "recurring",
                stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
                message: "x",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "tests-green",
        implementation: "// ok",
        attempts: 1,
        testOutput: "",
      }),
      chat: async (prompt: string) => {
        if (prompt.includes("additional integration test")) {
          augmentPrompted = true;
        }
        return "unused";
      },
      maxIterations: 5,
      augmentOnRecurrence: false,
    });
    expect(augmentPrompted).toBe(false);
    expect(g.listProjectTests()).toHaveLength(0);
  });

  it("caches attribution per stack trace within an iteration (avoids redundant LLM calls)", async () => {
    const g = seed();
    let fallbackCalls = 0;
    let runCount = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          // Three failures, all with the SAME unattributable stack.
          // Attribution should be cached, so fallback LLM fires once.
          const trace = "at unknown (???:0:0)";
          return {
            ok: false,
            failures: [
              { testName: "t1", stackTrace: trace, message: "a" },
              { testName: "t2", stackTrace: trace, message: "b" },
              { testName: "t3", stackTrace: trace, message: "c" },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "tests-green",
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      chat: async () => {
        fallbackCalls++;
        return "garbage";
      },
      maxIterations: 2,
      augmentOnRecurrence: false,
    });
    // Only ONE fallback LLM call fired for the three identical traces.
    expect(fallbackCalls).toBe(1);
    // Loop bails after no attribution; ok=false expected.
    expect(report.ok).toBe(false);
  });

  it("swallows dispatch throws without killing the loop", async () => {
    const g = seed();
    let runCount = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "t",
                stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
                message: "boom",
              },
            ],
          };
        }
        // After the thrown dispatch, the loop should still call runner again.
        return { ok: true, failures: [] };
      },
      dispatch: async () => {
        throw new Error("dispatch blew up");
      },
      chat: async () => "unused",
      maxIterations: 3,
      augmentOnRecurrence: false,
    });
    // Loop continued past the throw and saw the green runner result.
    expect(report.ok).toBe(true);
    expect(runCount).toBe(2);
  });

  it("handles multiple failures in one iteration — one dispatch per unique function", async () => {
    const g = seed();
    let runCount = 0;
    const dispatched: string[] = [];
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "t1",
                stackTrace:
                  "at startServer (/tmp/proj/startServer.ts:3:1)",
                message: "a",
              },
              {
                testName: "t2",
                stackTrace:
                  "at handleRequest (/tmp/proj/handleRequest.ts:4:1)",
                message: "b",
              },
              {
                testName: "t3",
                // same function as t2 — should collapse to one dispatch
                stackTrace:
                  "at handleRequest (/tmp/proj/handleRequest.ts:7:2)",
                message: "c",
              },
            ],
          };
        }
        return ok();
      },
      dispatch: async (_g, mod, name) => {
        dispatched.push(name);
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "// ok",
          attempts: 1,
          testOutput: "",
        };
      },
      chat: async () => "unused",
      maxIterations: 3,
    });
    // Two unique functions; each gets exactly one dispatch per iteration.
    expect(dispatched.sort()).toEqual(["handleRequest", "startServer"]);
  });
});
