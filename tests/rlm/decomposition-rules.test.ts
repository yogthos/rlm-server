import { describe, it, expect } from "vitest";
import {
  renderDecompositionRules,
  renderDecompositionHints,
} from "../../src/rlm/decomposition-rules.js";

describe("renderDecompositionRules — shared text", () => {
  const block = renderDecompositionRules().join("\n");

  it("includes the triviality gate", () => {
    expect(block).toMatch(/triviality gate/i);
    expect(block).toMatch(/ONE function/);
  });

  it("includes the size-anchor ladder", () => {
    expect(block).toMatch(/single workflow.*2.3 functions/i);
    expect(block).toMatch(/small app.*4.6 functions/i);
    expect(block).toMatch(/max\s*~8/i);
  });

  it("includes the FORBIDDEN name prefixes — the full set", () => {
    // Every decomposition site must reject these same prefixes.
    for (const prefix of ["run", "test", "validate", "verify", "check", "demo", "main"]) {
      expect(block).toContain(`\`${prefix}\``);
    }
  });

  it("tells the model not to plan a test-runner function", () => {
    expect(block).toMatch(/DO NOT create a function for those tests/i);
  });
});

describe("renderDecompositionHints — short form for binary gates", () => {
  const block = renderDecompositionHints().join("\n");

  it("keeps the triviality bias and forbidden list", () => {
    expect(block).toMatch(/triviality bias/i);
    for (const prefix of ["run", "test", "validate", "verify", "check", "demo", "main"]) {
      expect(block).toContain(prefix);
    }
  });

  it("is shorter than the full rules (for yes/no prompts)", () => {
    expect(block.length).toBeLessThan(renderDecompositionRules().join("\n").length);
  });
});

describe("decomposition rules are wired into every decomposition site", () => {
  // Ensures a future refactor doesn't disconnect one of the
  // decomposition decision points from the shared rules.
  // The legacy in-dispatch IMPLEMENT-vs-DECOMPOSE gate moved out when
  // the tool-use agent replaced the single-shot dispatcher; decomposition
  // is now driven entirely by the outer leaf-up + reflect flow.
  const sites = [
    "src/rlm/design-plan.ts",      // phase-1 top-level + parent split
    "src/rlm/design-reflect.ts",   // reflect decompose choice
  ];

  for (const path of sites) {
    it(`${path} imports the shared rules`, async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(path, "utf8");
      expect(src).toMatch(/from\s+"\.\/decomposition-rules\.js"/);
    });
  }
});
