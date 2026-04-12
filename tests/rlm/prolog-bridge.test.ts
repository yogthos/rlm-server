import { describe, it, expect } from "vitest";
import { prologQuery, PROLOG_IMPL } from "../../src/rlm/prolog-bridge.js";

describe("prologQuery", () => {
  it("solves a simple parent query", async () => {
    const program = `
      parent(tom, bob).
      parent(tom, liz).
      parent(bob, ann).
    `;
    const result = await prologQuery(program, "parent(tom, X).");
    expect(result.status).toBe("success");
    expect(result.answers).toBeDefined();
    expect(result.answers!.length).toBe(2);
    expect(result.answers!.map((a) => a.bindings.X)).toContain("bob");
    expect(result.answers!.map((a) => a.bindings.X)).toContain("liz");
  });

  it("handles rules with recursion", async () => {
    const program = `
      parent(tom, bob).
      parent(bob, ann).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `;
    const result = await prologQuery(program, "ancestor(tom, X).");
    expect(result.status).toBe("success");
    expect(result.answers!.map((a) => a.bindings.X)).toContain("ann");
  });

  it("returns empty answers for failing query", async () => {
    const program = "parent(tom, bob).";
    const result = await prologQuery(program, "parent(bob, X).");
    expect(result.status).toBe("success");
    expect(result.answers!.length).toBe(0);
  });

  it("returns error for invalid program", async () => {
    const result = await prologQuery("not valid prolog !!!", "foo(X).");
    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
  });

  it("supports trace mode", async () => {
    const program = `
      parent(tom, bob).
      parent(bob, ann).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
    `;
    const result = await prologQuery(program, "ancestor(tom, ann).", {
      trace: true,
    });
    expect(result.status).toBe("success");
    expect(result.trace).toBeDefined();
    expect(result.trace!.length).toBeGreaterThan(0);
  });

  it("respects maxAnswers", async () => {
    const program = `
      num(1). num(2). num(3). num(4). num(5).
    `;
    const result = await prologQuery(program, "num(X).", { maxAnswers: 3 });
    expect(result.status).toBe("success");
    expect(result.answers!.length).toBe(3);
  });
});

describe("PROLOG_IMPL", () => {
  it("defines the prolog function", () => {
    expect(PROLOG_IMPL).toContain("async function prolog");
    expect(PROLOG_IMPL).toContain("__prologBridge");
  });
});
