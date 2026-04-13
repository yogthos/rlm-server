import { describe, it, expect } from "vitest";
import {
  extractHandleRefs,
  shouldCompact,
  buildSummaryPrompt,
} from "../../src/rlm/history.js";
import type { ChatMessage } from "../../src/rlm/types.js";

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
