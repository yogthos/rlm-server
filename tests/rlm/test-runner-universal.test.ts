import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTests, createProjectDir } from "../../src/rlm/test-runner.js";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

const createdDirs: string[] = [];
afterAll(async () => {
  for (const d of createdDirs) await rm(d, { recursive: true, force: true });
});

describe("test-runner universal path (Phase U1)", () => {
  it("throws clearly when no testCommand is configured AND VITEST is off", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    // Simulate production by stripping VITEST for this call.
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(
        runTests(g, { module: "src/a.ts", name: "foo", body: "return;" }),
      ).rejects.toThrow(/testCommand/);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  });

  it("honours decisions.testCommand verbatim — no hidden --testNamePattern injection", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    // Use an echo-shaped fake: a shell command that outputs minimal TAP.
    // `node -e` is available on any node-runtime machine.
    const tapScript = "console.log('TAP version 13'); console.log('1..1'); console.log('ok 1 - noop');";
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e "${tapScript}"`,
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const r = await runTests(g, { module: "src/a.ts", name: "foo", body: "return;" });
      expect(r.passed).toBeGreaterThanOrEqual(1);
      expect(r.failed).toBe(0);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);

  it("does NOT inject --testNamePattern into an arbitrary testCommand", async () => {
    // Same as above, but the fake command records its argv into a file
    // we inspect afterwards.
    const tmp = await mkdtemp(path.join(tmpdir(), "rlm-u1-argv-"));
    createdDirs.push(tmp);
    const argvFile = path.join(tmp, "argv.txt");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    // `--no-warnings` + `-e` to inline a tiny script that dumps argv then
    // emits minimal TAP so runTests sees a green run.
    const script = `require('fs').writeFileSync('${argvFile}', process.argv.slice(1).join('\\n')); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1 - noop');`;
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(script)}`,
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await runTests(g, { module: "src/a.ts", name: "foo", body: "return;" });
      const argv = await (await import("node:fs/promises")).readFile(argvFile, "utf8");
      expect(argv).not.toMatch(/testNamePattern/);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);

  it("uses the project dir as cwd for testCommand-driven runs", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "rlm-u1-cwd-"));
    createdDirs.push(tmp);
    const cwdFile = path.join(tmp, "cwd.txt");
    // Create a dummy package.json so runTests writes into a real project.
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const script = `require('fs').writeFileSync(require('path').join(process.cwd(),'cwd.txt'), process.cwd()); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1 - noop');`;
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(script)}`,
      testImports: "",
    });
    const dir = await createProjectDir(g, { projectRoot: tmp });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await runTests(
        g,
        { module: "src/a.ts", name: "foo", body: "return;" },
        { projectDir: dir.path },
      );
      const cwd = await (await import("node:fs/promises")).readFile(
        path.join(dir.path, "cwd.txt"),
        "utf8",
      );
      // macOS resolves /var → /private/var via a symlink. Either is fine —
      // what matters is the tail: the cwd IS inside our project dir.
      const leaf = path.basename(dir.path);
      expect(cwd).toMatch(new RegExp(leaf + "$"));
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);

  it("VITEST env var DOES preserve the legacy vitest fallback for the existing suite", async () => {
    // We don't actually run vitest here — we just verify the guard lets
    // runTests proceed without throwing when VITEST=true and no
    // testCommand is set. The full vitest-end-to-end tests exercise
    // the happy path separately.
    process.env.VITEST = "true";
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    // No expect — we just want to confirm it doesn't THROW the missing-
    // testCommand error. It may fail for other reasons (no real tests
    // to run), but not for the reason U1 guards against.
    let threw: unknown = null;
    try {
      await runTests(g, { module: "src/a.ts", name: "foo", body: "return;" });
    } catch (e) {
      threw = e;
    }
    // Any error at this point is NOT the missing-testCommand one.
    if (threw instanceof Error) {
      expect(threw.message).not.toMatch(/testCommand/);
    }
  }, 30_000);
});
