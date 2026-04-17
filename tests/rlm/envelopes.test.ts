import { describe, it, expect } from "vitest";
import {
  encodeTaskEnvelope,
  decodeTaskEnvelope,
  encodeResultEnvelope,
  decodeResultEnvelope,
  validateTaskEnvelope,
  validateResultEnvelope,
  type TaskEnvelope,
  type ResultEnvelope,
} from "../../src/rlm/envelopes.js";

const minimalTask: TaskEnvelope = {
  goal: "implement fibonacci",
  parentContext: "utility module",
  tests: {
    framework: "vitest",
    files: { "tests/fib.test.ts": "import { fib } from '../src/fib.js';" },
  },
  targetModule: "src/fib.ts",
  targetExports: ["fib"],
  depth: 0,
  maxDepth: 3,
  budgetHint: "minutes",
};

const minimalResult: ResultEnvelope = {
  goal: "implement fibonacci",
  artifact: { "src/fib.ts": "export const fib = (n: number) => n;" },
  testResults: { passed: 1, failed: 0, skipped: 0, failures: [] },
  integrationHints: "",
  status: "complete",
};

describe("TaskEnvelope", () => {
  it("round-trips through encode/decode", () => {
    const json = encodeTaskEnvelope(minimalTask);
    expect(typeof json).toBe("string");
    const back = decodeTaskEnvelope(json);
    expect(back).toEqual(minimalTask);
  });

  it("preserves optional fields", () => {
    const full: TaskEnvelope = {
      ...minimalTask,
      structuralContract: "forbidden :- imports(a, b).",
      siblingSummaries: ["sibling one", "sibling two"],
    };
    expect(decodeTaskEnvelope(encodeTaskEnvelope(full))).toEqual(full);
  });

  it("validates required fields", () => {
    expect(validateTaskEnvelope(minimalTask).ok).toBe(true);
  });

  it("rejects missing goal", () => {
    const bad = { ...minimalTask, goal: "" };
    const r = validateTaskEnvelope(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("goal"))).toBe(true);
  });

  it("rejects targetExports empty", () => {
    const bad = { ...minimalTask, targetExports: [] };
    const r = validateTaskEnvelope(bad);
    expect(r.ok).toBe(false);
  });

  it("rejects depth > maxDepth", () => {
    const bad = { ...minimalTask, depth: 5, maxDepth: 3 };
    const r = validateTaskEnvelope(bad);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid budgetHint", () => {
    const bad = { ...minimalTask, budgetHint: "weeks" as unknown as TaskEnvelope["budgetHint"] };
    const r = validateTaskEnvelope(bad);
    expect(r.ok).toBe(false);
  });

  it("decode rejects malformed JSON", () => {
    expect(() => decodeTaskEnvelope("not json")).toThrow();
  });

  it("decode rejects JSON that fails validation", () => {
    expect(() => decodeTaskEnvelope(JSON.stringify({ goal: "x" }))).toThrow();
  });
});

describe("ResultEnvelope", () => {
  it("round-trips through encode/decode", () => {
    const json = encodeResultEnvelope(minimalResult);
    const back = decodeResultEnvelope(json);
    expect(back).toEqual(minimalResult);
  });

  it("validates complete status", () => {
    expect(validateResultEnvelope(minimalResult).ok).toBe(true);
  });

  it("rejects unknown status", () => {
    const bad = { ...minimalResult, status: "done" as unknown as ResultEnvelope["status"] };
    expect(validateResultEnvelope(bad).ok).toBe(false);
  });

  it("preserves subResults recursion", () => {
    const nested: ResultEnvelope = {
      ...minimalResult,
      subResults: [minimalResult, { ...minimalResult, status: "failed" }],
    };
    expect(decodeResultEnvelope(encodeResultEnvelope(nested))).toEqual(nested);
  });

  it("rejects negative test counts", () => {
    const bad = {
      ...minimalResult,
      testResults: { passed: -1, failed: 0, skipped: 0, failures: [] },
    };
    expect(validateResultEnvelope(bad).ok).toBe(false);
  });
});
