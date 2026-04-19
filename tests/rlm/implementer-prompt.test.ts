import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { buildImplementerPrompt } from "../../src/rlm/implementer-prompt.js";

function seedGraph() {
  const g = createDesignGraph();
  g.addModule("src/db.ts");
  g.addModule("src/schema.ts");
  g.addFunction(
    "src/db.ts",
    "connect",
    {
      params: [{ name: "path", type: "string" }],
      returnType: "Database",
    },
    "Open a SQLite database at the given path.",
  );
  g.addFunction(
    "src/schema.ts",
    "createSchema",
    { params: [{ name: "db", type: "Database" }], returnType: "void" },
    "Install the guestbook schema.",
  );
  g.addImport("src/db.ts", "Database", "better-sqlite3");
  g.addTest("src/db.ts", "connect", {
    name: "opens an in-memory db",
    code: 'const db = connect(":memory:");\nexpect(db).toBeDefined();',
  });
  return g;
}

describe("buildImplementerPrompt", () => {
  it("throws when the target function is not declared", async () => {
    const g = createDesignGraph();
    await expect(
      buildImplementerPrompt(g, "src/db.ts", "connect"),
    ).rejects.toThrow(/not found/);
  });

  it("includes identity line naming the function", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toMatch(/Implementer of `connect`/);
  });

  it("renders the proc-ts signature with ctx: Ctx injected", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain(
      "function connect(ctx: Ctx, path: string): Database",
    );
  });

  it("includes the description when present", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("Open a SQLite database at the given path.");
  });

  it("lists other project functions as ctx.fns entries without descriptions", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    // The new format surfaces the call shape directly so the Implementer
    // knows HOW to invoke each sibling.
    expect(p).toContain("ctx.fns.createSchema(ctx, db: Database): void");
    expect(p).not.toContain("throw new Error");
    // Sibling descriptions are dropped — keep the prompt focused on
    // the target. The target's own description is still shown.
    expect(p).not.toContain("Install the guestbook schema");
  });

  it("embeds the tests the function must pass", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("opens an in-memory db");
    expect(p).toContain("connect(");
  });

  it("tells the implementer to call siblings via ctx.fns", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("ctx.fns");
  });

  it("tells the implementer NOT to call test_run or design_implement", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    expect(p).toContain("do not call test_run");
    expect(p).toContain("do not call design_implement");
  });

  it("does not include the target function in the sibling list", async () => {
    const g = seedGraph();
    const p = await buildImplementerPrompt(g, "src/db.ts", "connect");
    const siblingSection = p.split(/Other functions/i)[1] ?? "";
    expect(siblingSection).not.toMatch(/connect\(ctx: Ctx,/);
  });

  it("handles functions with no user params — ctx: Ctx only", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    expect(p).toContain("function foo(ctx: Ctx): void");
  });

  it("asks the Implementer to emit unit-tests when none exist yet", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    expect(p).toContain("```unit-tests");
  });

  it("tells leaves (no children) that integration tests must be an empty array", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const p = await buildImplementerPrompt(g, "src/a.ts", "foo");
    // Leaves don't assemble anything — their integration fence must be `[]`.
    // Storing leaf integration tests is a lie: renderIntegrationTestFile
    // drops them for children-less functions.
    expect(p).toMatch(/integration-tests[\s\S]{0,120}empty/i);
    expect(p).not.toMatch(/OPTIONAL for leaves/);
  });

  it("tells branches (with children) that integration tests are REQUIRED", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "parent", { params: [], returnType: "void" });
    g.addFunctionChild(
      "parent",
      "src/a.ts",
      "child",
      { params: [], returnType: "void" },
      "child",
    );
    const p = await buildImplementerPrompt(g, "src/a.ts", "parent");
    expect(p).toContain("REQUIRED");
  });

  it("renders async functions with the async keyword", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "load", {
      params: [],
      returnType: "Promise<string>",
      isAsync: true,
    });
    const p = await buildImplementerPrompt(g, "src/a.ts", "load");
    expect(p).toContain(
      "async function load(ctx: Ctx): Promise<string>",
    );
  });
});
