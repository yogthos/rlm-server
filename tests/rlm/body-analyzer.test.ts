import { describe, it, expect } from "vitest";
import { analyzeBody } from "../../src/rlm/body-analyzer.js";

describe("analyzeBody — ctx.fns call extraction", () => {
  it("returns empty findings for a trivial return", async () => {
    const r = await analyzeBody("return 1;");
    expect(r.ctxFnsCalls).toEqual([]);
    expect(r.imports).toEqual([]);
    expect(r.hasAwait).toBe(false);
  });

  it("extracts a single ctx.fns.<name> call", async () => {
    const r = await analyzeBody("return ctx.fns.foo(ctx);");
    expect(r.ctxFnsCalls.map((c) => c.name)).toEqual(["foo"]);
  });

  it("extracts multiple ctx.fns calls and preserves order", async () => {
    const r = await analyzeBody(
      "const x = ctx.fns.a(ctx);\nreturn ctx.fns.b(ctx, x);",
    );
    expect(r.ctxFnsCalls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("extracts nested ctx.fns calls (inner arg)", async () => {
    const r = await analyzeBody("return ctx.fns.a(ctx, ctx.fns.b(ctx));");
    expect(r.ctxFnsCalls.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("ignores non-ctx.fns calls (console, Math, etc.)", async () => {
    const r = await analyzeBody(
      "console.log('x');\nconst y = Math.round(1.5);\nreturn y;",
    );
    expect(r.ctxFnsCalls).toEqual([]);
  });

  it("ignores calls that look similar but aren't ctx.fns (ctx.state.foo() or fns.x())", async () => {
    const r = await analyzeBody(
      "ctx.state.foo();\nfns.x();\nreturn 1;",
    );
    expect(r.ctxFnsCalls).toEqual([]);
  });
});

describe("analyzeBody — import detection", () => {
  it("detects a top-level import statement with source + line number", async () => {
    const r = await analyzeBody("import fs from 'node:fs';\nreturn 1;");
    expect(r.imports).toEqual([{ source: "node:fs", line: 1 }]);
  });

  it("detects multiple imports with line numbers", async () => {
    const r = await analyzeBody(
      "import fs from 'node:fs';\nimport path from 'node:path';\nreturn 1;",
    );
    expect(r.imports).toEqual([
      { source: "node:fs", line: 1 },
      { source: "node:path", line: 2 },
    ]);
  });

  it("does NOT flag dynamic `await import(...)` or `require(...)`", async () => {
    // proc-ts allows these — they're the sanctioned way to bring in
    // external modules inside a body.
    const r = await analyzeBody(
      "const fs = await import('node:fs');\nreturn 1;",
    );
    expect(r.imports).toEqual([]);
  });
});

describe("analyzeBody — await detection", () => {
  it("flags hasAwait when the body uses await", async () => {
    const r = await analyzeBody("const x = await ctx.fns.load(ctx);\nreturn x;");
    expect(r.hasAwait).toBe(true);
    expect(r.ctxFnsCalls.map((c) => c.name)).toEqual(["load"]);
  });

  it("hasAwait false for a synchronous body", async () => {
    const r = await analyzeBody("return ctx.fns.double(ctx, 2);");
    expect(r.hasAwait).toBe(false);
  });
});

describe("analyzeBody — call-site line numbers", () => {
  it("records 1-based line numbers for each call", async () => {
    const r = await analyzeBody(
      ["const a = ctx.fns.first(ctx);", "// comment", "return ctx.fns.second(ctx);"].join("\n"),
    );
    expect(r.ctxFnsCalls).toEqual([
      { name: "first", line: 1 },
      { name: "second", line: 3 },
    ]);
  });
});
