import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { designIntegrationTests } from "../../src/rlm/design-integration-tests.js";

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

function seedDiamond() {
  const g = createDesignGraph();
  g.addFunction("src/a.ts", "root", sig());
  g.setSpec("src/a.ts", "root", spec(["left", "right"]));
  g.addFunction("src/a.ts", "left", sig());
  g.setSpec("src/a.ts", "left", spec(["leaf"]));
  g.addFunction("src/a.ts", "right", sig());
  g.setSpec("src/a.ts", "right", spec(["leaf"]));
  g.addFunction("src/a.ts", "leaf", sig());
  g.setSpec("src/a.ts", "leaf", spec());
  return g;
}

describe("designIntegrationTests", () => {
  it("asks for one test per enumerated path AND supplementary LLM-derived tests", async () => {
    const g = seedDiamond();
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      return (
        "```json\n" +
        JSON.stringify([
          { name: "path root>left>leaf", code: "// t1" },
          { name: "path root>right>leaf", code: "// t2" },
          { name: "supplementary: leaf error branch", code: "// t3" },
        ]) +
        "\n```"
      );
    };
    const report = await designIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    // Prompt must enumerate both paths so the LLM grounds coverage.
    expect(prompts[0]).toContain("root>left>leaf");
    expect(prompts[0]).toContain("root>right>leaf");
    // Prompt must invite supplementary tests.
    expect(prompts[0].toLowerCase()).toMatch(/supplementary|additional/);
    // All three tests landed in the graph.
    expect(g.listProjectTests()).toHaveLength(3);
  });

  it("resume: existing project tests skip the LLM call", async () => {
    const g = seedDiamond();
    g.addProjectTest({ name: "pre-existing", code: "//" });
    let called = false;
    const chat = async () => {
      called = true;
      return "";
    };
    const report = await designIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(called).toBe(false);
    expect(g.listProjectTests()).toHaveLength(1);
  });

  it("reports error when LLM emits unparseable JSON within retry budget", async () => {
    const g = seedDiamond();
    const chat = async () => "not json";
    const report = await designIntegrationTests(g, "task", {
      chat,
      maxRetries: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    expect(g.listProjectTests()).toHaveLength(0);
  });

  it("accepts a pre-enumerated path list (caller-provided overrides graph-derived)", async () => {
    const g = seedDiamond();
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      return (
        "```json\n" +
        JSON.stringify([{ name: "custom path", code: "// t" }]) +
        "\n```"
      );
    };
    await designIntegrationTests(g, "task", {
      chat,
      paths: [{ nodes: ["custom", "path"], kind: "complete" }],
    });
    expect(prompts[0]).toContain("custom>path");
    expect(prompts[0]).not.toContain("root>left>leaf");
  });

  it("returns ok=true with empty tests when graph has no functions", async () => {
    // Degenerate case: empty graph. Nothing to author.
    const g = createDesignGraph();
    const chat = async () => "// should not be called";
    const report = await designIntegrationTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(g.listProjectTests()).toHaveLength(0);
  });
});
