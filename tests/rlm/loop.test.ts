import { describe, it, expect } from "vitest";
import { runRLMLoop } from "../../src/rlm/loop.js";
import type { LLMClient, ChatMessage, LLMResponse } from "../../src/rlm/types.js";

/** Create a mock LLM client that returns preconfigured responses in sequence. */
function createMockLLM(responses: string[]): LLMClient {
  let callIndex = 0;

  return {
    async chat(_messages: ChatMessage[]): Promise<LLMResponse> {
      const content = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return { content, finishReason: "stop" };
    },
    async listModels(): Promise<string[]> {
      return ["mock-model"];
    },
  };
}

describe("runRLMLoop", () => {
  it("handles immediate FINAL answer (no code)", async () => {
    const llm = createMockLLM(["The answer is simple.\n\nFINAL(42)"]);

    const result = await runRLMLoop({
      prompt: "What is the answer?",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.answer).toBe("42");
  });

  it("executes code and then returns FINAL", async () => {
    const llm = createMockLLM([
      // Turn 1: write code
      "Let me check the context.\n\n```repl\nconst len = context.length;\nconsole.log('Length:', len);\n```",
      // Turn 2: return final answer
      "The context has some characters.\n\nFINAL(The context is a short test string.)",
    ]);

    const result = await runRLMLoop({
      prompt: "Hello world",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.answer).toBe("The context is a short test string.");
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it("handles grep search and returns results", async () => {
    const llm = createMockLLM([
      // Turn 1: grep
      '```repl\nconst results = grep("ERROR");\nconsole.log(results.length + " matches");\n```',
      // Turn 2: final
      "Found error lines.\n\nFINAL(Found error matches in the logs.)",
    ]);

    const result = await runRLMLoop({
      prompt: "INFO: all good\nERROR: something failed\nINFO: recovered\nERROR: again",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.answer).toContain("error");
  });

  it("handles code execution errors gracefully", async () => {
    const llm = createMockLLM([
      // Turn 1: broken code
      "```repl\nundefinedFunction();\n```",
      // Turn 2: final after seeing error
      "There was an error. Let me answer directly.\n\nFINAL(Could not execute the analysis.)",
    ]);

    const result = await runRLMLoop({
      prompt: "test content",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.answer).toContain("Could not execute");
  });

  it("forces final answer at max iterations", async () => {
    const llm = createMockLLM([
      // Keep writing code without FINAL
      '```repl\nconsole.log("working...");\n```',
      '```repl\nconsole.log("still working...");\n```',
      '```repl\nconsole.log("more work...");\n```',
      // After forced prompt
      "FINAL(Ran out of iterations but here is my best answer.)",
    ]);

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 3,
    });

    expect(result.answer).toBeDefined();
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it("tracks execution trace", async () => {
    const llm = createMockLLM([
      '```repl\nconst x = 1 + 1;\nconsole.log(x);\n```',
      "FINAL(done)",
    ]);

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.trace[0].code).toContain("const x = 1 + 1");
  });

  it("persists variables across iterations", async () => {
    const llm = createMockLLM([
      // Turn 1: define variable
      '```repl\nvar greeting = "hello";\n```',
      // Turn 2: use it
      '```repl\nvar message = greeting + " world";\nconsole.log(message);\n```',
      // Turn 3: final
      "FINAL(Variables persisted correctly.)",
    ]);

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(result.answer).toContain("persisted");
    // The trace should show no errors
    for (const entry of result.trace) {
      expect(entry.error).toBeUndefined();
    }
  });
});
