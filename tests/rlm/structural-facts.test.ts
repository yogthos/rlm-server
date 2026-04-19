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

  it("emits signature/3 facts with argument count", async () => {
    const src = `
export function add(a: number, b: number): number { return a + b; }
export function noop(): void {}
export function triple(x: number, y: number, z: number): number { return x * y * z; }
`;
    const facts = await extractStructuralFacts([{ path: "a.ts", content: src }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toMatch(/signature\(add,\s*'?a\.ts'?,\s*2\)\./);
    expect(pl).toMatch(/signature\(noop,\s*'?a\.ts'?,\s*0\)\./);
    expect(pl).toMatch(/signature\(triple,\s*'?a\.ts'?,\s*3\)\./);
  });

  it("emits call_arity/2 facts from call sites", async () => {
    const src = `
export function a(): number {
  return add(1, 2);
}
export function b(): number {
  return add(3, 4, 5);
}
`;
    const facts = await extractStructuralFacts([{ path: "x.ts", content: src }]);
    const pl = structuralFactsToProlog(facts);
    // Two call sites with different arities are both recorded.
    expect(pl).toMatch(/call_arity\(add,\s*2\)\./);
    expect(pl).toMatch(/call_arity\(add,\s*3\)\./);
  });

  it("exposes signatures + callArities as structured arrays on the facts object", async () => {
    const src = `
export function f(a: number, b: number): number { return a + b; }
export function g(): void { f(1, 2); }
`;
    const facts = await extractStructuralFacts([{ path: "a.ts", content: src }]);
    expect(facts.signatures.some((s) => s.name === "f" && s.argCount === 2)).toBe(true);
    expect(facts.callArities.some((c) => c.callee === "f" && c.argCount === 2)).toBe(true);
  });

  it("emits required_arity/2 distinct from signature/3 total arity (optional params)", async () => {
    const src = `
export function plain(a: number, b: number): number { return a + b; }
export function withOpt(a: number, b?: number): number { return a + (b ?? 0); }
export function withDefault(a: number, b: number = 5): number { return a + b; }
`;
    const facts = await extractStructuralFacts([{ path: "a.ts", content: src }]);
    const pl = structuralFactsToProlog(facts);
    // plain: required = total = 2 (bare atom)
    expect(pl).toMatch(/signature\(plain,\s*'?a\.ts'?,\s*2\)\./);
    expect(pl).toMatch(/required_arity\(plain,\s*2\)\./);
    // withOpt: required = 1, total = 2 (quoted because starts with lowercase
    // but contains uppercase — escapeAtom quotes anything not /^[a-z][a-z0-9_]*$/)
    expect(pl).toMatch(/signature\('?withOpt'?,\s*'?a\.ts'?,\s*2\)\./);
    expect(pl).toMatch(/required_arity\('?withOpt'?,\s*1\)\./);
    // withDefault: required = 1, total = 2
    expect(pl).toMatch(/required_arity\('?withDefault'?,\s*1\)\./);
  });

  it("emits has_rest_param/1 for functions with a rest parameter", async () => {
    const src = `
export function norest(a: number): number { return a; }
export function withrest(a: number, ...rest: number[]): number { return a + rest.length; }
`;
    const facts = await extractStructuralFacts([{ path: "a.ts", content: src }]);
    const pl = structuralFactsToProlog(facts);
    expect(pl).toMatch(/has_rest_param\(withrest\)\./);
    expect(pl).not.toMatch(/has_rest_param\(norest\)\./);
  });

  it("respects explicit entryPoints override", async () => {
    const facts = await extractStructuralFacts([{ path: "a.ts", content: simple }]);
    const pl = structuralFactsToProlog(facts, ["main"]);
    expect(pl).toMatch(/entry_point\(main\)\./);
    expect(pl).not.toMatch(/entry_point\(add\)\./);
  });
});
