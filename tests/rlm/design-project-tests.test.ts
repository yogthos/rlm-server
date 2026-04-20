import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  designProjectTests,
  parseProjectTestList,
} from "../../src/rlm/design-project-tests.js";

describe("parseProjectTestList", () => {
  it("accepts a JSON array of {name, code} entries", () => {
    const raw = [
      { name: "POST /sign adds an entry", code: "const res = await fetch(...);" },
      { name: "GET / returns HTML", code: "const res = await fetch('/');" },
    ];
    const tests = parseProjectTestList(raw);
    expect(tests).toHaveLength(2);
    expect(tests[0].name).toBe("POST /sign adds an entry");
  });

  it("rejects non-array input", () => {
    expect(() => parseProjectTestList({ foo: 1 })).toThrow();
  });

  it("rejects entries missing a field", () => {
    expect(() =>
      parseProjectTestList([{ name: "x" }]),
    ).toThrow();
  });
});

describe("designProjectTests", () => {
  it("asks the LLM for tests, parses, stores via graph.addProjectTest", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/server.js",
      "startServer",
      { params: [], returnType: "void" },
    );
    const prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      return (
        "```json\n" +
        JSON.stringify([
          {
            name: "POST /sign then GET /api/entries returns the entry",
            code: "// end-to-end test code here",
          },
        ]) +
        "\n```"
      );
    };
    const report = await designProjectTests(g, "build a guestbook", {
      chat,
    });
    expect(report.ok).toBe(true);
    expect(g.listProjectTests()).toHaveLength(1);
    expect(g.listProjectTests()[0].name).toContain("POST /sign");
    // Prompt must include the task + at least one function name so
    // the LLM knows what's available.
    expect(prompts[0]).toContain("build a guestbook");
    expect(prompts[0]).toContain("startServer");
  });

  it("resumes: if projectTests already exist, skip the LLM call", async () => {
    const g = createDesignGraph();
    g.addProjectTest({ name: "existing", code: "// existing" });
    let chatCalled = false;
    const chat = async () => {
      chatCalled = true;
      return "";
    };
    const report = await designProjectTests(g, "task", { chat });
    expect(report.ok).toBe(true);
    expect(chatCalled).toBe(false);
    expect(g.listProjectTests()).toHaveLength(1); // unchanged
  });

  it("treats an empty JSON array as a schema error and retries", async () => {
    const g = createDesignGraph();
    g.addFunction("src/server.js", "startServer", { params: [], returnType: "void" });
    let calls = 0;
    const chat = async () => {
      calls++;
      if (calls === 1) return "```json\n[]\n```";
      return (
        "```json\n" +
        JSON.stringify([{ name: "t", code: "//" }]) +
        "\n```"
      );
    };
    const report = await designProjectTests(g, "task", { chat, maxRetries: 2 });
    expect(report.ok).toBe(true);
    expect(calls).toBe(2);
    expect(g.listProjectTests()).toHaveLength(1);
  });

  it("reports error if the LLM only returns empty arrays (within retry budget)", async () => {
    const g = createDesignGraph();
    const chat = async () => "```json\n[]\n```";
    const report = await designProjectTests(g, "task", { chat, maxRetries: 1 });
    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    expect(g.listProjectTests()).toHaveLength(0);
  });

  it("reports error if the LLM never returns parseable JSON (within retry budget)", async () => {
    const g = createDesignGraph();
    const chat = async () => "garbage not JSON at all";
    const report = await designProjectTests(g, "task", {
      chat,
      maxRetries: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    expect(g.listProjectTests()).toHaveLength(0);
  });
});
