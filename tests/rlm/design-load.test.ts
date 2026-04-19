import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { parseExports, designLoad } from "../../src/rlm/design-load.js";

describe("parseExports", () => {
  it("extracts a simple export function", () => {
    const src = `export function add(a, b) {\n  return a + b;\n}`;
    const fns = parseExports(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("add");
    expect(fns[0].body).toBe("return a + b;");
    expect(fns[0].signature.params).toHaveLength(2);
  });

  it("extracts TS-typed export function with return type", () => {
    const src = `export function add(a: number, b: number): number {\n  return a + b;\n}`;
    const fns = parseExports(src);
    expect(fns[0].signature.params[0]).toEqual({
      name: "a",
      type: "number",
      optional: false,
    });
    expect(fns[0].signature.returnType).toBe("number");
  });

  it("handles async functions", () => {
    const src = `export async function fetch(u: string): Promise<string> {\n  return "";\n}`;
    const fns = parseExports(src);
    expect(fns[0].signature.isAsync).toBe(true);
    expect(fns[0].signature.returnType).toBe("Promise<string>");
  });

  it("handles optional and default params", () => {
    const src = `export function f(a?: string, b: number = 3) {\n  return a;\n}`;
    const fns = parseExports(src);
    expect(fns[0].signature.params[0].optional).toBe(true);
    expect(fns[0].signature.params[1].defaultValue).toBe("3");
  });

  it("finds multiple exports", () => {
    const src = `
      export function a() { return 1; }
      export function b(x: string): boolean { return true; }
    `;
    const fns = parseExports(src);
    expect(fns.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("respects nested braces in function bodies", () => {
    const src = `export function f() {\n  const o = { k: { n: 1 } };\n  return o;\n}`;
    const fns = parseExports(src);
    expect(fns[0].body).toContain("const o = { k: { n: 1 } };");
  });

  it("ignores non-exported functions", () => {
    const src = `function hidden() { return 1; }\nexport function shown() { return 2; }`;
    const fns = parseExports(src);
    expect(fns.map((f) => f.name)).toEqual(["shown"]);
  });
});

describe("parseExports (proc-ts)", () => {
  it("reads `export default function name(ctx: Ctx, ...)` and strips the ctx param", () => {
    const src = `export default function add(ctx: Ctx, a: number, b: number): number {\n  return a + b;\n}`;
    const fns = parseExports(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("add");
    // Business-logic params only — `ctx: Ctx` has been stripped.
    expect(fns[0].signature.params).toEqual([
      { name: "a", type: "number", optional: false },
      { name: "b", type: "number", optional: false },
    ]);
    expect(fns[0].body).toBe("return a + b;");
  });

  it("handles a ctx-only function", () => {
    const src = `export default function start(ctx: Ctx): void {\n  return;\n}`;
    const fns = parseExports(src);
    expect(fns[0].signature.params).toEqual([]);
  });
});

describe("designLoad (proc-ts)", () => {
  it("loads a single proc-ts file into the graph", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "add.ts"),
        `export default function add(ctx: Ctx, a: number, b: number): number {\n  return a + b;\n}`,
        "utf8",
      );
      const g = createDesignGraph();
      const reports = await designLoad(g, "add.ts", { cwd: dir });
      expect(reports).toHaveLength(1);
      expect(reports[0].functions).toEqual(["add"]);
      const fn = g.getFunction("add.ts", "add");
      expect(fn?.implementation).toBe("return a + b;");
      expect(fn?.signature.params).toHaveLength(2); // ctx stripped
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips the ctx param regardless of its annotated type", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "foo.ts"),
        `export default function foo(ctx: AppCtx, x: string): string {\n  return x;\n}`,
        "utf8",
      );
      const g = createDesignGraph();
      await designLoad(g, "foo.ts", { cwd: dir });
      const fn = g.getFunction("foo.ts", "foo")!;
      expect(fn.signature.params).toHaveLength(1);
      expect(fn.signature.params[0].name).toBe("x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips *.d.ts files when loading a directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "add.ts"),
        `export default function add(ctx: Ctx): number { return 1; }`,
        "utf8",
      );
      await writeFile(
        path.join(dir, "types.d.ts"),
        `export interface Foo { x: number; }`,
        "utf8",
      );
      const g = createDesignGraph();
      const reports = await designLoad(g, ".", { cwd: dir });
      const paths = reports.map((r) => r.path);
      expect(paths).not.toContain("types.d.ts");
      expect(paths.some((p) => p.endsWith("add.ts"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces duplicate function names across files in skipped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "foo.ts"),
        `export default function foo(ctx: Ctx): void { return; }`,
        "utf8",
      );
      await writeFile(
        path.join(dir, "bar.ts"),
        // Same name — addFunction rejects under proc-ts global-unique rule.
        `export default function foo(ctx: Ctx): void { return; }`,
        "utf8",
      );
      const g = createDesignGraph();
      const reports = await designLoad(g, ".", { cwd: dir });
      const skipped = reports.flatMap((r) => r.skipped);
      expect(skipped).toContain("foo");
      expect(g.listFunctions()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates an already-declared function's body without duplicating", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "foo.ts"),
        `export default function foo(ctx: Ctx) {\n  return 99;\n}`,
        "utf8",
      );
      const g = createDesignGraph();
      g.addFunction("foo.ts", "foo", { params: [], returnType: "number" });
      await designLoad(g, "foo.ts", { cwd: dir });
      expect(g.getFunction("foo.ts", "foo")?.implementation).toBe("return 99;");
      expect(g.listFunctions()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads an entire proc-ts project directory, skipping ctx.ts / *.test.ts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rlm-load-"));
    try {
      await writeFile(
        path.join(dir, "add.ts"),
        `export default function add(ctx: Ctx, a: number, b: number): number {\n  return a + b;\n}`,
        "utf8",
      );
      await writeFile(
        path.join(dir, "sub.ts"),
        `export default function sub(ctx: Ctx, a: number, b: number): number {\n  return a - b;\n}`,
        "utf8",
      );
      // These should be skipped:
      await writeFile(path.join(dir, "ctx.ts"), `/* ctx types */`, "utf8");
      await writeFile(
        path.join(dir, "ctx_fns.d.ts"),
        `export default interface CtxFns {}`,
        "utf8",
      );
      await writeFile(
        path.join(dir, "add.test.ts"),
        `/* test */`,
        "utf8",
      );
      const g = createDesignGraph();
      const reports = await designLoad(g, ".", { cwd: dir });
      const loaded = reports
        .map((r) => r.path)
        .filter((p) => p.endsWith(".ts"));
      expect(loaded).toEqual(expect.arrayContaining(["add.ts", "sub.ts"]));
      expect(loaded).not.toContain("ctx.ts");
      expect(loaded).not.toContain("ctx_fns.d.ts");
      expect(loaded).not.toContain("add.test.ts");
      expect(g.getFunction("add.ts", "add")).toBeDefined();
      expect(g.getFunction("sub.ts", "sub")).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
