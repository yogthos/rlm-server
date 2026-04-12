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

  it("spawns a sub-RLM when llm_query is called", async () => {
    // We track every call to chat() — if recursion is real, a single
    // outer iteration that calls llm_query() should trigger an extra
    // chat() from the sub-RLM's own generate state.
    const calls: string[] = [];
    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...messages]
          .reverse()
          .find((m) => m.role === "user");
        const content = lastUser?.content ?? "";
        calls.push(content.slice(0, 60));

        // The sub-RLM's first turn sees a prompt starting with
        // "Context loaded:" (from promptMetadata). Respond with FINAL.
        if (content.startsWith("Context loaded:") && calls.length === 2) {
          return {
            content: "FINAL(sub-answer-from-nested-rlm)",
            finishReason: "stop",
          };
        }

        // Outer first turn: produce code that calls llm_query
        if (calls.length === 1) {
          return {
            content:
              "```repl\n" +
              'const subAnswer = await llm_query("sub-question");\n' +
              "console.log(subAnswer);\n" +
              "```",
            finishReason: "stop",
          };
        }

        // Outer second turn: return FINAL incorporating the sub-answer.
        // We reference $llm_query_sub to prove the handle system saw it.
        return {
          content: "FINAL(got: sub-answer-from-nested-rlm)",
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
      maxSubRLMDepth: 2,
    });

    expect(result.answer).toContain("sub-answer-from-nested-rlm");
    // 3 calls total: outer-1 (generate code), inner-1 (FINAL sub),
    // outer-2 (FINAL incorporating sub).
    expect(calls.length).toBe(3);
  });

  it("falls back to single-shot LLM at max sub-RLM depth", async () => {
    const calls: string[] = [];
    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...messages]
          .reverse()
          .find((m) => m.role === "user");
        calls.push(lastUser?.content ?? "");

        // At depth 0 (max), the sub-call should NOT spawn a new loop.
        // It should do a single-shot chat with the concise system prompt.
        if (calls.length === 1) {
          return {
            content:
              "```repl\n" +
              'const answer = await llm_query("what is 2+2?");\n' +
              "console.log(answer);\n" +
              "```",
            finishReason: "stop",
          };
        }
        if (calls.length === 2) {
          // Sub-call — should be single-shot, NOT an RLM init message
          return { content: "4", finishReason: "stop" };
        }
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
      maxSubRLMDepth: 0, // no recursion allowed
    });

    expect(result.answer).toBe("done");
    // With depth=0, llm_query should be single-shot, not spawn init loop
    expect(calls.length).toBe(3);
    // Verify the sub-call was NOT prefixed with "Context loaded:" metadata
    expect(calls[1]).toBe("what is 2+2?");
  });

  it("keeps history bounded across many iterations", async () => {
    // Simulate a model that writes code for 8 iterations then gives FINAL
    let iterCount = 0;
    let lastHistoryLen = 0;
    const maxObservedHistoryLen: number[] = [];

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        maxObservedHistoryLen.push(messages.length);
        lastHistoryLen = messages.length;
        if (iterCount < 8) {
          return {
            content: `\`\`\`repl\nconst x${iterCount} = ${iterCount};\nconsole.log('iter${iterCount}');\n\`\`\``,
            finishReason: "stop",
          };
        }
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 15,
    });

    // With trimming active (KEEP_RECENT_PAIRS=3), history should be
    // bounded at ~8 messages (system + initial + 6 recent). Without
    // trimming, it would grow to 16+ messages by iteration 8.
    const maxLen = Math.max(...maxObservedHistoryLen);
    expect(maxLen).toBeLessThanOrEqual(8);
    expect(lastHistoryLen).toBeLessThanOrEqual(8);
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
