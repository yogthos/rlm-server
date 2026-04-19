import { describe, it, expect } from "vitest";
import { validateArtifact } from "../../src/rlm/structural-validator.js";

describe("validateArtifact — fast mode (parse + structural only)", () => {
  it("passes clean TypeScript", async () => {
    const r = await validateArtifact({
      artifact: { "src/a.ts": "export function add(a: number, b: number): number { return a + b; }" },
      mode: "fast",
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it("flags a syntax error as a blocking violation", async () => {
    const r = await validateArtifact({
      artifact: { "src/a.ts": "export function {{{  broken" },
      mode: "fast",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.layer === "parse")).toBe(true);
  });

  it("flags a call cycle as a blocking violation", async () => {
    const src = `
export function a(): number { return b(); }
export function b(): number { return a(); }
`;
    const r = await validateArtifact({
      artifact: { "src/a.ts": src },
      mode: "fast",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /cycle/i.test(v.message))).toBe(true);
  });

  it("flags dead code as advisory, not blocking", async () => {
    const src = `
export function main(): number { return helper(); }
function helper(): number { return 1; }
function orphan(): number { return 42; }
`;
    const r = await validateArtifact({
      artifact: { "src/a.ts": src },
      mode: "fast",
    });
    expect(r.ok).toBe(true);
    expect(r.advisories.some((v) => /orphan/.test(v.message))).toBe(true);
  });

  it("applies an envelope structural contract", async () => {
    const r = await validateArtifact({
      artifact: { "src/a.ts": "export function safe(): number { return 1; }" },
      contract: "forbidden :- function(safe, _, _).",
      mode: "fast",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /forbidden|contract/i.test(v.message))).toBe(true);
  });

  it("returns StructuralError objects with the expected shape", async () => {
    const r = await validateArtifact({
      artifact: { "src/a.ts": "export function {{ broken" },
      mode: "fast",
    });
    const e = r.violations[0];
    expect(e.layer).toBeTruthy();
    expect(e.message).toBeTruthy();
  });
});

describe("validateArtifact — project-files merge", () => {
  it("catches cross-file arity mismatch when projectFiles is passed (full mode)", async () => {
    // File A declares insert with 3 params; file B calls it with 1.
    // Single-file typecheck on B alone would miss this; merged, tsc sees it.
    const r = await validateArtifact({
      artifact: {
        "src/b.ts":
          "import { insert } from './a.js'; export function use() { return insert('handle'); }",
      },
      projectFiles: {
        "src/a.ts":
          "export function insert(handle: string, message: string, ts: number): number { return ts; }",
      },
      mode: "full",
    });
    expect(r.ok).toBe(false);
    expect(
      r.violations.some((v) => v.layer === "typecheck" && /argument/i.test(v.message)),
    ).toBe(true);
  }, 30000);

  it("single-file mode (no projectFiles) cannot see sibling mismatches", async () => {
    const r = await validateArtifact({
      artifact: {
        "src/b.ts":
          "import { insert } from './a.js'; export function use() { return insert('handle'); }",
      },
      mode: "full",
    });
    // Without projectFiles, tsc can't resolve './a.js' at all; typically
    // surfaces a module-not-found rather than an arity error.
    expect(
      r.violations.some((v) => v.layer === "typecheck" && /arity|argument count/i.test(v.message)),
    ).toBe(false);
  }, 30000);
});

describe("validateArtifact — fast mode catches cross-file arity via projectFiles", () => {
  it("flags arity_mismatch without running tsc (no subprocess)", async () => {
    const started = Date.now();
    const r = await validateArtifact({
      artifact: {
        "src/b.ts":
          "import { insert } from './a.js';\nexport function use() { return insert('handle'); }",
      },
      projectFiles: {
        "src/a.ts":
          "export function insert(handle: string, message: string, ts: number): number { return ts; }",
      },
      mode: "fast",
    });
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /arity|insert/i.test(v.message))).toBe(true);
    // Sanity: fast mode should not shell out to tsc (~500ms).
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("validateArtifact — full mode (adds typecheck)", () => {
  it("rejects type errors typecheck would catch", async () => {
    const r = await validateArtifact({
      artifact: {
        "src/a.ts":
          "export function add(a: number, b: number): string { return a + b; }",
      },
      mode: "full",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.layer === "typecheck")).toBe(true);
  }, 30000);
});
