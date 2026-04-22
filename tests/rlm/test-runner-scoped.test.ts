// Phase U12 — per-node dispatch must scope to ONE test file.
// Previously the harness spawned `decisions.testCommand` for every
// dispatch, which typically expands a glob (`*.test.ts`) and runs the
// whole project suite. That cross-contaminates per-function results:
// dispatcher attributes any failing sibling test to the current target.
// Fix: a `singleTestCommand` template with a `{file}` placeholder that
// the harness interpolates with `<candidateName>.test.ts` at spawn time.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTests } from "../../src/rlm/test-runner.js";
import { createDesignGraph } from "../../src/rlm/design-graph.js";

const createdDirs: string[] = [];
afterAll(async () => {
  for (const d of createdDirs) await rm(d, { recursive: true, force: true });
});

describe("test-runner per-node scoped execution (Phase U12)", () => {
  it("prefers singleTestCommand over testCommand for per-node dispatch", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "rlm-u12-prefer-"));
    createdDirs.push(tmp);
    const markerFile = path.join(tmp, "which.txt");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    // testCommand writes "FULL", singleTestCommand writes "SINGLE".
    // If the harness spawns singleTestCommand (what we want), the marker
    // file contains "SINGLE".
    const fullScript = `require('fs').writeFileSync('${markerFile}', 'FULL'); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1');`;
    const singleScript = `require('fs').writeFileSync('${markerFile}', 'SINGLE:' + process.argv[process.argv.length - 1]); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1');`;
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(fullScript)}`,
      singleTestCommand: `node -e ${JSON.stringify(singleScript)} -- {file}`,
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await runTests(g, { module: "src/a.ts", name: "foo", body: "return;" });
      const marker = await readFile(markerFile, "utf8");
      expect(marker.startsWith("SINGLE:")).toBe(true);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);

  it("interpolates {file} with <candidateName>.test.ts", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "rlm-u12-interp-"));
    createdDirs.push(tmp);
    const argvFile = path.join(tmp, "argv.txt");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "fooBar", { params: [], returnType: "void" });
    const script = `require('fs').writeFileSync('${argvFile}', process.argv.slice(1).join(' ')); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1');`;
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(script)}`,
      singleTestCommand: `node -e ${JSON.stringify(script)} -- {file}`,
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await runTests(g, { module: "src/a.ts", name: "fooBar", body: "return;" });
      const argv = await readFile(argvFile, "utf8");
      // The final argv token should be the target-scoped test file name.
      expect(argv).toMatch(/fooBar\.test\.ts/);
      // Negative: should NOT look like a glob or mention other modules.
      expect(argv).not.toMatch(/\*\.test\.ts/);
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);

  it("falls back to testCommand when singleTestCommand is absent", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "rlm-u12-fallback-"));
    createdDirs.push(tmp);
    const marker = path.join(tmp, "marker.txt");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", { params: [], returnType: "void" });
    const script = `require('fs').writeFileSync('${marker}', 'ran'); console.log('TAP version 13'); console.log('1..1'); console.log('ok 1');`;
    g.setProjectConfig({
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "node:test",
      testCommand: `node -e ${JSON.stringify(script)}`,
      // No singleTestCommand — harness must still run via testCommand.
      testImports: "",
    });
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const r = await runTests(g, { module: "src/a.ts", name: "foo", body: "return;" });
      expect(r.passed).toBeGreaterThanOrEqual(1);
      const wrote = await readFile(marker, "utf8");
      expect(wrote).toBe("ran");
    } finally {
      if (saved !== undefined) process.env.VITEST = saved;
    }
  }, 20_000);
});
