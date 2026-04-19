import { describe, it, expect } from "vitest";
import { createProjectGraph } from "../../src/rlm/project-graph.js";

describe("ProjectGraph", () => {
  it("starts empty", () => {
    const pg = createProjectGraph();
    expect(pg.size).toBe(0);
    expect(pg.hasFile("src/a.ts")).toBe(false);
    expect(pg.snapshot()).toEqual({});
  });

  it("records a file via addOrUpdate", async () => {
    const pg = createProjectGraph();
    await pg.addOrUpdate("src/a.ts", "export const x = 1;");
    expect(pg.size).toBe(1);
    expect(pg.hasFile("src/a.ts")).toBe(true);
    expect(pg.snapshot()["src/a.ts"]).toBe("export const x = 1;");
  });

  it("addOrUpdate replaces existing content", async () => {
    const pg = createProjectGraph();
    await pg.addOrUpdate("src/a.ts", "export const x = 1;");
    await pg.addOrUpdate("src/a.ts", "export const x = 2;");
    expect(pg.size).toBe(1);
    expect(pg.snapshot()["src/a.ts"]).toContain("x = 2");
  });

  it("accumulates multiple files", async () => {
    const pg = createProjectGraph();
    await pg.addOrUpdate("src/a.ts", "export function foo() { return 1; }");
    await pg.addOrUpdate("src/b.ts", "import { foo } from './a.js'; foo();");
    expect(pg.size).toBe(2);
  });

  it("exposes extracted structural facts", async () => {
    const pg = createProjectGraph();
    await pg.addOrUpdate("src/a.ts", "export function foo(): number { return 1; }");
    const facts = await pg.getFacts();
    expect(facts.graph.defines.some((d) => d.name === "foo")).toBe(true);
    expect(facts.graph.exports.some((e) => e.name === "foo")).toBe(true);
  });

  it("picks up a call edge between files", async () => {
    const pg = createProjectGraph();
    await pg.addOrUpdate("src/a.ts", "export function foo(): number { return 1; }");
    await pg.addOrUpdate(
      "src/b.ts",
      "import { foo } from './a.js';\nexport function bar(): number { return foo(); }",
    );
    const facts = await pg.getFacts();
    // The imported call 'foo' is referenced in bar — must show up as a call edge.
    const callees = facts.graph.calls.map((c) => c.callee);
    expect(callees).toContain("foo");
  });

  it("reports whether a file is the first in the project (for bootstrap exemption)", () => {
    const pg = createProjectGraph();
    expect(pg.isEmpty()).toBe(true);
  });
});
