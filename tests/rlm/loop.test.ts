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

  it("compacts history when it exceeds thresholds", async () => {
    // Default thresholds: 20 messages OR 48KB chars. We generate long
    // responses (3500 chars each) so ~14 iterations should cross the
    // char threshold.
    let iterCount = 0;
    let sawSummary = false;
    const historyLens: number[] = [];
    const RESP = "x".repeat(3500);

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        historyLens.push(messages.length);

        // Intercept the summarization prompt
        if (
          messages.length === 1 &&
          messages[0].content.startsWith("Summarize the following excerpt")
        ) {
          return { content: "progress so far: explored things", finishReason: "stop" };
        }

        if (messages.some((m) => m.content.includes("Progress summary"))) {
          sawSummary = true;
        }

        if (iterCount < 20) {
          return {
            content: `\`\`\`repl\n// long code ${iterCount}\n${RESP}\n\`\`\``,
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
      maxIterations: 25,
    });

    expect(sawSummary).toBe(true);
  });

  it("nudges toward decomposition when root bloats without sub-RLMs", async () => {
    let nudged = false;
    let iterCount = 0;
    const BIG = "x".repeat(4000); // each response adds ~4KB to history

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (
          messages.some((m) =>
            m.content.includes("Abandon your current approach"),
          )
        ) {
          nudged = true;
          return { content: "FINAL(noted, giving up)", finishReason: "stop" };
        }
        // Model never delegates, writes LONG code each iter so root
        // context bloats past the 20KB nudge threshold
        return {
          content: `\`\`\`repl\n// ${BIG}\nconsole.log('i${iterCount}');\n\`\`\``,
          finishReason: "stop",
        };
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

    expect(nudged).toBe(true);
  });

  it("nudges EARLY when model errors before iter 5", async () => {
    // The model writes broken code that throws, so executeHandler sets
    // lastError. After iter 3 with errors, the early trigger should fire.
    let nudged = false;
    let nudgeIter = -1;
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (
          messages.some((m) =>
            m.content.includes("Abandon your current approach"),
          )
        ) {
          nudged = true;
          nudgeIter = iterCount;
          return { content: "FINAL(noted)", finishReason: "stop" };
        }
        // Always write broken code → execute always sets lastError
        return {
          content: "```repl\nundefinedReference();\n```",
          finishReason: "stop",
        };
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

    expect(nudged).toBe(true);
    // Should fire by iter 5 at latest (early condition triggers at 3+)
    expect(nudgeIter).toBeLessThanOrEqual(5);
  });

  it("rejects premature FINAL on tasks that require planning", async () => {
    let rejected = false;
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (
          messages.some((m) =>
            m.content.includes("REJECTED. Your final answer is not acceptable"),
          )
        ) {
          rejected = true;
          return { content: "FINAL(ok, accepting after rejection)", finishReason: "stop" };
        }
        // Try to FINAL immediately without any tool use
        return { content: "FINAL(quick guess)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    // A prompt that triggers shouldPlanFirst (file paths)
    const prompt = [
      "Analyze these files for callers:",
      "/abs/path/a.ts",
      "/abs/path/b.ts",
    ].join("\n");

    await runRLMLoop({
      prompt,
      llmClient: llm,
      maxIterations: 10,
    });

    expect(rejected).toBe(true);
  });

  it("does NOT reject FINAL on simple tasks", async () => {
    let rejected = false;
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (
          messages.some((m) =>
            m.content.includes("REJECTED"),
          )
        ) {
          rejected = true;
        }
        return { content: "FINAL(42)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "What is 2+2?",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(rejected).toBe(false);
  });

  it("does NOT nudge when root is solving efficiently", async () => {
    // Short responses, few iterations → no nudge even at iter 5+
    let nudged = false;
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (messages.some((m) => m.content.includes("Abandon your current approach"))) {
          nudged = true;
        }
        if (iterCount < 8) {
          // Short code → minimal history growth
          return {
            content: "```repl\nconsole.log(1);\n```",
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

    // 8 small iterations: history stays under 20KB → no nudge
    expect(nudged).toBe(false);
  });

  it("does not nudge when sub-RLMs have already been spawned", async () => {
    let nudged = false;
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        iterCount++;
        if (
          messages.some((m) =>
            m.content.includes("Abandon your current approach"),
          )
        ) {
          nudged = true;
        }
        // Also detect the sub-RLM init (its first message has "Context loaded:")
        if (
          messages.some((m) => m.content.startsWith("Context loaded:")) &&
          iterCount > 1
        ) {
          return { content: "FINAL(sub-done)", finishReason: "stop" };
        }

        // On iter 1, parent calls llm_query (triggering a sub-RLM)
        if (iterCount === 1) {
          return {
            content: `\`\`\`repl\nconst r = await llm_query("sub task");\nconsole.log(r);\n\`\`\``,
            finishReason: "stop",
          };
        }
        // Then many more iterations without further delegation
        if (iterCount < 12) {
          return {
            content: `\`\`\`repl\nconsole.log('step ${iterCount}');\n\`\`\``,
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

    // Sub-RLM was dispatched → no nudge
    expect(nudged).toBe(false);
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
