import { describe, it, expect } from "vitest";
import { enforce } from "../../src/rlm/enforcement.js";
import type { TestContract } from "../../src/rlm/envelopes.js";

const emptyTests: TestContract = { framework: "vitest", files: {} };

describe("enforce orchestration", () => {
  it("returns a report with all five layers", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export const x = 1;" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test"],
    });
    expect(report.layers).toHaveProperty("parse");
    expect(report.layers).toHaveProperty("typecheck");
    expect(report.layers).toHaveProperty("structural");
    expect(report.layers).toHaveProperty("lint");
    expect(report.layers).toHaveProperty("test");
  });

  it("marks skipped layers explicitly", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export const x = 1;" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.typecheck.status).toBe("skipped");
    expect(report.layers.test.status).toBe("skipped");
    expect(report.layers.lint.status).toBe("skipped");
  });
});

describe("parse layer", () => {
  it("passes on syntactically valid TS", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export const x: number = 1;" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.parse.status).toBe("pass");
    expect(report.layers.parse.errors).toHaveLength(0);
  });

  it("fails on syntactically invalid TS", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export const = ;;;\nfunction {{" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.parse.status).toBe("fail");
    expect(report.layers.parse.errors.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it("short-circuits later layers when parse fails", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export function {{{" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.parse.status).toBe("fail");
    expect(report.layers.structural.status).toBe("skipped");
  });
});

describe("structural layer", () => {
  it("passes when no blocking violations", async () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.structural.status).toBe("pass");
  });

  it("fails on call_cycle (blocking)", async () => {
    const src = `
export function a(): number { return b(); }
export function b(): number { return a(); }
`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.structural.status).toBe("fail");
    expect(
      report.layers.structural.errors.some(
        (e) => e.severity === "blocking" && /cycle/i.test(e.message),
      ),
    ).toBe(true);
  });

  it("fails on extreme complexity (cyclomatic > 15)", async () => {
    const ifs = Array.from({ length: 20 }, (_, i) => `  if (n === ${i}) return ${i};`).join("\n");
    const src = `export function big(n: number): number {\n${ifs}\n  return -1;\n}`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.structural.status).toBe("fail");
    expect(
      report.layers.structural.errors.some(
        (e) => e.severity === "blocking" && /complexity/i.test(e.message),
      ),
    ).toBe(true);
  });

  it("reports advisory-only violations without failing", async () => {
    // dead_code is advisory
    const src = `
export function main(): number { return helper(); }
function helper(): number { return 1; }
function orphan(): number { return 42; }
`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.layers.structural.status).toBe("pass");
    expect(
      report.layers.structural.errors.some(
        (e) => e.severity === "advisory" && /orphan/.test(e.message),
      ),
    ).toBe(true);
  });

  it("applies per-envelope structural contract", async () => {
    const src = `export function safe(): number { return 1; }`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      structuralContract: `forbidden :- function(safe, _, _).`,
      skipLayers: ["typecheck", "test", "lint"],
    });
    // The contract asserts `forbidden` whenever safe/0 exists — should fail.
    expect(report.layers.structural.status).toBe("fail");
    expect(
      report.layers.structural.errors.some((e) => /forbidden|contract/i.test(e.message)),
    ).toBe(true);
  });
});

describe("typecheck layer", () => {
  it("passes on well-typed TS", async () => {
    const report = await enforce({
      artifact: {
        "src/a.ts": "export function add(a: number, b: number): number { return a + b; }",
      },
      tests: emptyTests,
      skipLayers: ["test", "lint"],
    });
    expect(report.layers.typecheck.status).toBe("pass");
    expect(report.layers.typecheck.errors).toHaveLength(0);
  }, 30000);

  it("fails on type errors", async () => {
    const report = await enforce({
      artifact: {
        "src/a.ts": "export function add(a: number, b: number): string { return a + b; }",
      },
      tests: emptyTests,
      skipLayers: ["test", "lint"],
    });
    expect(report.layers.typecheck.status).toBe("fail");
    expect(report.layers.typecheck.errors.length).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  }, 30000);
});

describe("input validation", () => {
  it("throws on file-path collision between artifact and tests.files", async () => {
    await expect(
      enforce({
        artifact: { "src/a.ts": "export const x = 1;" },
        tests: {
          framework: "vitest",
          files: { "src/a.ts": "// conflicts with artifact" },
        },
        skipLayers: ["test", "lint", "typecheck", "structural", "parse"],
      }),
    ).rejects.toThrow(/collision|conflict/i);
  });
});

describe("typecheck isolation", () => {
  it("resolves @types/node regardless of process.cwd()", async () => {
    const original = process.cwd();
    try {
      process.chdir("/tmp");
      const report = await enforce({
        artifact: {
          // Uses node globals — typechecks only if @types/node is found.
          "src/a.ts": "export const pathVar: string | undefined = process.env.PATH;",
        },
        tests: emptyTests,
        skipLayers: ["test", "lint"],
      });
      expect(report.layers.typecheck.status).toBe("pass");
    } finally {
      process.chdir(original);
    }
  }, 30000);
});

describe("report.ok", () => {
  it("is true when no blocking layer fails", async () => {
    const report = await enforce({
      artifact: { "src/a.ts": "export const x = 1;" },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.ok).toBe(true);
  });

  it("is false when any blocking layer fails", async () => {
    const src = `
export function a(): number { return b(); }
export function b(): number { return a(); }
`;
    const report = await enforce({
      artifact: { "src/a.ts": src },
      tests: emptyTests,
      skipLayers: ["typecheck", "test", "lint"],
    });
    expect(report.ok).toBe(false);
  });
});
