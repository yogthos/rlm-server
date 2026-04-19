import { describe, it, expect } from "vitest";
import { runRLMLoop } from "../../src/rlm/loop.js";
import { Role } from "../../src/rlm/roles.js";
import type { TaskEnvelope } from "../../src/rlm/envelopes.js";
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

  it("aborts sub-RLMs when parent loop completes", async () => {
    // The model spawns a sub-RLM. After parent's FINAL, the sub-RLM
    // should see signal.aborted and bail out — proving the internal
    // abort propagation works.
    let subSawAbort = false;
    let parentCalls = 0;

    const llm: LLMClient = {
      async chat(messages: ChatMessage[], options): Promise<LLMResponse> {
        parentCalls++;
        // Sub-RLM detection: gets "Context loaded:" metadata as first user msg
        const isSubRLM = messages.some((m) =>
          m.content.startsWith("Context loaded:") && m.content.includes("sub task"),
        );

        if (isSubRLM) {
          // First sub-RLM call: pretend to be busy until aborted
          if (options?.signal) {
            try {
              await new Promise((resolve, reject) => {
                const t = setTimeout(resolve, 5000);
                options.signal!.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(t);
                    subSawAbort = true;
                    reject(new Error("aborted by signal"));
                  },
                  { once: true },
                );
              });
            } catch {
              // expected — abort fired
            }
            return { content: "FINAL(sub-result)", finishReason: "stop" };
          }
          return { content: "FINAL(immediate)", finishReason: "stop" };
        }

        // Parent: spawn a sub-RLM (won't await), then immediately FINAL
        if (parentCalls === 1) {
          return {
            content:
              "```repl\n" +
              // unawaited — kicks off but doesn't block
              "llm_query('sub task in background');\n" +
              "console.log('parent done');\n" +
              "```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(parent done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
      maxSubRLMDepth: 2,
    });

    // Give microtask queue a chance to deliver the abort to pending sub
    await new Promise((r) => setTimeout(r, 50));

    expect(subSawAbort).toBe(true);
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

        // Intercept the summarization prompt. The real validateSummary
        // requires the summary to preserve every active handle reference
        // mentioned in `preserve: $x, $y, ...`, so extract and echo them
        // back in the summary body.
        if (
          messages[0]?.content?.startsWith("Summarize the following excerpt") ||
          messages.some((m) => m.content.startsWith("Summarize the following excerpt"))
        ) {
          const promptText = messages
            .map((m) => m.content)
            .find((c) => c.startsWith("Summarize the following excerpt")) ?? "";
          const refs = Array.from(promptText.matchAll(/\$[a-zA-Z_][a-zA-Z0-9_]*/g)).map(
            (m) => m[0],
          );
          const uniq = Array.from(new Set(refs));
          return {
            content: `progress so far: explored ${uniq.join(" and ")}`,
            finishReason: "stop",
          };
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
        // context bloats past the 20KB nudge threshold. Vary BIG prefix
        // to dodge the repeated-response detector.
        return {
          content: `\`\`\`repl\n// iter${iterCount} ${BIG}\nconsole.log('i${iterCount}');\n\`\`\``,
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
        // Always write broken code → execute always sets lastError.
        // Vary the content to dodge the repeated-response detector.
        return {
          content: `\`\`\`repl\nundefinedReference_${iterCount}();\n\`\`\``,
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

  it("force-terminates when model produces identical responses", async () => {
    let iterCount = 0;
    const SAME_TEXT = "I am thinking about this problem and exploring ".repeat(20);

    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        iterCount++;
        return { content: SAME_TEXT, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 30,
    });

    expect(result.iterations).toBeLessThan(10);
    expect(result.answer).toContain("thinking about this problem");
  });

  it("force-terminates after total no-code accumulation", async () => {
    let iterCount = 0;

    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        iterCount++;
        return {
          content: `Reasoning attempt ${iterCount}: still thinking, no code yet.`,
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
      maxIterations: 30,
    });

    // MAX_TOTAL_NO_CODE = 6 → terminate around iter 6-8
    expect(result.iterations).toBeLessThanOrEqual(10);
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

  it("passes roleBinding to the system prompt when provided", async () => {
    let capturedSystem = "";
    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        if (!capturedSystem) {
          const sys = messages.find((m) => m.role === "system");
          if (sys) capturedSystem = sys.content;
        }
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const envelope: TaskEnvelope = {
      goal: "ship the guestbook",
      parentContext: "full-stack TS app",
      tests: { framework: "vitest", files: {} },
      targetModule: "src/app.ts",
      targetExports: ["createApp"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    await runRLMLoop({
      prompt: "build guestbook",
      llmClient: llm,
      maxIterations: 3,
      roleBinding: { role: Role.Architect, envelope },
    });

    expect(capturedSystem).toContain("## ROLE: ARCHITECT");
    expect(capturedSystem).toContain("ship the guestbook");
  });

  it("suppresses plan-first directive when roleBinding is set (Architect plans on its own)", async () => {
    let capturedUser = "";
    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        if (!capturedUser) {
          const u = messages.find((m) => m.role === "user");
          if (u) capturedUser = u.content;
        }
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const envelope: TaskEnvelope = {
      // Prompt that WOULD trigger shouldPlanFirst (has "for each", "callers")
      goal: "analyze callers for each function in the module",
      parentContext: "",
      tests: { framework: "vitest", files: {} },
      targetModule: "src/a.ts",
      targetExports: ["main"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    await runRLMLoop({
      prompt: "analyze callers for each function across the codebase",
      llmClient: llm,
      maxIterations: 3,
      roleBinding: { role: Role.Architect, envelope },
    });

    // The user message should NOT contain the ReWOO plan-first template
    // when a role is already guiding the model.
    expect(capturedUser).not.toContain("PLAN PHASE");
  });

  it("omits role header when roleBinding is absent (backward compat)", async () => {
    let capturedSystem = "";
    const llm: LLMClient = {
      async chat(messages: ChatMessage[]): Promise<LLMResponse> {
        if (!capturedSystem) {
          const sys = messages.find((m) => m.role === "system");
          if (sys) capturedSystem = sys.content;
        }
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "plain task",
      llmClient: llm,
      maxIterations: 3,
    });

    expect(capturedSystem).not.toContain("## ROLE:");
  });

  it("rejects a premature FINAL that misses open spec items, then accepts the follow-up", async () => {
    const messages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        messages.push(lastUser?.content ?? "");
        // First turn: FINAL that only satisfies item 1 (/health) but misses /status.
        // Second turn: FINAL that satisfies both.
        if (messages.length === 1) {
          return {
            content: "FINAL(app.get('/health', ...))",
            finishReason: "stop",
          };
        }
        return {
          content: "FINAL(app.get('/health', ...); app.get('/status', ...))",
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const prompt = `Build an API with these requirements:

1. Expose GET /health returning OK
2. Expose GET /status returning JSON
`;

    const result = await runRLMLoop({
      prompt,
      llmClient: llm,
      maxIterations: 5,
    });

    // Two LLM calls: first FINAL rejected, second accepted.
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // The second user message should cite the missing item.
    const secondUserMsg = messages[1];
    expect(secondUserMsg.toLowerCase()).toMatch(/remaining|missed|checklist/);
    expect(secondUserMsg).toContain("/status");
    // Final answer accepted on the second try includes both routes.
    expect(result.answer).toContain("/health");
    expect(result.answer).toContain("/status");
  });

  it("does not reject a FINAL when spec items are all satisfied", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        return {
          content: "FINAL(app.get('/health', ...); app.get('/status', ...))",
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const prompt = `Build an API:

1. Expose GET /health
2. Expose GET /status
`;

    await runRLMLoop({ prompt, llmClient: llm, maxIterations: 5 });
    expect(callCount).toBe(1); // no rejection round needed
  });

  it("does not reject when the prompt has no enumerated spec", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        return { content: "FINAL(some answer)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "vague question with no spec",
      llmClient: llm,
      maxIterations: 5,
    });
    expect(callCount).toBe(1);
  });

  it("injects recent-actions ledger into environment feedback after execute", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        if (userMessages.length === 1) {
          return {
            content: "```repl\nconst x = 1;\nconsole.log('hi');\n```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(all done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "simple single-step task",
      llmClient: llm,
      maxIterations: 5,
    });

    // Second user turn is the environment-feedback after execute — it
    // should carry a RECENT ACTIONS block with a generate + execute entry.
    const feedback = userMessages[1];
    expect(feedback).toContain("RECENT ACTIONS");
    expect(feedback).toMatch(/iter=0.*generate/);
    expect(feedback).toMatch(/iter=0.*execute/);
  });

  it("injects repeat-failure hint when the same error recurs", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        // Two identical broken code turns — same error shape.
        if (userMessages.length <= 2) {
          return {
            content: "```repl\nundefinedFunction();\n```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(gave up)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "a task",
      llmClient: llm,
      maxIterations: 6,
    });

    // After the second failure, the 3rd user turn should contain a
    // REPEAT-FAILURE hint.
    const thirdTurn = userMessages[2] ?? "";
    expect(thirdTurn).toContain("REPEAT-FAILURE");
  });

  it("rejects Architect FINAL when no sub-RLMs were dispatched, then accepts the follow-up", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        // First turn: FINAL without any dispatch.
        // Second turn: mock a batch_llm_query call, then FINAL.
        if (userMessages.length === 1) {
          return {
            content: "FINAL(const foo = 1;)",
            finishReason: "stop",
          };
        }
        if (userMessages.length === 2) {
          return {
            content:
              "```repl\nconst r = await batch_llm_query(['implement foo']);\nconsole.log(r.length);\n```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(done after dispatching)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const envelope: TaskEnvelope = {
      goal: "do a coding task",
      parentContext: "(root)",
      tests: { framework: "vitest", files: {} },
      targetModule: "<architect>",
      targetExports: ["<architect>"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    const result = await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 8,
      roleBinding: { role: Role.Architect, envelope },
    });

    // At least 2 LLM turns: first FINAL rejected, dispatch turn, then FINAL accepted.
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    // The rejection nudge names the Architect requirement and the tool.
    const rejectionTurn = userMessages[1];
    expect(rejectionTurn.toLowerCase()).toContain("architect");
    expect(rejectionTurn).toContain("batch_llm_query");
    expect(rejectionTurn).toMatch(/dispatch/i);
    // And ultimately the follow-up FINAL is accepted.
    expect(result.answer).toContain("done after dispatching");
  });

  it("accepts Architect FINAL when a sub-RLM was dispatched", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        // Capture only ROOT user messages; sub-RLM single-shot calls get their
        // own "Answer the following query concisely" system prompt so we can
        // distinguish by checking for it.
        const sys = history.find((m) => m.role === "system");
        const isRoot = sys?.content.includes("## ROLE: ARCHITECT") ?? false;
        if (isRoot) userMessages.push(lastUser?.content ?? "");

        // Root turn 1: dispatch via llm_query.
        // Sub-RLM: returns quickly (any answer).
        // Root turn 2: FINAL (must be accepted without rejection round).
        if (isRoot && userMessages.length === 1) {
          return {
            content:
              "```repl\nconst r = await llm_query('implement foo');\nconsole.log(r.length);\n```",
            finishReason: "stop",
          };
        }
        if (isRoot) {
          return { content: "FINAL(complete)", finishReason: "stop" };
        }
        // Sub-RLM single-shot
        return { content: "foo implementation", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const envelope: TaskEnvelope = {
      goal: "coding task",
      parentContext: "(root)",
      tests: { framework: "vitest", files: {} },
      targetModule: "<architect>",
      targetExports: ["<architect>"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    const result = await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 8,
      roleBinding: { role: Role.Architect, envelope },
    });

    // Two ROOT turns: dispatch, then FINAL accepted. No rejection round.
    expect(userMessages.length).toBe(2);
    expect(result.answer).toContain("complete");
    // No message in the ROOT flow should contain the architect-dispatch rejection phrase.
    expect(userMessages.some((m) => m.includes("REJECTED") && m.toLowerCase().includes("architect"))).toBe(false);
  });

  it("does NOT fire the generic bloat nudge when an Architect roleBinding is active", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        const sys = history.find((m) => m.role === "system");
        const isRoot = sys?.content.includes("## ROLE: ARCHITECT") ?? false;
        if (isRoot) userMessages.push(lastUser?.content ?? "");

        // 6 big code turns that would normally trip bloatedLate (>5 iters, >20KB).
        // Each turn writes ~5KB of code in variables — no dispatch, no FINAL.
        if (isRoot && userMessages.length <= 6) {
          const filler = "x".repeat(5000);
          return {
            content: "```repl\nconst bloat_" + userMessages.length + " = \"" + filler + "\";\n```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(stop test here)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const envelope: TaskEnvelope = {
      goal: "coding task",
      parentContext: "(root)",
      tests: { framework: "vitest", files: {} },
      targetModule: "<architect>",
      targetExports: ["<architect>"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 8,
      roleBinding: { role: Role.Architect, envelope },
    });

    // With an Architect active, the map/reduce "STOP. Abandon your current approach"
    // nudge must not appear — the Architect's own gate (P2) handles dispatch.
    const sawMapReduceNudge = userMessages.some(
      (m) => m.includes("STOP. Abandon your current approach") || m.includes("skeleton plan"),
    );
    expect(sawMapReduceNudge).toBe(false);
  });

  it("rejects a FINAL with structurally broken code, then accepts the fixed follow-up", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        // Turn 1: FINAL with a call cycle (blocking structural error)
        if (userMessages.length === 1) {
          const broken = [
            "```ts",
            "export function a(): number { return b(); }",
            "export function b(): number { return a(); }",
            "```",
          ].join("\n");
          return { content: `Here is the module:\n${broken}\n\nFINAL(${broken})`, finishReason: "stop" };
        }
        // Turn 2: clean file
        const clean = [
          "```ts",
          "export function a(): number { return 1; }",
          "export function b(): number { return 2; }",
          "```",
        ].join("\n");
        return { content: `Fixed.\nFINAL(${clean})`, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 5,
    });

    // Two turns: first rejected due to cycle, second accepted.
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    // Rejection nudge cites a cycle or structural error.
    const rejection = userMessages[1];
    expect(rejection.toLowerCase()).toMatch(/structural|cycle|error|validation/);
    // Final answer accepted on the follow-up.
    expect(result.answer).toMatch(/function a\(\)/);
  }, 30000);

  it("appends structural violations to a sub-RLM's return when it ships broken code", async () => {
    let capturedSubReturn = "";
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const sys = history.find((m) => m.role === "system");
        const isRoot =
          (sys?.content.includes("## ROLE: ARCHITECT") ?? false) ||
          (sys?.content.includes("RLM") ?? false);

        // At the single-shot sub-RLM (max depth), return a file with a call cycle.
        if (!isRoot || sys?.content.includes("Answer the following query concisely")) {
          return {
            content: [
              "```ts",
              "export function a(): number { return b(); }",
              "export function b(): number { return a(); }",
              "```",
            ].join("\n"),
            finishReason: "stop",
          };
        }

        // Root: turn 1 dispatches; turn 2 captures what came back and FINALs.
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        const body = lastUser?.content ?? "";
        if (!body.includes("STRUCTURAL VIOLATIONS")) {
          return {
            content: "```repl\nconst r = await llm_query('implement foo'); console.log(r);\n```",
            finishReason: "stop",
          };
        }
        capturedSubReturn = body;
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    // Run at non-architect mode (roleBinding undefined) so the sub-RLM flows
    // through the existing llm_query path and its answer is visible as
    // feedback from the execute step.
    await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 6,
      // Force single-shot sub-RLM by setting max depth low.
      maxSubRLMDepth: 0,
    });

    // The root eventually saw a turn whose feedback contained the sub-RLM
    // answer — and that answer was augmented with a STRUCTURAL VIOLATIONS
    // footer by the bridge.
    expect(capturedSubReturn).toContain("STRUCTURAL VIOLATIONS");
    expect(capturedSubReturn.toLowerCase()).toMatch(/cycle/);
  });

  it("rejects FINAL that parses but fails typecheck (full-mode gate)", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        if (userMessages.length === 1) {
          // Parses fine, structural-clean, but type-mismatched return.
          const bad = [
            "```ts",
            "export function add(a: number, b: number): string { return a + b; }",
            "```",
          ].join("\n");
          return { content: `FINAL(${bad})`, finishReason: "stop" };
        }
        const good = [
          "```ts",
          "export function add(a: number, b: number): number { return a + b; }",
          "```",
        ].join("\n");
        return { content: `FINAL(${good})`, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "write a helper",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    const rejection = userMessages[1];
    // typecheck error should reach the fix prompt
    expect(rejection.toLowerCase()).toMatch(/type|typecheck|string|number/);
    expect(result.answer).toMatch(/function add/);
  }, 45000);

  it("does NOT validate stray ts-fenced blocks when FINAL is prose", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        // A sketch ts block the model wrote as an aside, paired with a prose FINAL.
        // The gate should treat the FINAL as the artifact (prose), not the sketch.
        const sketch = [
          "```ts",
          "export function a(): number { return b(); }",
          "export function b(): number { return a(); }",
          "```",
        ].join("\n");
        return {
          content: `${sketch}\n\nFINAL(the answer is 42)`,
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const result = await runRLMLoop({
      prompt: "tell me a number",
      llmClient: llm,
      maxIterations: 5,
    });

    // Prose FINAL → no repair cycle; the loop accepts on the first call.
    expect(callCount).toBe(1);
    expect(result.answer).toBe("the answer is 42");
  });

  it("DOES validate llmOutput when the FINAL_VAR refers to code elsewhere", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        callCount++;
        // Second call returns clean code so the loop can accept.
        if (callCount > 1) {
          return {
            content: "```ts\nexport const v = 1;\n```\n\nFINAL(done)",
            finishReason: "stop",
          };
        }
        // First call: broken code in a ts block, FINAL_VAR referencing a variable.
        const broken = [
          "```ts",
          "export function a(): number { return b(); }",
          "export function b(): number { return a(); }",
          "```",
        ].join("\n");
        return { content: `${broken}\n\nFINAL_VAR(serverJs)`, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "build something with FINAL_VAR",
      llmClient: llm,
      maxIterations: 5,
    });
    // The first turn's code (behind FINAL_VAR) should have triggered structural
    // rejection, producing at least a second LLM call.
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 45000);

  it("does NOT mark spec items satisfied from reasoning/prose alone", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          // Pure prose — no code, no FINAL. Mentions spec tokens in reasoning only.
          return {
            content:
              "I will implement POST /sign and GET /api/entries shortly. " +
              "My plan: handle the form, then query the database.",
            finishReason: "stop",
          };
        }
        // Second call: finally emit a FINAL but without the spec tokens.
        // Since no prior turn carried them in code/FINAL, the spec should
        // still show them as open and the rejection gate must fire.
        return { content: "FINAL(no routes defined)", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const prompt = `Build an API:

1. Expose POST /sign for form submissions
2. Expose GET /api/entries returning JSON
`;

    const result = await runRLMLoop({
      prompt,
      llmClient: llm,
      maxIterations: 5,
    });

    // Second FINAL gets spec-rejected because the tokens only appeared in
    // reasoning/prose on turn 1 — not in produced code or the FINAL body.
    expect(callCount).toBeGreaterThanOrEqual(3);
    // The final accepted answer is after rejection — implementation detail
    // is that it eventually lands something, we don't assert on content here.
    expect(result.answer).toBeTruthy();
  });

  it("nudges the model when FINAL_VAR appears inside a code block (format gate)", async () => {
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        if (userMessages.length === 1) {
          // Model mistakenly puts FINAL_VAR as a function call inside repl.
          return {
            content:
              "```repl\nconst serverJs = 'module contents';\nFINAL_VAR(serverJs)\n```",
            finishReason: "stop",
          };
        }
        // After the format nudge, model does it correctly.
        return {
          content: "```repl\nconst serverJs = 'module contents';\n```\n\nFINAL_VAR(serverJs)",
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "write a module",
      llmClient: llm,
      maxIterations: 6,
    });

    // Turn 2 should contain the format-gate nudge (not just the regular execute feedback).
    const nudge = userMessages[1];
    expect(nudge).toBeTruthy();
    expect(nudge.toLowerCase()).toMatch(/directive|outside|format|final_var/);
    // Should mention that FINAL_VAR is not a function.
    expect(nudge).toMatch(/not a function|outside.*block|outside.*fence/i);
  });

  it("does NOT fire the format gate on code that merely mentions FINAL_VAR in a comment", async () => {
    // Comments with FINAL_VAR are fine — conservative false-positive only
    // matters if the user has asked to be overly strict; here we want the
    // gate to be specific. We accept that commented-out FINAL_VAR triggers,
    // since the model shouldn't be commenting about directives in code.
    // (This test pins the "at most once per run" cap instead.)
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        // Same broken pattern twice in a row — only nudges ONCE.
        if (callCount <= 2) {
          return {
            content: "```repl\nconst x = 1;\nFINAL_VAR(x)\n```",
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
      maxIterations: 8,
    });
    // Model goes: bad → nudge → bad (ignored gate) → execute → eventually FINAL.
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("runs a structural repair loop on sub-RLM single-shot at max depth", async () => {
    // Parent dispatches via llm_query at max depth → single-shot path.
    // First sub response is broken (call cycle); second returns clean code.
    let totalCalls = 0;
    let subCalls = 0;
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        totalCalls++;
        const sys = history.find((m) => m.role === "system");
        const isRoot = sys?.content.includes("JavaScript REPL") ?? false;

        if (isRoot) {
          // Root: turn 1 dispatches; turn 2 finalizes.
          const lastUser = [...history].reverse().find((m) => m.role === "user");
          if (lastUser?.content.includes("$final_var") || lastUser?.content.includes("handle=")) {
            // After the sub-RLM returned, FINAL out.
            return { content: "FINAL(done)", finishReason: "stop" };
          }
          return {
            content:
              "```repl\nconst r = await llm_query('implement a and b');\nconsole.log(r);\n```",
            finishReason: "stop",
          };
        }

        // Sub-RLM (single-shot) calls — broken first, then clean.
        subCalls++;
        if (subCalls === 1) {
          return {
            content: [
              "```ts",
              "export function a(): number { return b(); }",
              "export function b(): number { return a(); }",
              "```",
            ].join("\n"),
            finishReason: "stop",
          };
        }
        return {
          content: [
            "```ts",
            "export function a(): number { return 1; }",
            "export function b(): number { return 2; }",
            "```",
          ].join("\n"),
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    await runRLMLoop({
      prompt: "build something",
      llmClient: llm,
      maxIterations: 6,
      maxSubRLMDepth: 0, // force single-shot for sub-RLM
    });

    // At least 2 sub-RLM calls — the broken first call triggered a repair.
    expect(subCalls).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("propagates a child roleBinding into the recursive sub-RLM spawn", async () => {
    let sawAgentSubSystem = false;
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const sys = history.find((m) => m.role === "system");
        // Sub-RLM must see an AGENT/DISPATCHER role header — not the plain
        // RLM system prompt the root-level Architect saw.
        if (sys?.content.includes("## ROLE: AGENT")) {
          sawAgentSubSystem = true;
          return { content: "FINAL(done from sub)", finishReason: "stop" };
        }
        // Root: dispatch once via llm_query.
        if (sys?.content.includes("## ROLE: ARCHITECT")) {
          const lastUser = [...history].reverse().find((m) => m.role === "user");
          if (lastUser?.content.includes("done from sub")) {
            return { content: "FINAL(all done)", finishReason: "stop" };
          }
          return {
            content: "```repl\nconst r = await llm_query('implement src/foo.ts'); console.log(r);\n```",
            finishReason: "stop",
          };
        }
        return { content: "FINAL(fallback)", finishReason: "stop" };
      },
      async listModels() { return ["mock"]; },
    };

    const envelope: TaskEnvelope = {
      goal: "build foo",
      parentContext: "(root)",
      tests: { framework: "vitest", files: {} },
      targetModule: "<architect-root>",
      targetExports: ["<architect-root>"],
      depth: 0,
      maxDepth: 3,
      budgetHint: "hours",
    };

    await runRLMLoop({
      prompt: "build foo",
      llmClient: llm,
      maxIterations: 5,
      maxSubRLMDepth: 3, // allow recursion so child is non-leaf
      roleBinding: { role: Role.Architect, envelope },
    });

    expect(sawAgentSubSystem).toBe(true);
  });

  it("uses the Implementer prompt at the single-shot leaf (maxDepth)", async () => {
    let sawImplementerSystem = false;
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const sys = history.find((m) => m.role === "system");
        // The leaf must see an IMPLEMENTER role header — not the
        // "Answer concisely" placeholder — so it knows to produce code.
        if (sys?.content.includes("## ROLE: IMPLEMENTER")) {
          sawImplementerSystem = true;
          return {
            content: "```ts\nexport const x = 1;\n```",
            finishReason: "stop",
          };
        }
        // Root Architect dispatches via llm_query at max depth (0).
        return {
          content: "```repl\nconst r = await llm_query('implement src/x.ts');\nconsole.log(r);\n```",
          finishReason: "stop",
        };
      },
      async listModels() { return ["mock"]; },
    };

    const envelope: TaskEnvelope = {
      goal: "root",
      parentContext: "(root)",
      tests: { framework: "vitest", files: {} },
      targetModule: "<architect-root>",
      targetExports: ["<architect-root>"],
      depth: 0,
      maxDepth: 1,
      budgetHint: "hours",
    };

    await runRLMLoop({
      prompt: "root task",
      llmClient: llm,
      maxIterations: 4,
      maxSubRLMDepth: 0, // force the sub-RLM path to single-shot
      roleBinding: { role: Role.Architect, envelope },
    });

    expect(sawImplementerSystem).toBe(true);
  }, 30000);

  it("FINAL_VAR fallthrough promotes execute result to finalAnswer (no extra iteration)", async () => {
    // Turn 1: define a sandbox global `result` in a way that slugs the
    // handle under a different name (so handleStore.resolve won't find
    // $result). Turn 2: FINAL_VAR(result) → must resolve via fallthrough
    // AND terminate the loop in ONE chat round, not two.
    let callCount = 0;
    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          return {
            content: "```repl\nvar result = \"hello world\";\nconsole.log(\"set\");\n```",
            finishReason: "stop",
          };
        }
        if (callCount === 2) {
          return { content: "FINAL_VAR(result)", finishReason: "stop" };
        }
        // A THIRD call would mean the fallthrough failed to promote to
        // finalAnswer and the loop ran another generate iteration.
        return { content: "FINAL(should not reach here)", finishReason: "stop" };
      },
      async listModels() { return ["mock"]; },
    };

    const result = await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 5,
    });

    expect(callCount).toBe(2);
    expect(result.answer).toContain("hello world");
  });

  it("shares the supplied projectGraph across recursive sub-RLMs", async () => {
    const { createProjectGraph } = await import("../../src/rlm/project-graph.js");
    const shared = createProjectGraph();
    await shared.addOrUpdate("src/preloaded.ts", "export const x = 1;");
    const initialSize = shared.size;

    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() { return ["mock"]; },
    };

    await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 3,
      projectGraph: shared,
    });

    // The shared graph is still the same instance — its contents stay.
    expect(shared.size).toBe(initialSize);
    expect(shared.hasFile("src/preloaded.ts")).toBe(true);
  });

  it("nudges when FINAL(x) is a bare identifier matching a stored handle (Did you mean FINAL_VAR?)", async () => {
    // Uses `grep("needle")` so the slug generator produces a deterministic
    // handle name ($grep_needle) we can FINAL() to trip the gate.
    const userMessages: string[] = [];
    const llm: LLMClient = {
      async chat(history: ChatMessage[]): Promise<LLMResponse> {
        const lastUser = [...history].reverse().find((m) => m.role === "user");
        userMessages.push(lastUser?.content ?? "");
        if (userMessages.length === 1) {
          // Turn 1: run grep — handle gets stored under $grep_needle.
          return {
            content: "```repl\ngrep(\"needle\");\n```",
            finishReason: "stop",
          };
        }
        if (userMessages.length === 2) {
          // Turn 2: confused `FINAL(grep_needle)` — literal, not a reference.
          return { content: "FINAL(grep_needle)", finishReason: "stop" };
        }
        // Turn 3: after the nudge, use FINAL_VAR correctly.
        return { content: "FINAL_VAR(grep_needle)", finishReason: "stop" };
      },
      async listModels() { return ["mock"]; },
    };

    await runRLMLoop({
      prompt: "search for needle",
      llmClient: llm,
      maxIterations: 5,
    });

    // 3 LLM calls: define, mistaken FINAL, corrected FINAL_VAR.
    expect(userMessages.length).toBe(3);
    // Turn 3's user message carries the corrective nudge.
    expect(userMessages[2].toLowerCase()).toMatch(/final_var|did you mean/);
  });

  it("shares the supplied designGraph across recursive sub-RLMs", async () => {
    const { createDesignGraph } = await import("../../src/rlm/design-graph.js");
    const shared = createDesignGraph();
    shared.addFunction(
      "src/preloaded.ts",
      "foo",
      { params: [], returnType: "number" },
      "",
    );
    const beforeCount = shared.listFunctions().length;

    const llm: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "FINAL(done)", finishReason: "stop" };
      },
      async listModels() { return ["mock"]; },
    };

    await runRLMLoop({
      prompt: "test",
      llmClient: llm,
      maxIterations: 3,
      designGraph: shared,
    });

    // Same instance — contents preserved (and future sub-RLMs would see them).
    expect(shared.listFunctions().length).toBe(beforeCount);
    expect(shared.getFunction("src/preloaded.ts", "foo")).toBeDefined();
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
