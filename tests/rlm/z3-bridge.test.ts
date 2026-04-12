import { describe, it, expect } from "vitest";
import { z3Solve, prepareSmtlib, Z3_IMPL } from "../../src/rlm/z3-bridge.js";

describe("prepareSmtlib", () => {
  it("injects default timeout", () => {
    const result = prepareSmtlib("(declare-const x Int)");
    expect(result).toContain("(set-option :timeout");
    expect(result).toContain("(declare-const x Int)");
  });

  it("preserves existing timeout", () => {
    const input = "(set-option :timeout 5000)\n(declare-const x Int)";
    const result = prepareSmtlib(input);
    expect(result).toContain(":timeout 5000");
  });

  it("strips check-sat and get-model", () => {
    const input =
      "(declare-const x Int)\n(assert (> x 5))\n(check-sat)\n(get-model)";
    const result = prepareSmtlib(input);
    expect(result).not.toContain("check-sat");
    expect(result).not.toContain("get-model");
    expect(result).toContain("(declare-const x Int)");
  });
});

describe("z3Solve", () => {
  it(
    "solves a satisfiable problem",
    async () => {
      const result = await z3Solve(
        "(declare-const x Int)\n(assert (> x 5))\n(assert (< x 10))",
      );
      expect(result.status).toBe("sat");
      expect(result.model).toBeDefined();
      expect(result.model!.x).toBeDefined();
      const x = parseInt(result.model!.x, 10);
      expect(x).toBeGreaterThan(5);
      expect(x).toBeLessThan(10);
    },
    60_000,
  );

  it(
    "detects unsatisfiable problems",
    async () => {
      const result = await z3Solve(
        "(declare-const x Int)\n(assert (> x 10))\n(assert (< x 5))",
      );
      expect(result.status).toBe("unsat");
    },
    60_000,
  );

  it(
    "returns error for invalid SMT-LIB",
    async () => {
      const result = await z3Solve("(this is not valid smtlib");
      expect(result.status).toBe("error");
      expect(result.error).toBeDefined();
    },
    60_000,
  );
});

describe("Z3_IMPL", () => {
  it("defines the z3 function", () => {
    expect(Z3_IMPL).toContain("async function z3");
    expect(Z3_IMPL).toContain("__z3Bridge");
  });
});
