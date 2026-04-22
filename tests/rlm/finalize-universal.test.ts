import { describe, it, expect } from "vitest";
import { finalizeProject } from "../../src/rlm/finalize.js";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

describe("finalize universal (Phase U2)", () => {
  it("requires decisions.testCommand in production when runTests=true", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setImplementation(
      "src/a.ts",
      "foo",
      "export default function foo(): number { return 1; }",
    );
    g.setUnitTestFile("src/a.ts", "foo", "// placeholder");
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(
        finalizeProject(g, { runTests: true, typecheck: false }),
      ).rejects.toThrow(/testCommand/);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  });

  it("honors decisions.testCommand and parses TAP output", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "number" });
    g.setImplementation(
      "src/a.ts",
      "foo",
      "export default function foo(): number { return 1; }",
    );
    g.setUnitTestFile("src/a.ts", "foo", "// tests");
    const tap =
      "console.log('TAP version 13'); console.log('1..2'); console.log('ok 1 - a'); console.log('ok 2 - b');";
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(tap)}`,
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const r = await finalizeProject(g, { runTests: true, typecheck: false });
      expect(r.testsPassed).toBe(2);
      expect(r.testsFailed).toBe(0);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);
});
