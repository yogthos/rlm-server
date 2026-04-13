import { describe, it, expect } from "vitest";
import { routeRequest, shouldPlanFirst } from "../../src/rlm/routing.js";
import type { ChatMessage } from "../../src/rlm/types.js";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

describe("routeRequest", () => {
  it("explicit override: rlm=true forces RLM", () => {
    expect(routeRequest([user("hello")], true)).toBe("rlm");
  });

  it("explicit override: rlm=false forces direct", () => {
    expect(
      routeRequest([user("search this long document for errors")], false),
    ).toBe("direct");
  });

  it("short instruction → direct", () => {
    expect(routeRequest([user("Write a function to sort an array")])).toBe(
      "direct",
    );
  });

  it("short conversational → direct", () => {
    expect(routeRequest([user("What is TypeScript?")])).toBe("direct");
  });

  it("tool keyword 'verify' → rlm", () => {
    expect(
      routeRequest([user("Verify that this equation has a solution")]),
    ).toBe("rlm");
  });

  it("tool keyword 'z3' → rlm", () => {
    expect(routeRequest([user("Use z3 to find x where x^2 = 25")])).toBe(
      "rlm",
    );
  });

  it("tool keyword 'call graph' → rlm", () => {
    expect(routeRequest([user("Show me the call graph of this code")])).toBe(
      "rlm",
    );
  });

  it("large prompt → rlm", () => {
    const longContent = "log line " + "x".repeat(3000);
    expect(routeRequest([user(longContent)])).toBe("rlm");
  });

  it("no user message → direct", () => {
    expect(
      routeRequest([{ role: "system", content: "you are helpful" }]),
    ).toBe("direct");
  });

  it("uses the LAST user message for routing", () => {
    // Earlier messages don't matter
    const messages: ChatMessage[] = [
      user("short hi"),
      { role: "assistant", content: "hi" },
      user("verify this is prime: 97"),
    ];
    expect(routeRequest(messages)).toBe("rlm");
  });
});

describe("shouldPlanFirst", () => {
  it("returns true for 'top N' tasks", () => {
    expect(shouldPlanFirst("Find the top 5 most-impacted functions")).toBe(true);
    expect(shouldPlanFirst("rank these items by score")).toBe(true);
  });

  it("returns true for 'for each' tasks", () => {
    expect(shouldPlanFirst("for each function, compute X")).toBe(true);
  });

  it("returns true for code analysis keywords", () => {
    expect(shouldPlanFirst("Analyze these files for callers")).toBe(true);
    expect(shouldPlanFirst("Find dead code in the project")).toBe(true);
  });

  it("returns true when 2+ file paths are listed", () => {
    expect(
      shouldPlanFirst(
        "Look at:\n/path/to/a.ts\n/path/to/b.ts\nand find issues",
      ),
    ).toBe(true);
  });

  it("returns false for simple single-question tasks", () => {
    expect(shouldPlanFirst("What is 2+2?")).toBe(false);
    expect(shouldPlanFirst("Write hello world in Python")).toBe(false);
  });

  it("returns false for short instruction tasks", () => {
    expect(shouldPlanFirst("Reverse this string: hello")).toBe(false);
  });
});
