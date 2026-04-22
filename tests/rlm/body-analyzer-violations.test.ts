import { describe, it, expect, beforeAll } from "vitest";
import { collectNaturalViolations } from "../../src/rlm/body-analyzer.js";
import { initTreeSitter } from "../../src/rlm/vendor/pi-code-graph/tree-sitter/index.js";

beforeAll(async () => {
  await initTreeSitter();
});

describe("collectNaturalViolations (Phase N4)", () => {
  it("accepts a simple leaf function with no imports", async () => {
    const source = `export default function foo(a: number): number { return a + 1; }`;
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["foo"]),
    });
    expect(violations).toEqual([]);
  });

  it("accepts a direct sibling import when the sibling exists", async () => {
    const source = [
      `import bar from "./bar.js";`,
      `export default function foo(a: number): number { return bar(a); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["foo", "bar"]),
    });
    expect(violations).toEqual([]);
  });

  it("accepts external imports (node: built-ins, packages)", async () => {
    const source = [
      `import * as http from "node:http";`,
      `import express from "express";`,
      `export default function foo(): void { http.createServer(); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["foo"]),
    });
    expect(violations).toEqual([]);
  });

  it("rejects a relative import to a module that ISN'T a known sibling", async () => {
    // Run 15's phantom-types-import: model wrote `import ... from "./types.js"`
    // even though no `types` function/module exists. Catch it here.
    const source = [
      `import type { T } from "./types.js";`,
      `import bar from "./bar.js";`,
      `export default function foo(): number { return bar(); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["foo", "bar"]),
    });
    expect(violations.length).toBeGreaterThan(0);
    const joined = violations.join("\n");
    expect(joined).toMatch(/types\.js/);
    expect(joined).toMatch(/unknown|not.*graph|phantom/i);
  });

  it("does NOT reject scoped/package imports even when they start with a dot-like shape", async () => {
    const source = [
      `import lodash from "lodash";`,
      `import { foo } from "@scope/pkg";`,
      `export default function bar(): void { lodash.noop(); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["bar"]),
    });
    expect(violations).toEqual([]);
  });

  it("reports every unknown sibling import, not just the first", async () => {
    const source = [
      `import a from "./a.js";`,
      `import b from "./b.js";`,
      `import c from "./c.js";`,
      `export default function foo(): number { return a() + b() + c(); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["foo", "b"]),
    });
    // a and c are not known; b is known.
    const joined = violations.join("\n");
    expect(joined).toMatch(/a\.js/);
    expect(joined).toMatch(/c\.js/);
    expect(joined).not.toMatch(/b\.js/);
  });

  it("flags required-children that the body neither imports nor calls", async () => {
    const source = [
      `import partial from "./partial.js";`,
      `export default function parent(): void { partial(); }`,
    ].join("\n");
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["parent", "partial", "missing"]),
      requiredChildren: ["partial", "missing"],
    });
    // `missing` isn't imported/called.
    const joined = violations.join("\n");
    expect(joined).toMatch(/missing/);
    expect(joined).not.toMatch(/Unreachable:\s*partial/); // partial IS called
  });

  it("allows required children reached transitively through another sibling's imports", async () => {
    // Body directly calls only `builder`. `builder` in turn calls
    // `form` and `row` — so they're transitively reachable. This
    // requires a graph lookup; the caller passes a resolver.
    const source = [
      `import builder from "./builder.js";`,
      `export default function parent(): void { builder(); }`,
    ].join("\n");
    // Simulate the graph: builder's analyzed callees include form + row.
    const resolveCallees = (name: string): string[] => {
      if (name === "builder") return ["form", "row"];
      return [];
    };
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set(["parent", "builder", "form", "row"]),
      requiredChildren: ["builder", "form", "row"],
      resolveCallees,
    });
    expect(violations).toEqual([]);
  });

  it("returns empty when source is unparseable (don't block on analyzer failure)", async () => {
    // Malformed but not empty — we don't want the analyzer crashing to
    // block the dispatch; let tsc surface the real problem.
    const source = `this is not valid typescript { { {`;
    const violations = await collectNaturalViolations({
      source,
      knownSiblings: new Set([]),
    });
    // No assertion on length — just that it doesn't throw.
    expect(Array.isArray(violations)).toBe(true);
  });
});
