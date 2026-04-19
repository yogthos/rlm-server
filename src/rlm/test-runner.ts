/**
 * Run the tests declared in a DesignGraph against a candidate function body.
 *
 * The workflow is:
 *   1. `materializeWithOverride` renders the graph into a file set, but
 *      swaps in the candidate body for the target function. Pure.
 *   2. `runTests` writes that file set to a temp dir and shells out to
 *      vitest, returning a structured pass/fail summary.
 *
 * Split so most tests can exercise the pure path without touching vitest.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesignGraph } from "./design-graph.js";
import { debug } from "./debug.js";

export interface CandidateBody {
  module: string;
  name: string;
  body: string;
}

export interface TestRunResult {
  ok: boolean;
  passed: number;
  failed: number;
  output: string;
}

export function materializeWithOverride(
  graph: DesignGraph,
  candidate: CandidateBody,
): Record<string, string> {
  // Delegates to graph.materialize(override) which substitutes in the
  // render step without touching the stored node — safe under concurrent
  // test_run / design_finalize calls sharing the same graph.
  return graph.materialize(candidate);
}

export interface RunTestsOptions {
  /** Override the temp dir root (mainly for debugging). */
  tmpRoot?: string;
  /** Hard timeout for the vitest subprocess. */
  timeoutMs?: number;
  /** Working directory the vitest subprocess is spawned in. Defaults to cwd. */
  cwd?: string;
  /**
   * Reuse this specific directory as the project root instead of
   * creating a fresh tmpdir per call. When provided, the caller owns
   * the lifecycle — the dir is kept across invocations so vitest's
   * incremental cache can warm up (5–10× faster attempts). The caller
   * must `rm -r` when finished.
   */
  projectDir?: string;
}

/**
 * Persistent project scratch directory. A single `ProjectDir` is shared
 * across every dispatch attempt in one `design_plan` / `design_build`
 * invocation, letting vitest reuse its compiled-module cache instead
 * of a cold TS transform every run.
 */
export interface ProjectDir {
  path: string;
  dispose(): Promise<void>;
}

/**
 * Create a persistent project directory — materialize the full graph
 * once, keep the package.json/tsconfig/ctx.ts/etc. warm across calls.
 * The caller must `await dir.dispose()` when the build finishes.
 */
