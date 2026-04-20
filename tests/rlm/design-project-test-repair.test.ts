import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  repairProjectTests,
  isProjectTestFailure,
} from "../../src/rlm/design-project-test-repair.js";

const sig = () => ({ params: [], returnType: "void" });

function seedGraph() {
  const g = createDesignGraph();
  g.addFunction("src/a.ts", "startServer", sig());
  g.addFunction("src/a.ts", "handleRequest", sig());
  return g;
}

describe("isProjectTestFailure", () => {
  it("flags the synthetic project.runner failure", () => {
    expect(
      isProjectTestFailure({
        testName: "project.runner",
        message: "vitest exited 1",
        stackTrace: "stderr:\nSyntaxError",
      }),
    ).toBe(true);
  });

  it("flags failures whose stack points at the integration test file", () => {
    expect(
      isProjectTestFailure({
        testName: "some real test",
        message: "asserted",
        stackTrace:
          "at /tmp/rlm-int-abc/project.integration.test.ts:15:3",
      }),
    ).toBe(true);
  });

  it("does NOT flag a function-file failure", () => {
    expect(
      isProjectTestFailure({
        testName: "handleRequest > GET /",
        message: "expected 500 to be 200",
        stackTrace:
          "at handleRequest (/tmp/rlm-int-abc/handleRequest.ts:12:5)",
      }),
    ).toBe(false);
  });
});

describe("repairProjectTests", () => {
  it("replaces the test set with what the LLM returns", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "broken", code: "syntax error here ]" });
    const chat = async () =>
      "```json\n" +
      JSON.stringify([{ name: "fixed test", code: "// valid code" }]) +
      "\n```";
    const report = await repairProjectTests(
      g,
      [
        {
          testName: "project.runner",
          message: "vitest exited 1",
          stackTrace: "stderr: SyntaxError: Unexpected token ]",
        },
      ],
      { chat, task: "build an app" },
    );
    expect(report.ok).toBe(true);
    expect(report.finalCount).toBe(1);
    expect(g.listProjectTests()).toHaveLength(1);
    expect(g.listProjectTests()[0].name).toBe("fixed test");
  });

  it("reports failure when LLM emits unparseable JSON within retry budget", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "existing", code: "//" });
    const chat = async () => "garbage output";
    const report = await repairProjectTests(
      g,
      [
        {
          testName: "project.runner",
          message: "x",
          stackTrace: "y",
        },
      ],
      { chat, task: "t", maxRetries: 1 },
    );
    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    // Existing tests preserved — repair didn't clobber.
    expect(g.listProjectTests()).toHaveLength(1);
    expect(g.listProjectTests()[0].name).toBe("existing");
  });

  it("includes current tests + failure stack in the prompt", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "a-broken-test", code: "bad code" });
    let prompt = "";
    const chat = async (p: string) => {
      prompt = p;
      return "```json\n[{\"name\":\"ok\",\"code\":\"//\"}]\n```";
    };
    await repairProjectTests(
      g,
      [
        {
          testName: "project.runner",
          message: "vitest exited 1",
          stackTrace: "stderr: SyntaxError: foo",
        },
      ],
      { chat, task: "build it" },
    );
    expect(prompt).toContain("a-broken-test");
    expect(prompt).toContain("SyntaxError: foo");
    expect(prompt).toContain("startServer"); // function list included
    expect(prompt).toContain("build it"); // task included
  });
});
