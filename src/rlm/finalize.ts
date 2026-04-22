/**
 * Final verification of a DesignGraph.
 *
 * Called once the Architect believes all dispatches are complete. Runs:
 *   1. `allImplemented()` — every declared function has a body.
 *   2. `consistency()` — no unresolved imports or dangling modules.
 *   3. `materialize()` — render the full project into a temp dir.
 *   4. `vitest run` — full suite across every materialized test file.
 *   5. Optional `tsc --noEmit` — catches signature mismatches across modules
 *      that the structural graph validator may not see.
 *
 * The caller decides what to do with the report; `finalize` itself never
 * writes into the user's working directory.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ConsistencyReport,
  DesignGraph,
} from "./design-graph.js";
import { debug } from "./debug.js";
import { parseTestOutput, splitCommand } from "./test-runner.js";

export interface FinalizeOptions {
  typecheck?: boolean;
  runTests?: boolean;
  tmpRoot?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface FinalizeReport {
  ok: boolean;
  files: Record<string, string>;
  unimplemented: string[];
  consistency: ConsistencyReport;
  testsPassed: number;
  testsFailed: number;
  testOutput: string;
  typecheckOk: boolean | null;
  typecheckOutput: string;
}

export async function finalizeProject(
  graph: DesignGraph,
  options: FinalizeOptions = {},
): Promise<FinalizeReport> {
  const runTests = options.runTests ?? true;
  const typecheck = options.typecheck ?? false;

  const unimplemented = graph
    .listFunctions()
    .filter((f) => f.implementation === null)
    .map((f) => `${f.module}#${f.name}`);

  const consistency = graph.consistency();
  const hasTests = graph
    .listFunctions()
    .some((f) => f.tests.length > 0);

  const report: FinalizeReport = {
    ok: false,
    files: {},
    unimplemented,
    consistency,
    testsPassed: 0,
    testsFailed: 0,
    testOutput: "",
    typecheckOk: null,
    typecheckOutput: "",
  };

  // Only populate `files` when the graph is ready to serialize — otherwise
  // `FINAL_FILES(report)` would render stub-throw bodies as finished code.
  if (unimplemented.length > 0 || !consistency.ok) {
    debug(
      "finalize",
      `not ready: unimplemented=${unimplemented.length} consistencyOk=${consistency.ok}`,
    );
    return report;
  }
  report.files = graph.materialize();
  debug(
    "finalize",
    `materialized ${Object.keys(report.files).length} files (runTests=${runTests} typecheck=${typecheck})`,
  );

  if (!runTests && !typecheck) {
    report.ok = true;
    return report;
  }

  const tmpRoot = options.tmpRoot ?? tmpdir();
  const dir = await mkdtemp(path.join(tmpRoot, "rlm-finalize-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "rlm-finalize", type: "module", private: true }),
      "utf8",
    );
    // Symlink host node_modules so @types/node is available (matches
    // the test-runner's scaffolding — without this vitest rejects test
    // files that reference built-in Node types).
    try {
      await symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(dir, "node_modules"),
        "dir",
      );
    } catch (e) {
      debug(
        "finalize",
        `could not symlink node_modules: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const [rel, content] of Object.entries(report.files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }

    if (runTests) {
      // Phase U2 — spawn decisions.testCommand, parse TAP (with
      // JSON fallback for vitest/jest reporter output). Throw in
      // production when testCommand is missing; VITEST env keeps the
      // legacy vitest spawn working for the harness's own test suite.
      const decisions = graph.getProjectConfig();
      const rawCmd = decisions?.testCommand?.trim() ?? "";
      let command: string;
      let args: string[];
      let useProjectDirCwd = false;
      if (rawCmd.length > 0) {
        const tokens = splitCommand(rawCmd);
        command = tokens[0];
        args = tokens.slice(1);
        useProjectDirCwd = true;
      } else if (process.env.VITEST) {
        command = "npx";
        args = ["vitest", "run", "--reporter=json", "--root", dir];
      } else {
        throw new Error(
          "finalize: missing decisions.testCommand. Phase 0 must commit to a test framework + command.",
        );
      }
      const run = await shellOutArgs(command, args, {
        ...options,
        cwdOverride: useProjectDirCwd ? dir : undefined,
      });
      const counts = parseTestOutput(run.stdout);
      report.testsPassed = counts?.passed ?? 0;
      report.testsFailed = counts?.failed ?? 0;
      debug(
        "finalize",
        `tests parsed=${counts !== null} passed=${report.testsPassed} failed=${report.testsFailed}`,
      );
      const combined = counts
        ? [
            counts.failureDigest
              ? `----- failures -----\n${counts.failureDigest}`
              : "",
            `----- counts -----\npassed=${counts.passed} failed=${counts.failed}`,
            `----- stderr tail -----\n${run.stderr.slice(-800)}`,
          ]
            .filter(Boolean)
            .join("\n")
        : `${run.stdout}\n${run.stderr}`;
      report.testOutput = combined.slice(-4000);
    }

    if (typecheck) {
      // tsc doesn't expand globs when spawned without a shell. Write a
      // throwaway tsconfig.json so `-p dir` picks up every .ts file.
      await writeFile(
        path.join(dir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              esModuleInterop: true,
            },
            include: ["**/*.ts"],
          },
          null,
          2,
        ),
        "utf8",
      );
      const tsc = await shellOut(
        "npx",
        ["tsc", "--noEmit", "-p", dir],
        options,
      );
      report.typecheckOk = tsc.exitCode === 0;
      report.typecheckOutput = `${tsc.stdout}\n${tsc.stderr}`.slice(-4000);
      debug("finalize", `tsc exit=${tsc.exitCode} ok=${report.typecheckOk}`);
    }

    // A function with zero declared tests legitimately produces 0/0; treat
    // that as "no test signal" rather than a failure so finalize can
    // succeed on graphs that haven't wired tests for every function yet.
    const testsOk =
      !runTests ||
      (report.testsFailed === 0 && (report.testsPassed > 0 || !hasTests));
    const typeOk = !typecheck || report.typecheckOk === true;
    report.ok = testsOk && typeOk;

    // When the integration suite reveals failures, reset the offending
    // functions' status and clear their stored implementation so the
    // next `design_build()` re-dispatches them. Without this, a later
    // finalize sees `tests-green` functions that actually broke when
    // siblings landed — stale state that blocks repair.
    if (runTests && !testsOk && report.testsFailed > 0) {
      const failingNames = extractFailingFunctionNames(report.testOutput);
      debug(
        "finalize",
        `re-opening functions with tests-red: ${[...failingNames].join(",") || "(none parsed)"}`,
      );
      for (const fn of graph.listFunctions()) {
        if (failingNames.has(fn.name) && fn.status === "tests-green") {
          graph.setTestStatus(fn.module, fn.name, "tests-red", report.testOutput);
          // Re-open for dispatch — the already-saved body is broken.
          const key = `${fn.module}#${fn.name}`;
          report.unimplemented.push(key);
          // Mutate stored node via the graph's implement path so the
          // dispatch loop's `implementation !== null` skip is lifted.
          // We can't directly null it through the public API; instead
          // record the need by pushing to unimplemented and relying on
          // the caller to decide — but design_build's skip check only
          // looks at `fn.implementation`, so we must null that too.
          (fn as { implementation: string | null }).implementation = null;
        }
      }
    }
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function shellOut(
  cmd: string,
  args: string[],
  options: FinalizeOptions,
): Promise<ShellResult> {
  return shellOutArgs(cmd, args, { ...options });
}

