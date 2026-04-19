import { describe, it, expect } from "vitest";
import { extractCode } from "../../src/rlm/code-extractor.js";
import { renderFileSet } from "../../src/rlm/final-files.js";

describe("extractCode FINAL_FILES directive", () => {
  it("captures the variable name", () => {
    const r = extractCode("Here is the project.\nFINAL_FILES(files)");
    expect(r.finalFiles).toBe("files");
  });

  it("captures the handle form", () => {
    const r = extractCode("FINAL_FILES($files)");
    expect(r.finalFiles).toBe("files");
  });

  it("does not capture FINAL_FILES inside code blocks", () => {
    const r = extractCode(
      "```repl\nFINAL_FILES(files)\n```\nSome reasoning.",
    );
    expect(r.finalFiles).toBeNull();
  });

  it("FINAL_FILES takes precedence over FINAL_VAR and FINAL when all present", () => {
    const r = extractCode(
      "FINAL_FILES(files)\nFINAL_VAR(x)\nFINAL(plain text)",
    );
    expect(r.finalFiles).toBe("files");
  });

  it("flags FINAL_FILES with an inline object literal as anti-pattern", () => {
    const r = extractCode('FINAL_FILES({ "src/a.ts": "..." })');
    expect(r.finalFiles).toBeNull();
    expect(r.finalFilesInline).toBe(true);
  });

  it("flags FINAL_FILES with an inline string as anti-pattern", () => {
    const r = extractCode('FINAL_FILES("src/a.ts")');
    expect(r.finalFiles).toBeNull();
    expect(r.finalFilesInline).toBe(true);
  });

  it("does not flag a valid FINAL_FILES(varname) call as inline", () => {
    const r = extractCode("FINAL_FILES(report)");
    expect(r.finalFiles).toBe("report");
    expect(r.finalFilesInline).toBe(false);
  });
});

describe("renderFileSet", () => {
  it("renders a Record<string, string> as labeled blocks", () => {
    const out = renderFileSet({
      "src/a.ts": "export const a = 1;",
      "tests/a.test.ts": "expect(a).toBe(1);",
    });
    expect(out).toContain("--- file: src/a.ts ---");
    expect(out).toContain("export const a = 1;");
    expect(out).toContain("--- file: tests/a.test.ts ---");
    expect(out).toContain("expect(a).toBe(1);");
  });

  it("preserves file order in output", () => {
    const out = renderFileSet({
      "src/a.ts": "a",
      "src/b.ts": "b",
      "src/c.ts": "c",
    });
    expect(out.indexOf("src/a.ts")).toBeLessThan(out.indexOf("src/b.ts"));
    expect(out.indexOf("src/b.ts")).toBeLessThan(out.indexOf("src/c.ts"));
  });

  it("throws when value is not a Record<string, string>", () => {
    expect(() => renderFileSet("not an object" as unknown as Record<string, string>)).toThrow();
    expect(() => renderFileSet(null as unknown as Record<string, string>)).toThrow();
    expect(() =>
      renderFileSet({ "src/a.ts": 42 } as unknown as Record<string, string>),
    ).toThrow();
  });

  it("throws with a helpful message when given a Promise (unawaited result)", () => {
    const pending = Promise.resolve({ "src/a.ts": "x" });
    expect(() =>
      renderFileSet(pending as unknown as Record<string, string>),
    ).toThrow(/await/i);
  });

  it("throws when the file set is empty (no files)", () => {
    expect(() => renderFileSet({})).toThrow(/empty/i);
    expect(() =>
      renderFileSet({ files: {} } as unknown as Record<string, string>),
    ).toThrow(/empty/i);
  });

  it("unwraps a FinalizeReport by taking .files", () => {
    const report = {
      ok: true,
      files: { "src/a.ts": "export const a = 1;" },
      unimplemented: [],
      testsPassed: 1,
      testsFailed: 0,
    };
    const out = renderFileSet(report as unknown as Record<string, string>);
    expect(out).toContain("--- file: src/a.ts ---");
    expect(out).toContain("export const a = 1;");
  });
});
