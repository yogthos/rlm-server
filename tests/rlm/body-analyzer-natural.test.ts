import { describe, it, expect, beforeAll } from "vitest";
import {
  analyzeSource,
  type NaturalAnalysis,
} from "../../src/rlm/body-analyzer.js";
import { initTreeSitter } from "../../src/rlm/vendor/pi-code-graph/tree-sitter/index.js";

// Tree-sitter needs one async init per process. The analyzer does this
// internally, but warming it up in beforeAll keeps the first test
// timing consistent with the rest.
beforeAll(async () => {
  await initTreeSitter();
});

describe("analyzeSource — natural-style import extraction", () => {
  it("returns empty imports + callees for a bare export", async () => {
    const src = `export default function foo() { return 1; }`;
    const got: NaturalAnalysis = await analyzeSource(src);
    expect(got.imports).toEqual([]);
    expect(got.callees).toEqual([]);
  });

  it("picks up a default import", async () => {
    const src = [
      `import bar from "./bar.js";`,
      `export default function foo() { return bar(1); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.imports).toEqual([
      { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
    ]);
    expect(got.callees).toEqual(["bar"]);
  });

  it("picks up named imports", async () => {
    const src = [
      `import { a, b as renamed } from "./x.js";`,
      `export default function foo() { return a() + renamed(); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.imports).toEqual([
      { source: "./x.js", name: "a", isDefault: false, line: 1 },
      { source: "./x.js", name: "renamed", isDefault: false, line: 1 },
    ]);
    expect(got.callees.sort()).toEqual(["a", "renamed"]);
  });

  it("skips import type declarations (type-only, not runtime deps)", async () => {
    const src = [
      `import type { Ctx } from "./ctx.js";`,
      `import bar from "./bar.js";`,
      `export default function foo(c: Ctx) { return bar(c); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.imports).toEqual([
      { source: "./bar.js", name: "bar", isDefault: true, line: 2 },
    ]);
  });

  it("skips named imports marked `type`", async () => {
    const src = [
      `import { type T, real } from "./x.js";`,
      `export default function foo() { return real(); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    // Only `real` — the `type T` named-specifier is type-only.
    expect(got.imports).toEqual([
      { source: "./x.js", name: "real", isDefault: false, line: 1 },
    ]);
  });

  it("captures namespace imports with isDefault=false and name=*", async () => {
    const src = [
      `import * as fs from "node:fs";`,
      `export default function foo() { fs.readFileSync("/x"); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.imports).toEqual([
      { source: "node:fs", name: "fs", isDefault: false, line: 1 },
    ]);
  });

  it("dedupes call sites on the same function", async () => {
    const src = [
      `import bar from "./bar.js";`,
      `export default function foo() {`,
      `  bar(1);`,
      `  bar(2);`,
      `  bar(3);`,
      `}`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.callees).toEqual(["bar"]);
  });

  it("returns bare-identifier calls (direct imports) but not member calls (fs.readFile)", async () => {
    const src = [
      `import * as fs from "node:fs";`,
      `import bar from "./bar.js";`,
      `export default function foo() {`,
      `  fs.readFileSync("/x");`,
      `  bar();`,
      `}`,
    ].join("\n");
    const got = await analyzeSource(src);
    // `fs.readFileSync` is a member call — that's a namespace use, not
    // a sibling invocation we'd track as a call edge. `bar` IS.
    expect(got.callees).toEqual(["bar"]);
  });

  it("excludes built-in globals (console, Math, Object) from callees", async () => {
    const src = [
      `export default function foo() {`,
      `  console.log("x");`,
      `  Math.max(1, 2);`,
      `  const o = Object.assign({}, {});`,
      `  JSON.stringify({});`,
      `}`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.callees).toEqual([]);
  });

  it("handles mixed default + named imports", async () => {
    const src = [
      `import bar, { helper } from "./bar.js";`,
      `export default function foo() { return bar() + helper(); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.imports).toEqual([
      { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
      { source: "./bar.js", name: "helper", isDefault: false, line: 1 },
    ]);
    expect(got.callees).toEqual(["bar", "helper"]);
  });

  it("sorts callees for stable output", async () => {
    const src = [
      `import a from "./a.js";`,
      `import z from "./z.js";`,
      `import m from "./m.js";`,
      `export default function foo() { z(); a(); m(); }`,
    ].join("\n");
    const got = await analyzeSource(src);
    expect(got.callees).toEqual(["a", "m", "z"]);
  });
});
