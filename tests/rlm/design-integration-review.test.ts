import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { reviewIntegrationTests } from "../../src/rlm/design-integration-review.js";

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

function seedGraph() {
  const g = createDesignGraph();
  g.addFunction("src/a.ts", "root", sig());
  g.setSpec("src/a.ts", "root", spec(["leaf"]));
  g.addFunction("src/a.ts", "leaf", sig());
  g.setSpec("src/a.ts", "leaf", spec());
  return g;
}

describe("reviewIntegrationTests", () => {
  it("passes through tests when architect APPROVEs", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "t1", code: "// code1" });
    g.addProjectTest({ name: "t2", code: "// code2" });
    const chat = async () =>
      '```json\n{"verdict":"APPROVE","feedback":""}\n```';
    const report = await reviewIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(report.revised).toBe(0);
    expect(g.listProjectTests()).toHaveLength(2);
    expect(g.listProjectTests()[0].code).toBe("// code1");
  });

  it("rewrites tests on REVISE with the architect's feedback", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "weak test", code: "// doesnt actually test" });
    let call = 0;
    const chat = async (prompt: string) => {
      call++;
      if (call === 1) {
        // Review cycle 1 — architect asks for revision.
        return '```json\n{"verdict":"REVISE","feedback":"test never invokes the endpoint"}\n```';
      }
      if (call === 2) {
        // Rewrite — prompt must carry the feedback through.
        expect(prompt).toContain("test never invokes the endpoint");
        return (
          "```json\n" +
          JSON.stringify({
            name: "weak test (revised)",
            code: "// NOW calls fetch(/)",
          }) +
          "\n```"
        );
      }
      // Review cycle 2 — architect APPROVEs the rewrite.
      return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
    };
    const report = await reviewIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(report.revised).toBe(1);
    const stored = g.listProjectTests();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("weak test (revised)");
    expect(stored[0].code).toContain("fetch(/)");
  });

  it("bounds by maxReviewCycles — architect stuck on REVISE returns ok=false", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "t", code: "// x" });
    const chat = async () =>
      // Architect always REVISEs, re-author call parses as a rewrite that
      // the next review will also reject. Loop must terminate.
      '```json\n{"verdict":"REVISE","feedback":"not good enough"}\n```';
    const report = await reviewIntegrationTests(g, "task", {
      chat,
      maxReviewCycles: 2,
    });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/exhausted|cycle/i);
  });

  it("treats an unparseable verdict as REVISE (retry)", async () => {
    const g = seedGraph();
    g.addProjectTest({ name: "t", code: "// x" });
    let reviewCall = 0;
    const chat = async () => {
      reviewCall++;
      // First review response: garbage. Second: APPROVE.
      if (reviewCall === 1) return "not a json verdict";
      return '```json\n{"verdict":"APPROVE","feedback":""}\n```';
    };
    const report = await reviewIntegrationTests(g, "task", {
      chat,
      maxReviewCycles: 3,
    });
    expect(report.ok).toBe(true);
    // Test body untouched — no re-author call fired on garbage.
    expect(g.listProjectTests()[0].code).toBe("// x");
  });

  it("no-op when there are no project tests", async () => {
    const g = seedGraph();
    const chat = async () => "// never called";
    const report = await reviewIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(report.reviewed).toBe(0);
  });
});
