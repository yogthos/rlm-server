/**
 * Test that the local-llm history converter handles OpenAI role:"tool"
 * messages correctly. We can't test the full LLM without loading a model,
 * but we can exercise the conversion logic indirectly via a request.
 *
 * Since convertHistory is not exported, we test the behavior through
 * the public client with a stub that captures the conversion.
 */
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../src/rlm/types.js";

// Re-export the conversion logic for testing. We'll need to expose
// convertHistory from local-llm.ts.
import { convertMessagesForTesting } from "../../src/rlm/providers/local.js";

describe("convertMessagesForTesting (tool message handling)", () => {
  it("extracts system prompt from first system message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];
    const result = convertMessagesForTesting(messages);
    expect(result.systemPrompt).toBe("You are helpful");
    expect(result.lastUserMessage).toBe("Hi");
    expect(result.priorHistory).toEqual([]);
  });

  it("formats tool message as the trailing prompt", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/tmp/x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "hello world" },
    ];
    const result = convertMessagesForTesting(messages);
    expect(result.lastUserMessage).toContain("Tool result");
    expect(result.lastUserMessage).toContain("call_1");
    expect(result.lastUserMessage).toContain("hello world");
  });

  it("injects tool_calls summary into assistant history entry", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: "I'll call a tool",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: "q2" },
    ];
    const result = convertMessagesForTesting(messages);
    expect(result.lastUserMessage).toBe("q2");
    const modelEntry = result.priorHistory.find((e) => e.type === "model") as
      | { type: "model"; response: string[] }
      | undefined;
    expect(modelEntry).toBeDefined();
    expect(modelEntry!.response[0]).toContain("I'll call a tool");
    expect(modelEntry!.response[0]).toContain("called search");
  });

  it("converts tool message in history to user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result1" },
      { role: "user", content: "q2" },
    ];
    const result = convertMessagesForTesting(messages);
    // History should contain: user q1, model (assistant+call), user (tool result)
    expect(result.priorHistory.length).toBeGreaterThanOrEqual(3);
    const toolEntry = result.priorHistory.find(
      (e) => e.type === "user" && e.text.includes("result1"),
    );
    expect(toolEntry).toBeDefined();
  });
});
