import { describe, it, expect } from "vitest";
import {
  fixTier,
  buildFixPrompt,
  type FixContext,
  type StructuralError,
} from "../../src/rlm/fix-prompts.js";

const sampleCtx: FixContext = {
  attempt: 1,
  maxAttempts: 3,
  targetModule: "src/a.ts",
  targetExports: ["add", "mul"],
  currentCode: "export function add(a, b) { return a + b; }",
  errors: [
    { layer: "typecheck", message: "Parameter 'a' implicitly has an 'any' type.", file: "src/a.ts", line: 1 },
    { layer: "structural", message: "missing export 'mul'" },
  ],
  spec: "Implement add and mul with typed parameters.",
};

describe("fixTier", () => {
  it("attempt 1 → standard", () => {
    expect(fixTier(1, 3)).toBe("standard");
  });

  it("attempt 2 → narrowed", () => {
    expect(fixTier(2, 3)).toBe("narrowed");
  });

  it("attempt 3 → fresh", () => {
    expect(fixTier(3, 3)).toBe("fresh");
  });

  it("attempts past max → fresh", () => {
    expect(fixTier(5, 3)).toBe("fresh");
  });
});

describe("buildFixPrompt — standard (attempt 1)", () => {
  it("includes full context: code, errors, spec, target", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 1 });
    expect(p).toContain("src/a.ts");
    expect(p).toContain("export function add");
    expect(p).toContain("implicitly has an 'any'");
    expect(p).toContain("missing export 'mul'");
    expect(p).toContain("add");
    expect(p).toContain("mul");
    expect(p.toLowerCase()).toMatch(/fix|correct/);
  });

  it("mentions the attempt number", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 1, maxAttempts: 3 });
    expect(p).toMatch(/attempt\s*1/i);
    expect(p).toMatch(/3/);
  });
});

describe("buildFixPrompt — narrowed (attempt 2)", () => {
  it("focuses on the first failing error, not all of them", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 2 });
    expect(p).toContain("Parameter 'a' implicitly has an 'any' type");
    // Does NOT include the later error in the focused prompt body
    // (but may mention in total-count summary).
    const firstErrIdx = p.indexOf("Parameter 'a'");
    const secondErrIdx = p.indexOf("missing export 'mul'");
    // Narrowed prompts elide additional errors from the focused section.
    expect(secondErrIdx).toBe(-1);
    expect(firstErrIdx).toBeGreaterThanOrEqual(0);
  });

  it("includes a step-by-step trace guidance block", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 2 });
    expect(p.toLowerCase()).toMatch(/step.*step|trace/);
    expect(p).toMatch(/1\.|input/i);
    expect(p).toMatch(/2\./i);
    expect(p).toMatch(/3\./i);
  });
});

describe("buildFixPrompt — fresh (attempt 3)", () => {
  it("asks the model to discard its previous approach", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 3 });
    expect(p.toLowerCase()).toMatch(/discard|scratch|clean slate/);
  });

  it("does NOT include the previous implementation code", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 3 });
    expect(p).not.toContain("export function add(a, b) { return a + b; }");
  });

  it("still shows the most recent errors as what went wrong", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 3 });
    expect(p).toContain("Parameter 'a' implicitly has an 'any' type");
  });
});

describe("buildFixPrompt — always", () => {
  it("states the required exports and target module", () => {
    const p = buildFixPrompt({ ...sampleCtx, attempt: 1 });
    expect(p).toContain("src/a.ts");
    expect(p).toMatch(/add/);
    expect(p).toMatch(/mul/);
  });

  it("handles an empty errors list gracefully", () => {
    const empty: FixContext = { ...sampleCtx, errors: [] };
    expect(() => buildFixPrompt(empty)).not.toThrow();
  });

  it("handles a StructuralError without file/line", () => {
    const ctx: FixContext = {
      ...sampleCtx,
      errors: [{ layer: "structural", message: "call_cycle: a,b,a" } as StructuralError],
    };
    const p = buildFixPrompt(ctx);
    expect(p).toContain("call_cycle: a,b,a");
  });
});
