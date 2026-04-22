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

  it("bails early when the same failure repeats after a fix attempt (no-progress guard)", async () => {
    // The no-progress guard bails at iter 2 when the failure set is
    // identical to iter 1 AND iter 1 attempted a fix. This is tighter
    // than just maxIterations — we stop burning cycles on a stuck
    // fix-dispatch.
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
      maxIterations: 5,
    });
    expect(report.ok).toBe(false);
    // Iter 1 dispatches; iter 2 sees identical failures after fix → bail.
    expect(report.iterations).toBe(2);
    expect(dispatches).toBe(1);
    expect(report.error).toMatch(/no-progress|environmental/i);
  });

  it("maxIterations still bounds runs when failures CHANGE each iter", async () => {
    // When the failure set shifts each iteration, no-progress guard
    // doesn't fire — maxIterations is the final safety net.
    const g = seed();
    let runCount = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        // Unique failure each run so signature never matches.
        return {
          ok: false,
          failures: [
            {
              testName: `t-${runCount}`,
              stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
              message: `variation ${runCount}`,
            },
          ],
        };
      },
      dispatch: async (_g, mod, name) => ({
        module: mod,
        name,
        status: "failed" as const,
        implementation: null,
        attempts: 1,
        testOutput: "",
        error: "stuck",
      }),
      chat: async () => "unused",
      maxIterations: 3,
      augmentOnRecurrence: false,
    });
    expect(report.ok).toBe(false);
    expect(report.iterations).toBe(3);
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

  // Phase H3 — when the attribution fallback chat aborts (top-level
  // timeout / user cancel), we must bail IMMEDIATELY. The previous
  // behavior swallowed each abort and kept looping, burning one LLM
  // call per failure. For a run with 10 failures all needing fallback,
  // that was 10 aborted calls. With the fix, the first abort surfaces
  // and the loop exits cleanly.
  it("bails on first fallback-chat abort instead of calling N more times (H3)", async () => {
    const g = seed();
    let chatCalls = 0;
    // Produce 5 failures with NO project-frame in the stack — every
    // one will fall through to the LLM fallback path.
    const failures = Array.from({ length: 5 }, (_, i) => ({
      testName: `t${i}`,
      stackTrace: "at /tmp/proj/scaffold.ts:1:1",
      message: "boom",
    }));
    const report = await runIntegrationLoop(g, {
      runner: async () => ({ ok: false, failures }),
      dispatch: async () => {
        throw new Error("dispatch should never run — attribution must bail");
      },
      chat: async () => {
        chatCalls++;
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      },
      maxIterations: 1,
    });
    expect(report.ok).toBe(false);
    // Exactly ONE attribution chat call — loop must bail before
    // attempting the remaining four.
    expect(chatCalls).toBe(1);
    // Error surface should make the abort root cause obvious.
    expect(report.error ?? "").toMatch(/aborted|abort/i);
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

  it("augment prompt includes the attributed function's body + existing tests", async () => {
    // After run 10 gap: augmentation was authoring witness tests
    // without knowing which function they should witness or what the
    // existing tests already cover. Now the prompt shows the target
    // function (via direct attribution) and its tests.
    const g = seed();
    // Give handleRequest a body and unit test so they can appear in
    // the augment prompt.
    g.setImplementation("src/a.ts", "handleRequest", "return 1;");
    g.replaceTests("src/a.ts", "handleRequest", [
      { name: "returns one", code: "expect(handleRequest(ctx)).toBe(1);" },
    ]);
    let runCount = 0;
    let augmentPrompt = "";
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount < 3) {
          return {
            ok: false,
            failures: [
              {
                testName: "x",
                stackTrace: "at handleRequest (/tmp/proj/handleRequest.ts:1:1)",
                message: "y",
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
      chat: async (p: string) => {
        if (p.includes("additional integration test")) {
          augmentPrompt = p;
          return '```json\n{"name":"w","code":"// x"}\n```';
        }
        return "unused";
      },
      maxIterations: 5,
    });
    expect(augmentPrompt).toContain("handleRequest");
    expect(augmentPrompt).toContain("return 1;"); // body surfaced
    expect(augmentPrompt).toContain("returns one"); // existing test name
    // Phase N7 — architect now owns the full project.integration.test.ts
    // file; the prompt advertises the project-test-file fence.
    expect(augmentPrompt).toContain("project-test-file");
  });

  it("augment SKIPS synthetic project.runner failures — no witness for env crash", async () => {
    const g = seed();
    let runCount = 0;
    let augmentPromptCount = 0;
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        return {
          ok: false,
          failures: [
            {
              testName: "project.runner",
              message: "vitest exited 1",
              stackTrace: "",
            },
          ],
        };
      },
      dispatch: async (_g: any, mod: string, name: string) => ({
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      fixProjectTests: async () => {},
      chat: async (p: string) => {
        if (p.includes("additional integration test")) {
          augmentPromptCount++;
        }
        return '```json\n{"name":"w","code":"// nope"}\n```';
      },
      maxIterations: 3,
    });
    expect(augmentPromptCount).toBe(0); // never prompted for synthetic
  });

  it("augment SKIPS when the stack is unattributable — no function to witness", async () => {
    const g = seed();
    let runCount = 0;
    let augmentPromptCount = 0;
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount < 3) {
          return {
            ok: false,
            failures: [
              {
                testName: "orphan",
                message: "somewhere deep",
                stackTrace: "at unknownFn (node_modules/thing/index.js:1:1)", // no in-project frame
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async (_g: any, mod: string, name: string) => ({
        module: mod,
        name,
        status: "tests-green" as const,
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      chat: async (p: string) => {
        if (p.includes("additional integration test")) augmentPromptCount++;
        return '```json\n{"name":"w","code":"// x"}\n```';
      },
      maxIterations: 5,
    });
    expect(augmentPromptCount).toBe(0);
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

  it("project.runner failure routes to fixProjectTests, not fixDispatch", async () => {
    const g = seed();
    let runCount = 0;
    let fixFunctionCalled = false;
    let projectTestsFixedWith: string[] | null = null;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "project.runner",
                message: "vitest exited 1",
                stackTrace: "stderr: SyntaxError: Unexpected token",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async () => {
        fixFunctionCalled = true;
        return {
          module: "src/a.ts",
          name: "x",
          status: "tests-green",
          implementation: "",
          attempts: 0,
          testOutput: "",
        };
      },
      fixProjectTests: async (_g, failures) => {
        projectTestsFixedWith = failures.map((f) => f.testName);
      },
      chat: async () => "unused",
      maxIterations: 3,
      augmentOnRecurrence: false,
    });
    expect(report.ok).toBe(true);
    // Function dispatch NOT called — this was a project-test failure.
    expect(fixFunctionCalled).toBe(false);
    // fixProjectTests got the failure.
    expect(projectTestsFixedWith).toEqual(["project.runner"]);
    expect(report.dispatched).toContain("__project-tests__");
  });

  it("mixed failures: function target AND project.runner both get routed correctly", async () => {
    const g = seed();
    const fnDispatched: string[] = [];
    let projectTestsCalls = 0;
    let runCount = 0;
    await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        if (runCount === 1) {
          return {
            ok: false,
            failures: [
              {
                testName: "project.runner",
                message: "crashed",
                stackTrace: "stderr: ...",
              },
              {
                testName: "real test",
                message: "asserted wrong",
                stackTrace:
                  "at handleRequest (/tmp/proj/handleRequest.ts:5:1)",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async (_g, mod, name) => {
        fnDispatched.push(name);
        return {
          module: mod,
          name,
          status: "tests-green",
          implementation: "",
          attempts: 0,
          testOutput: "",
        };
      },
      fixProjectTests: async () => {
        projectTestsCalls++;
      },
      chat: async () => "unused",
      maxIterations: 3,
      augmentOnRecurrence: false,
    });
    expect(projectTestsCalls).toBe(1);
    expect(fnDispatched).toContain("handleRequest");
  });

  it("project.runner failure without fixProjectTests callback skips — doesn't misdispatch to a function", async () => {
    const g = seed();
    let fixFunctionCalled = false;
    await runIntegrationLoop(g, {
      runner: async () => ({
        ok: false,
        failures: [
          {
            testName: "project.runner",
            message: "x",
            stackTrace: "y",
          },
        ],
      }),
      dispatch: async () => {
        fixFunctionCalled = true;
        return {
          module: "x",
          name: "x",
          status: "tests-green",
          implementation: "",
          attempts: 0,
          testOutput: "",
        };
      },
      chat: async () => "unused",
      maxIterations: 2,
      augmentOnRecurrence: false,
    });
    // Previously the loop would attribute project.runner somewhere and
    // dispatch a function fix uselessly. Now it skips cleanly.
    expect(fixFunctionCalled).toBe(false);
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

  it("early-aborts when two consecutive iterations produce identical synthetic-only failures", async () => {
    // Run 10 behavior: tsc/vitest environmental crash repeats every
    // iteration unchanged — no user-function attribution, repair can't
    // help. Loop should bail at iter 2 rather than exhaust all 5.
    const g = seed();
    let runCount = 0;
    const phantomFailure = {
      testName: "project.typecheck",
      message: "tsc exited 2 with no parseable errors",
      stackTrace: "stderr (last 2000 chars):\nstdout (last 800 chars):",
    };
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        return { ok: false, failures: [phantomFailure] };
      },
      dispatch: async () => ({
        module: "src/a.ts",
        name: "x",
        status: "tests-green",
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      fixProjectTests: async () => {
        // repair "succeeds" but the phantom doesn't go away.
      },
      chat: async () => "unused",
      maxIterations: 5,
      augmentOnRecurrence: false,
    });
    expect(report.ok).toBe(false);
    // Two runs: iter 1 tries repair; iter 2 sees same set → bails.
    expect(report.iterations).toBe(2);
    expect(runCount).toBe(2);
    expect(report.error).toMatch(/environmental/i);
  });

  it("early-aborts on synthetic crashes whose messages vary only by PID / volatile noise", async () => {
    // Bug from review: synthetic `project.runner` crash messages
    // embed the Node PID (`(node:91857) [DEP0169]...`), which differs
    // each run. Using raw message in the signature would cause every
    // iter to look "different" and guard would never fire. Fix: for
    // synthetics, sign on testName only.
    const g = seed();
    let runCount = 0;
    const report = await runIntegrationLoop(g, {
      runner: async () => {
        runCount++;
        return {
          ok: false,
          failures: [
            {
              testName: "project.runner",
              message: `vitest exited 1. First stderr: (node:9${runCount}000) [DEP0169] DeprecationWarning`,
              stackTrace: "",
            },
          ],
        };
      },
      dispatch: async () => ({
        module: "src/a.ts",
        name: "x",
        status: "tests-green",
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      fixProjectTests: async () => {},
      chat: async () => "unused",
      maxIterations: 5,
      augmentOnRecurrence: false,
    });
    // Must bail at iter 2 despite PID variance in the message.
    expect(report.ok).toBe(false);
    expect(report.iterations).toBe(2);
    expect(report.error).toMatch(/environmental/i);
  });

  it("does NOT early-abort when synthetic failure set CHANGES between iterations", async () => {
    // Guard against over-eager abort: if the synthetic testName set
    // shifts (different crash signature, or augmentation added a new
    // synthetic), repair may still be making progress — keep iterating.
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
                testName: "project.typecheck",
                message: "tsc exited 2",
                stackTrace: "",
              },
            ],
          };
        }
        if (runCount === 2) {
          // Different synthetic — vitest crash instead of tsc.
          return {
            ok: false,
            failures: [
              {
                testName: "project.runner",
                message: "vitest exited 1",
                stackTrace: "",
              },
            ],
          };
        }
        return { ok: true, failures: [] };
      },
      dispatch: async () => ({
        module: "src/a.ts",
        name: "x",
        status: "tests-green",
        implementation: "",
        attempts: 0,
        testOutput: "",
      }),
      fixProjectTests: async () => {},
      chat: async () => "unused",
      maxIterations: 5,
      augmentOnRecurrence: false,
    });
    expect(report.ok).toBe(true);
    expect(runCount).toBe(3);
  });
});
