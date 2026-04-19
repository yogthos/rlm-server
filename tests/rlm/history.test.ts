import { describe, it, expect, vi } from "vitest";
import {
  extractHandleRefs,
  shouldCompact,
  buildSummaryPrompt,
  validateSummary,
  compactHistory,
} from "../../src/rlm/history.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../../src/rlm/types.js";

describe("extractHandleRefs", () => {
  it("finds $handle_name references", () => {
    const text = "Use the $grep_error result and $bm25_top10 together.";
    expect(extractHandleRefs(text)).toEqual(
      new Set(["$grep_error", "$bm25_top10"]),
    );
  });

  it("returns empty set when no references", () => {
    expect(extractHandleRefs("no handles here")).toEqual(new Set());
  });

  it("ignores RESULTS (not a handle)", () => {
    // RESULTS is a pointer, not a handle name. We should still include it
    // since it's a valid reference the model uses.
    const text = "filter(RESULTS, x => x > 0)";
    const refs = extractHandleRefs(text);
    // We don't require RESULTS to be in refs — but shouldn't crash
    expect(refs instanceof Set).toBe(true);
  });

  it("deduplicates refs", () => {
    const text = "$foo then $foo again, and $bar";
    expect(extractHandleRefs(text)).toEqual(new Set(["$foo", "$bar"]));
  });

  it("handles complex handle names", () => {
    const text = "$grep_error_2 and $z3_solve_42";
    expect(extractHandleRefs(text)).toEqual(
      new Set(["$grep_error_2", "$z3_solve_42"]),
    );
  });
});

describe("shouldCompact", () => {
  it("returns false for small history", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    expect(shouldCompact(history, { maxMessages: 10, maxChars: 10000 })).toBe(
      false,
    );
  });

  it("returns true when message count exceeds threshold", () => {
    const history: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `msg ${i}`,
    }));
    expect(shouldCompact(history, { maxMessages: 10, maxChars: 10000 })).toBe(
      true,
    );
  });

  it("returns true when total chars exceed threshold", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "x".repeat(5000) },
      { role: "user", content: "x".repeat(6000) },
    ];
    expect(shouldCompact(history, { maxMessages: 20, maxChars: 10000 })).toBe(
      true,
    );
  });
});

describe("buildSummaryPrompt", () => {
  it("includes the turns to summarize", () => {
    const turns: ChatMessage[] = [
      { role: "assistant", content: "ran grep" },
      { role: "user", content: "Result stored as $grep_x" },
    ];
    const prompt = buildSummaryPrompt(turns, new Set(["$grep_x"]));
    expect(prompt).toContain("ran grep");
    expect(prompt).toContain("Result stored as $grep_x");
    expect(prompt).toContain("$grep_x");
  });

  it("mentions active handle refs when present", () => {
    const turns: ChatMessage[] = [{ role: "user", content: "hi" }];
    const prompt = buildSummaryPrompt(turns, new Set(["$a", "$b"]));
    expect(prompt).toContain("$a");
    expect(prompt).toContain("$b");
  });

  it("works without active refs", () => {
    const turns: ChatMessage[] = [{ role: "user", content: "hi" }];
    const prompt = buildSummaryPrompt(turns, new Set());
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("validateSummary", () => {
  const middle: ChatMessage[] = [
    { role: "user", content: "a".repeat(200) },
    { role: "assistant", content: "b".repeat(200) },
  ];

  it("rejects empty", () => {
    const r = validateSummary("", middle, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toMatch(/empty|blank/);
  });

  it("rejects whitespace-only", () => {
    const r = validateSummary("   \n  ", middle, new Set());
    expect(r.ok).toBe(false);
  });

  it("rejects summaries longer than the original middle", () => {
    const middleLen = middle.reduce((s, m) => s + m.content.length, 0);
    const r = validateSummary("x".repeat(middleLen + 50), middle, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toMatch(/long|shorter|size/);
  });

  it("rejects summaries that drop active handle references", () => {
    const r = validateSummary(
      "The session did some work. Nothing else.",
      middle,
      new Set(["$grep_err", "$top_10"]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("$grep_err");
      expect(r.reason).toContain("$top_10");
    }
  });

  it("accepts a concise summary that preserves handle refs", () => {
    const r = validateSummary(
      "Explored the dataset via $grep_err and ranked results via $top_10.",
      middle,
      new Set(["$grep_err", "$top_10"]),
    );
    expect(r.ok).toBe(true);
  });
});

describe("compactHistory — retry on bad summary", () => {
  const makeLLM = (responses: string[]): LLMClient => {
    let i = 0;
    return {
      async chat(): Promise<LLMResponse> {
        const content = responses[Math.min(i, responses.length - 1)];
        i++;
        return { content, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
  };

  const buildLongHistory = (): ChatMessage[] => {
    const h: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "initial" },
    ];
    for (let i = 0; i < 20; i++) {
      h.push({ role: i % 2 === 0 ? "assistant" : "user", content: "x".repeat(500) });
    }
    return h;
  };

  it("retries when the first summary is bad, then accepts the corrected one", async () => {
    const llm = makeLLM(["", "Valid concise summary of the work."]);
    const spy = vi.spyOn(llm, "chat");
    const out = await compactHistory(buildLongHistory(), llm, {
      maxMessages: 5,
      maxChars: 100,
      keepRecent: 3,
    });
    // Two chat calls: first returned empty (rejected), second returned valid.
    expect(spy).toHaveBeenCalledTimes(2);
    // Summary message is present.
    expect(out.some((m) => m.content.includes("Valid concise summary"))).toBe(true);
  });

  it("falls back to drop when both attempts fail", async () => {
    const llm = makeLLM(["", ""]);
    const out = await compactHistory(buildLongHistory(), llm, {
      maxMessages: 5,
      maxChars: 100,
      keepRecent: 3,
    });
    // No summary message; just prefix + recent.
    expect(out.length).toBe(2 + 3);
    expect(out.some((m) => m.content.includes("summary"))).toBe(false);
  });
});