export async function createProjectDir(
  graph: DesignGraph,
  options: { tmpRoot?: string } = {},
): Promise<ProjectDir> {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const dir = await mkdtemp(path.join(tmpRoot, "rlm-project-"));
  debug("testrun", `created persistent project dir ${dir}`);
  await writeScaffolding(dir);
  const files = graph.materialize();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return {
    path: dir,
    async dispose() {
      debug("testrun", `disposing project dir ${dir}`);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeScaffolding(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "rlm-test", type: "module", private: true }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: false,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  // Symlink the host's node_modules so @types/node (and any other
  // dev-deps) are resolvable from the temp dir. Without this, Node
  // built-ins (`fs`, `http`, `IncomingMessage`) are unresolved and
  // vitest's ts transform rejects the test file, yielding a bogus
  // 0/0 pass-through we can't distinguish from "no tests matched."
  const hostNodeModules = path.join(process.cwd(), "node_modules");
  const targetNodeModules = path.join(dir, "node_modules");
  try {
    await symlink(hostNodeModules, targetNodeModules, "dir");
  } catch (e) {
    debug(
      "testrun",
      `could not symlink node_modules: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runTests(
  graph: DesignGraph,
  candidate: CandidateBody,
  options: RunTestsOptions = {},
): Promise<TestRunResult> {
  debug(
    "testrun",
    `${candidate.module}#${candidate.name} body=${candidate.body.length}ch`,
  );
  const files = materializeWithOverride(graph, candidate);
  const target = graph.getFunction(candidate.module, candidate.name);
  const hasTests = target !== undefined && target.tests.length > 0;
  const nameFilter = `^${escapeRegex(candidate.name)}\\b`;
  // Persistent-dir path: the caller manages lifecycle. Rewrite ALL
  // emitted files (not just the target's) so siblings' just-committed
  // implementations reach disk — a dispatch dependent (ordered after
  // its dep in topo sort) must see the dep's green body, not the stub
  // that was on disk at init time. Writing N small files is cheap
  // compared to a vitest run.
  if (options.projectDir) {
    const dir = options.projectDir;
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    debug(
      "testrun",
      `reused project dir ${dir} — rewrote ${Object.keys(files).length} files`,
    );
    const result = await invokeVitest(dir, options, hasTests, nameFilter);
    debug(
      "testrun",
      `result ${candidate.module}#${candidate.name} ok=${result.ok} passed=${result.passed} failed=${result.failed}`,
    );
    return result;
  }

  // Cold path: one-shot tmp dir per call (same contract as before).
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const dir = await mkdtemp(path.join(tmpRoot, "rlm-test-"));
  try {
    await writeScaffolding(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    debug(
      "testrun",
      `materialized ${Object.keys(files).length} files to ${dir} hasTests=${hasTests} filter=${nameFilter}`,
    );
    const result = await invokeVitest(dir, options, hasTests, nameFilter);
    debug(
      "testrun",
      `result ${candidate.module}#${candidate.name} ok=${result.ok} passed=${result.passed} failed=${result.failed}`,
    );
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function invokeVitest(
  dir: string,
  options: RunTestsOptions,
  hasTests: boolean,
  nameFilter?: string,
): Promise<TestRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const args = ["vitest", "run", "--reporter=json", "--root", dir];
  if (nameFilter) {
    args.push("--testNamePattern", nameFilter);
  }
  return new Promise((resolve) => {
    const child = spawn("npx", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseVitestJson(stdout);
      // Lead with a distilled per-failure digest so the model sees the
      // actual assertion errors first — the raw reporter JSON is mostly
      // noise and tends to get truncated from the tail.
      const output = parsed
        ? [
            parsed.failureDigest
              ? `----- failures -----\n${parsed.failureDigest}`
              : "",
            `----- counts -----\npassed=${parsed.passed} failed=${parsed.failed}`,
            `----- stderr tail -----\n${stderr.slice(-800)}`,
          ]
            .filter(Boolean)
            .join("\n")
        : `${stdout}\n${stderr}`;
      // If the target function has no tests declared, a 0/0 result is a
      // legitimate "no contract to violate" — treat as ok. Otherwise
      // 0/0 usually means the runner crashed before any test executed.
      const ok = parsed
        ? parsed.failed === 0 && (parsed.passed > 0 || !hasTests)
        : false;
      resolve({
        ok,
        passed: parsed?.passed ?? 0,
        failed: parsed?.failed ?? 0,
        output: output.slice(-4000),
      });
    });
  });
}

interface VitestCounts {
  passed: number;
  failed: number;
  /** First-line assertion errors per failing test, joined for prompt feedback. */
  failureDigest: string;
}

function parseVitestJson(stdout: string): VitestCounts | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const json = JSON.parse(stdout.slice(start));
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];
    const results = Array.isArray(json.testResults) ? json.testResults : [];
    for (const file of results) {
      for (const t of file.assertionResults ?? []) {
        if (t.status === "passed") passed++;
        else if (t.status === "failed") {
          failed++;
          const title =
            t.fullName ?? t.title ?? t.ancestorTitles?.join(" > ") ?? "(test)";
          const msgs = Array.isArray(t.failureMessages) ? t.failureMessages : [];
          const firstLine = (msgs[0] ?? "").split("\n")[0].slice(0, 240);
          failures.push(`✗ ${title}: ${firstLine || "(no failure message)"}`);
        }
      }
    }
    if (typeof json.numPassedTests === "number") passed = json.numPassedTests;
    if (typeof json.numFailedTests === "number") failed = json.numFailedTests;
    return {
      passed,
      failed,
      failureDigest: failures.slice(0, 20).join("\n"),
    };
  } catch {
    return null;
  }
}
