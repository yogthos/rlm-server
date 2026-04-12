import { describe, it, expect } from "vitest";
import {
  promptMetadata,
  stdoutMetadata,
  resultMetadata,
  isLikelyCode,
  guessContentType,
} from "../../src/rlm/metadata.js";

describe("promptMetadata", () => {
  it("includes length and line count", () => {
    const meta = promptMetadata("line 1\nline 2\nline 3");
    expect(meta).toContain("20 chars");
    expect(meta).toContain("3 lines");
  });

  it("includes a preview of the content", () => {
    const meta = promptMetadata("Hello, world! This is a test.");
    expect(meta).toContain("Hello, world!");
  });

  it("truncates long previews", () => {
    const long = "x".repeat(500);
    const meta = promptMetadata(long);
    expect(meta).toContain("...");
  });

  it("guesses content type for JSON", () => {
    const meta = promptMetadata('{"key": "value"}');
    expect(meta).toContain("JSON");
  });

  it("guesses content type for Markdown", () => {
    const meta = promptMetadata("# Title\n\nSome text");
    expect(meta).toContain("Markdown");
  });

  it("mentions the context variable", () => {
    const meta = promptMetadata("test");
    expect(meta).toContain("`context`");
  });
});

describe("stdoutMetadata", () => {
  it("handles empty output", () => {
    expect(stdoutMetadata("")).toBe("[No output]");
  });

  it("shows length and preview", () => {
    const meta = stdoutMetadata("hello world");
    expect(meta).toContain("11 chars");
    expect(meta).toContain("hello world");
  });

  it("truncates long output", () => {
    const long = "x".repeat(1000);
    const meta = stdoutMetadata(long);
    expect(meta).toContain("1000 chars");
    expect(meta).toContain("...");
    // Should not contain all 1000 chars
    expect(meta.length).toBeLessThan(600);
  });
});

describe("resultMetadata", () => {
  it("handles null and undefined", () => {
    expect(resultMetadata(null)).toBe("Result: null");
    expect(resultMetadata(undefined)).toBe("Result: undefined");
  });

  it("describes arrays with count and first item", () => {
    const meta = resultMetadata(["first", "second", "third"]);
    expect(meta).toContain("Array(3)");
    expect(meta).toContain("first");
  });

  it("handles empty arrays", () => {
    expect(resultMetadata([])).toBe("Result: empty array");
  });

  it("describes strings with length", () => {
    const meta = resultMetadata("hello world");
    expect(meta).toContain("String(11)");
    expect(meta).toContain("hello world");
  });

  it("handles empty strings", () => {
    expect(resultMetadata("")).toBe("Result: empty string");
  });

  it("describes objects with keys", () => {
    const meta = resultMetadata({ a: 1, b: 2 });
    expect(meta).toContain("Object");
    expect(meta).toContain("a, b");
  });

  it("shows primitives directly", () => {
    expect(resultMetadata(42)).toBe("Result: 42");
    expect(resultMetadata(true)).toBe("Result: true");
  });
});

describe("isLikelyCode", () => {
  it("detects TypeScript by file extension", () => {
    expect(isLikelyCode("see src/app.ts for details")).toBe(true);
  });

  it("detects Python by patterns", () => {
    expect(
      isLikelyCode('def hello():\n    return "world"\nimport os'),
    ).toBe(true);
  });

  it("detects JavaScript by patterns", () => {
    expect(
      isLikelyCode("function foo() {}\nconst bar = () => {};"),
    ).toBe(true);
  });

  it("rejects regular prose", () => {
    expect(
      isLikelyCode("The quick brown fox jumps over the lazy dog."),
    ).toBe(false);
  });

  it("rejects text that just mentions programming", () => {
    expect(
      isLikelyCode("I want to learn programming and write functions."),
    ).toBe(false);
  });
});

describe("guessContentType", () => {
  it("identifies source code via strong patterns", () => {
    expect(
      guessContentType("function foo() { return 1; }\nconst x = foo();"),
    ).toBe("source code");
  });

  it("identifies JSON", () => {
    expect(guessContentType('{"key": "value"}')).toBe("JSON document");
  });

  it("identifies markdown", () => {
    expect(guessContentType("# Title\n\nBody text")).toBe("Markdown document");
  });

  it("defaults to text document", () => {
    expect(guessContentType("Just some plain prose here.")).toBe(
      "text document",
    );
  });
});
