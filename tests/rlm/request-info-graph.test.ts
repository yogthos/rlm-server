import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  resolveRequests,
  type InfoContext,
} from "../../src/rlm/design-request-info.js";

function makeCtx(graph: ReturnType<typeof createDesignGraph>): InfoContext {
  return {
    graph,
    module: "src/a.ts",
    fnName: "foo",
  };
}

describe("request-info — graph-backed handlers (Phase N6)", () => {
  it("callers returns functions whose analyzedCallees include the target (inverted)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "baz", { params: [], returnType: "number" });
    g.setAnalyzedEdges("src/a.ts", "bar", {
      imports: [{ source: "./foo.js", name: "foo", isDefault: true, line: 1 }],
      callees: ["foo"],
    });
    g.setAnalyzedEdges("src/a.ts", "baz", {
      imports: [{ source: "./foo.js", name: "foo", isDefault: true, line: 1 }],
      callees: ["foo"],
    });
    const out = await resolveRequests(
      [{ kind: "callers", args: "", raw: "callers" }],
      makeCtx(g),
    );
    // Both bar and baz call foo.
    expect(out).toMatch(/bar/);
    expect(out).toMatch(/baz/);
  });

  it("callees returns the target's analyzed sibling callees", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "helperA", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "helperB", { params: [], returnType: "number" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [
        { source: "./helperA.js", name: "helperA", isDefault: true, line: 1 },
        { source: "./helperB.js", name: "helperB", isDefault: true, line: 2 },
      ],
      callees: ["helperA", "helperB"],
    });
    const out = await resolveRequests(
      [{ kind: "callees", args: "", raw: "callees" }],
      makeCtx(g),
    );
    expect(out).toMatch(/helperA/);
    expect(out).toMatch(/helperB/);
  });

  it("callees with an explicit target name scopes to that function", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "bar", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "helperA", { params: [], returnType: "number" });
    g.setAnalyzedEdges("src/a.ts", "bar", {
      imports: [
        { source: "./helperA.js", name: "helperA", isDefault: true, line: 1 },
      ],
      callees: ["helperA"],
    });
    const out = await resolveRequests(
      [{ kind: "callees", args: "bar", raw: "callees:bar" }],
      makeCtx(g),
    );
    expect(out).toMatch(/helperA/);
  });

  it("imports:<fn> echoes the analyzer-observed import list", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [
        { source: "./bar.js", name: "bar", isDefault: true, line: 1 },
        { source: "node:fs", name: "fs", isDefault: false, line: 2 },
      ],
      callees: [],
    });
    const out = await resolveRequests(
      [{ kind: "imports", args: "foo", raw: "imports:foo" }],
      makeCtx(g),
    );
    expect(out).toMatch(/\.\/bar\.js/);
    expect(out).toMatch(/node:fs/);
    expect(out).toMatch(/line 1/);
  });

  it("signature:<fn> returns only the declared signature line", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "add", {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
    });
    const out = await resolveRequests(
      [{ kind: "signature", args: "add", raw: "signature:add" }],
      makeCtx(g),
    );
    expect(out).toMatch(/add\(a: number, b: number\): number/);
  });

  it("body:<fn> returns the stored implementation (or a stub notice)", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setImplementation(
      "src/a.ts",
      "foo",
      `export default function foo(): number { return 42; }`,
    );
    const out = await resolveRequests(
      [{ kind: "body", args: "foo", raw: "body:foo" }],
      makeCtx(g),
    );
    expect(out).toContain("return 42");
  });

  it("body:<fn> flags unimplemented functions instead of fabricating a body", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const out = await resolveRequests(
      [{ kind: "body", args: "foo", raw: "body:foo" }],
      makeCtx(g),
    );
    expect(out).toMatch(/not.*implemented/i);
  });

  it("graph returns a compact ±1-hop neighborhood around the current function", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "callerOfFoo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "calleeOfFoo", { params: [], returnType: "number" });
    g.addFunction("src/a.ts", "unrelated", { params: [], returnType: "number" });
    // caller → foo (caller lists foo in its callees)
    g.setAnalyzedEdges("src/a.ts", "callerOfFoo", {
      imports: [{ source: "./foo.js", name: "foo", isDefault: true, line: 1 }],
      callees: ["foo"],
    });
    // foo → calleeOfFoo
    g.setAnalyzedEdges("src/a.ts", "foo", {
      imports: [
        { source: "./calleeOfFoo.js", name: "calleeOfFoo", isDefault: true, line: 1 },
      ],
      callees: ["calleeOfFoo"],
    });
    const out = await resolveRequests(
      [{ kind: "graph", args: "", raw: "graph" }],
      makeCtx(g),
    );
    expect(out).toMatch(/callerOfFoo/);
    expect(out).toMatch(/calleeOfFoo/);
    expect(out).not.toMatch(/unrelated/);
  });

  it("help lists the new handlers", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    const out = await resolveRequests(
      [{ kind: "help", args: "", raw: "help" }],
      makeCtx(g),
    );
    for (const kind of ["callees", "imports", "signature", "body", "graph"]) {
      expect(out).toContain(kind);
    }
  });
});