/** Same as shellOut but accepts an explicit `cwdOverride` so the
 *  Phase U2 path can spawn in the materialized project dir (where
 *  the architect's testCommand expects to find tsconfig + node_modules)
 *  rather than the caller's cwd. */
function shellOutArgs(
  cmd: string,
  args: string[],
  options: FinalizeOptions & { cwdOverride?: string },
): Promise<ShellResult> {
  const cwd = options.cwdOverride ?? options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

interface VitestCounts {
  passed: number;
  failed: number;
  failureDigest: string;
}

/**
 * Pull function names out of the distilled failure digest we inject
 * into `testOutput`. Describe titles we emit:
 *   - `describe("<fnName>", ...)`         — unit tests
 *   - `describe("<fnName> (integration)", ...)` — branch integration
 *   - `describe("project integration", ...)`    — project-scope tests
 *
 * Unit and branch-integration failures map to the same function name;
 * project-integration failures route nowhere specific (no single fn to
 * reopen). Returns only real function names — "project" is excluded.
 */
function extractFailingFunctionNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("✗")) continue;
    // Match optional " (integration)" suffix after the identifier.
    const m = line.match(/^✗\s+([A-Za-z_$][\w$]*)(?:\s*\(integration\))?\b/);
    if (!m) continue;
    const candidate = m[1];
    // The literal describe "project integration" captures "project" —
    // skip to avoid wiping a function named "project" (also banned as
    // a name, but defense-in-depth).
    if (candidate === "project") continue;
    names.add(candidate);
  }
  return names;
}

function parseVitestJson(stdout: string): VitestCounts | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const json = JSON.parse(stdout.slice(start));
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const file of json.testResults ?? []) {
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
