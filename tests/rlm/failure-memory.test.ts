import { describe, it, expect } from "vitest";
import {
  createFailureMemory,
  recordFailure,
  findHints,
  signatureOf,
  renderHints,
  FailureMemoryStore,
  createFailureMemoryStore,
} from "../../src/rlm/failure-memory.js";

describe("signatureOf", () => {
  it("strips file paths and line numbers", () => {
    const sig1 = signatureOf("/tmp/run-42/src/a.ts:19:4: Cannot find name 'Database'");
    const sig2 = signatureOf("/var/other/q.ts:103:12: Cannot find name 'Database'");
    expect(sig1).toBe(sig2);
  });

  it("strips numeric literals and quoted identifiers", () => {
    const a = signatureOf("TypeError: x.foo is not a function (at line 42)");
    const b = signatureOf("TypeError: y.foo is not a function (at line 9001)");
    expect(a).toBe(b);
  });

  it("collapses whitespace", () => {
    const a = signatureOf("Error:  foo  bar\nbaz");
    const b = signatureOf("Error: foo bar baz");
    expect(a).toBe(b);
  });

  it("empty input → empty signature", () => {
    expect(signatureOf("")).toBe("");
  });
});

describe("failure memory", () => {
  it("recordFailure adds a new entry on first occurrence", () => {
    const m0 = createFailureMemory();
    const m1 = recordFailure(m0, "Cannot find name 'Database'", { hint: "import better-sqlite3" });
    expect(m1.length).toBe(1);
    expect(m1[0].occurrences).toBe(1);
    expect(m1[0].hint).toBe("import better-sqlite3");
  });

  it("recordFailure increments occurrences on repeat", () => {
    let m = createFailureMemory();
    m = recordFailure(m, "Cannot find name 'Database'", { hint: "h" });
    m = recordFailure(m, "Cannot find name 'Database'", { hint: "h" });
    m = recordFailure(m, "Cannot find name 'Database'", { hint: "h" });
    expect(m).toHaveLength(1);
    expect(m[0].occurrences).toBe(3);
  });

  it("recordFailure signatures are normalized — same shape, different details", () => {
    let m = createFailureMemory();
    m = recordFailure(m, "/a.ts:12:4: SyntaxError: Unexpected token 'xyz'", { hint: "h" });
    m = recordFailure(m, "/b.ts:99:1: SyntaxError: Unexpected token 'abc'", { hint: "h" });
    expect(m).toHaveLength(1);
    expect(m[0].occurrences).toBe(2);
  });

  it("findHints returns entries with matching signature and ≥2 occurrences", () => {
    let m = createFailureMemory();
    m = recordFailure(m, "ReferenceError: foo is not defined", { hint: "define foo first" });
    // Only 1 occurrence → not returned yet
    expect(findHints(m, "ReferenceError: foo is not defined")).toEqual([]);
    m = recordFailure(m, "ReferenceError: foo is not defined", { hint: "define foo first" });
    const hits = findHints(m, "ReferenceError: foo is not defined");
    expect(hits).toHaveLength(1);
    expect(hits[0].hint).toBe("define foo first");
  });

  it("findHints returns empty for unknown errors", () => {
    const m = createFailureMemory();
    expect(findHints(m, "anything")).toEqual([]);
  });

  it("renderHints produces a compact block", () => {
    const hints = [
      { signature: "s1", hint: "do X first", tags: ["a"], occurrences: 3, createdAt: 0 },
      { signature: "s2", hint: "do Y", tags: [], occurrences: 2, createdAt: 0 },
    ];
    const block = renderHints(hints);
    expect(block).toContain("do X first");
    expect(block).toContain("do Y");
    expect(block.toLowerCase()).toMatch(/hint|seen|repeat/);
  });

  it("renderHints returns empty string on empty input", () => {
    expect(renderHints([])).toBe("");
  });
});

describe("FailureMemoryStore (mutable shared store)", () => {
  it("createFailureMemoryStore returns an empty store", () => {
    const s = createFailureMemoryStore();
    expect(s.findHints("anything")).toEqual([]);
    expect(s.snapshot()).toEqual([]);
  });

  it("record mutates in place; findHints sees the latest", () => {
    const s = createFailureMemoryStore();
    s.record("ReferenceError: foo is not defined", { hint: "define foo first" });
    // 1 occurrence — below threshold
    expect(s.findHints("ReferenceError: foo is not defined")).toHaveLength(0);
    s.record("ReferenceError: foo is not defined", { hint: "define foo first" });
    const hits = s.findHints("ReferenceError: foo is not defined");
    expect(hits).toHaveLength(1);
    expect(hits[0].hint).toBe("define foo first");
  });

  it("same store reference shared across two holders sees each other's writes", () => {
    const shared = createFailureMemoryStore();
    // Simulate two recursion levels pointing at the same store.
    const parentRef = shared;
    const childRef = shared;

    childRef.record("/tmp/a.ts:12: ReferenceError: foo is not defined", { hint: "define foo" });
    childRef.record("/var/b.ts:99: ReferenceError: foo is not defined", { hint: "define foo" });

    // Parent queries with a third, differently-located but same-shape error.
    // signatureOf normalizes paths + line numbers so the signatures match.
    const hits = parentRef.findHints("/other/c.ts:3: ReferenceError: foo is not defined");
    expect(hits).toHaveLength(1);
    expect(hits[0].occurrences).toBe(2);
  });
});
