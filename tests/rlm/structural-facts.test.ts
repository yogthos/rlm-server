import { describe, it, expect } from "vitest";
import {
  extractStructuralFacts,
  structuralFactsToProlog,
} from "../../src/rlm/structural-facts.js";

const simple = `
export function add(a: number, b: number): number {
  return a + b;
}
`;

const branchy = `
export function classify(n: number): string {
  if (n < 0) return "neg";
  if (n === 0) return "zero";
  if (n % 2 === 0) return "even";
  return "odd";
}
`;

const nested = `
export function deep(xs: number[]): number {
  let total = 0;
  for (const x of xs) {
    if (x > 0) {
      for (const y of xs) {
        if (y > x) {
          total += 1;
        }
      }
    }
  }
  return total;
}
`;

const withImport = `
import { add } from "./math.js";
export function sum3(a: number, b: number, c: number): number {
  return add(add(a, b), c);
}
`;

describe("extractStructuralFacts", () => {
  it("extracts a single function with cyclomatic=1", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    expect(facts.complexity).toHaveLength(1);
    const add = facts.complexity[0];
    expect(add.name).toBe("add");
    expect(add.file).toBe("a.ts");
    expect(add.cyclomatic).toBe(1);
    expect(add.nesting).toBeGreaterThanOrEqual(0);
    expect(add.bodyLines).toBeGreaterThan(0);
  });

  it("counts decision points for cyclomatic complexity", async () => {
    const facts = await extractStructuralFacts([{ path: "b.ts", content: branchy }]);
    const classify = facts.complexity.find((c) => c.name === "classify");
    expect(classify).toBeDefined();
    // 3 if statements + 1 base path = 4
    expect(classify!.cyclomatic).toBe(4);
  });

  it("computes nesting depth", async () => {
    const facts = await extractStructuralFacts([{ path: "c.ts", content: nested }]);
    const deep = facts.complexity.find((c) => c.name === "deep");
    expect(deep).toBeDefined();
    // for → if → for → if => at least 4 nesting levels
    expect(deep!.nesting).toBeGreaterThanOrEqual(4);
  });

  it("reuses existing graph facts (defines/calls/imports/exports)", async () => {
    const facts = await extractStructuralFacts([{ path: "d.ts", content: withImport }]);
    const names = facts.graph.defines.map((d) => d.name);
    expect(names).toContain("sum3");
    const callNames = facts.graph.calls.map((c) => c.callee);
    expect(callNames).toContain("add");
    const importNames = facts.graph.imports.map((i) => i.name);
    expect(importNames).toContain("add");
    const exportNames = facts.graph.exports.map((e) => e.name);
    expect(exportNames).toContain("sum3");
  });

  it("handles multiple files", async () => {
    const facts = await extractStructuralFacts([
      { path: "a.ts", content: simple },
      { path: "b.ts", content: branchy },
    ]);
    const names = facts.complexity.map((c) => c.name);
    expect(names).toContain("add");
    expect(names).toContain("classify");
  });
});

describe("structuralFactsToProlog", () => {
  it("emits cyclomatic/2, body_lines/2, nesting/2 facts", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: branchy }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toMatch(/cyclomatic\(classify,\s*4\)\./);
    expect(pl).toMatch(/body_lines\(classify,\s*\d+\)\./);
    expect(pl).toMatch(/nesting\(classify,\s*\d+\)\./);
  });

  it("emits entry_point for exports when not specified", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toMatch(/entry_point\(add\)\./);
  });

  it("emits function/3 facts for declared functions", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toMatch(/function\(add,/);
  });

  it("declares dynamic predicates for all fact families", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toContain(":- dynamic(cyclomatic/2).");
    expect(pl).toContain(":- dynamic(body_lines/2).");
    expect(pl).toContain(":- dynamic(nesting/2).");
    expect(pl).toContain(":- dynamic(function/3).");
    expect(pl).toContain(":- dynamic(entry_point/1).");
  });

  it("respects explicit entryPoints override", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    const pl = structuralFactsToProlog(facts, ["main"]);
    expect(pl).toMatch(/entry_point\(main\)\./);
    expect(pl).not.toMatch(/entry_point\(add\)\./);
  });
});
