import { describe, it, expect } from "vitest";
import { shouldUseHierarchical, detectCodingTask } from "../../src/rlm/routing.js";

describe("detectCodingTask", () => {
  it("flags code-writing prompts", () => {
    expect(detectCodingTask("build a guestbook app in TypeScript")).toBe(true);
    expect(detectCodingTask("implement a fibonacci function")).toBe(true);
    expect(detectCodingTask("write unit tests for this module")).toBe(true);
    expect(detectCodingTask("refactor the auth middleware")).toBe(true);
  });

  it("ignores non-code prompts", () => {
    expect(detectCodingTask("what is the capital of France?")).toBe(false);
    expect(detectCodingTask("summarize this document")).toBe(false);
  });

  it("flags prompts that reference target paths", () => {
    expect(detectCodingTask("add a feature to src/app.ts")).toBe(true);
  });
});

describe("shouldUseHierarchical", () => {
  it("returns true when explicit override is true", () => {
    expect(shouldUseHierarchical("whatever", true)).toBe(true);
  });

  it("returns false when explicit override is false", () => {
    expect(shouldUseHierarchical("build a web app in TS", false)).toBe(false);
  });

  it("defaults to false when override is undefined (gated opt-in)", () => {
    // Phase A: default off until benchmarks justify flipping.
    expect(shouldUseHierarchical("build an app")).toBe(false);
  });

  it("honours explicit false even for coding tasks", () => {
    expect(shouldUseHierarchical("implement sort", false)).toBe(false);
  });
});
