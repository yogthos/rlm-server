/**
 * Structured integration runner for `designPlanIntegration`.
 *
 * Round 15: replaces the text-digest wrapper around `finalizeProject`
 * with a dedicated vitest invocation that preserves per-test stack
 * traces. Stack frames matter for the attribution path — when a
 * frame points at a function file, we get `confidence: "direct"` and
 * skip the LLM fallback.
 *
 * Pipeline:
 *   1. Materialize the graph into a temp project dir (or reuse a
 *      warm `projectDir` if the caller passed one).
 *   2. Run `npx vitest run --reporter=json` scoped to the project
 *      integration test file.
 *   3. Parse the JSON output per-test; build `IntegrationFailure[]`
 *      with `failureMessages[0]` as the stack trace.
 *
 * `parseVitestFailures(json)` is exported as a pure helper so tests
 * can feed canned reporter output without shelling out.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesignGraph } from "./design-graph.js";
import type {
  IntegrationFailure,
  IntegrationRunResult,
} from "./design-integration-loop.js";
import { debug } from "./debug.js";
import { parseTapOutput, splitCommand } from "./test-runner.js";

export interface IntegrationRunnerOptions {
  /** Reuse an existing project dir instead of materializing a fresh
   *  one. When set, the runner rewrites only changed files. */
  projectDir?: string;
  timeoutMs?: number;
}

/**
 * Parse tsc --noEmit stdout into IntegrationFailure entries.
 *
 * tsc format per error:
 *   path/to/file.ts:line:col - error TS####: message text
 *
 * The stackTrace field is synthesized as `at <file>:<line>:<col>` so
 * the attribution path can map it to a function the same way it does
 * for vitest stack frames. One IntegrationFailure per type error.
 */
export function parseTscErrors(stdout: string): IntegrationFailure[] {
  const failures: IntegrationFailure[] = [];
  const re = /^(.+?):(\d+):(\d+)\s+-\s+error\s+TS\d+:\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const [, file, line, col, msg] = m;
    failures.push({
      testName: `typecheck ${file}`,
      message: msg.trim(),
      stackTrace: `at ${file}:${line}:${col}`,
    });
  }
  return failures;
}

/**
 * Parse vitest --reporter=json stdout into structured failures.
 *
 * Pure function — takes a JSON string, returns `IntegrationFailure[]`.
 * Safe on malformed input (returns empty array), so a non-JSON
 * stderr / crash surface produces zero failures rather than throwing.
 */
/**
 * Phase U2 — adapt TAP output to the IntegrationFailure shape. Returns
 * null when the stdout contained no TAP lines at all (let the caller
 * fall through to the legacy JSON parser). Returns [] when TAP parsed
 * cleanly with zero failures.
 */
export function parseTestFailuresTap(stdout: string): IntegrationFailure[] | null {
  const counts = parseTapOutput(stdout);
  if (counts === null) return null;
  const failures: IntegrationFailure[] = [];
  for (const name of counts.failingTestNames) {
    const full = counts.fullFailureMessages.get(name) ?? "";
    failures.push({
      testName: name,
      message: full.split("\n")[0] || "(no message)",
      stackTrace: full,
    });
  }
  return failures;
}

export function parseVitestFailures(jsonOutput: string): IntegrationFailure[] {
  const start = jsonOutput.indexOf("{");
  if (start < 0) return [];
  let json: any;
  try {
    json = JSON.parse(jsonOutput.slice(start));
  } catch {
    return [];
  }
  const failures: IntegrationFailure[] = [];
  for (const file of json.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status !== "failed") continue;
      const title =
        t.fullName ?? t.title ?? (t.ancestorTitles ?? []).join(" > ") ?? "(unnamed test)";
      const msgs: string[] = Array.isArray(t.failureMessages)
        ? t.failureMessages
        : [];
      // failureMessages[0] typically is the full "AssertionError: ..."
      // followed by multiple "    at ..." frames. Treat the first line
      // as the concise message and the remainder as the stack trace.
      const raw = msgs[0] ?? "";
      const newlineAt = raw.indexOf("\n");
      const message = newlineAt >= 0 ? raw.slice(0, newlineAt).trim() : raw.trim();
      const stackTrace = newlineAt >= 0 ? raw.slice(newlineAt + 1) : "";
      failures.push({
        testName: String(title),
        message: message || "(no failure message)",
        stackTrace,
      });
    }
  }
  return failures;
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function shellOut(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
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

async function writeProjectFiles(
  graph: DesignGraph,
  dir: string,
): Promise<void> {
  const files = graph.materialize();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

async function createScaffoldDir(tmpRoot: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpRoot, "rlm-int-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "rlm-int", type: "module", private: true }),
    "utf8",
  );
  try {
    await symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(dir, "node_modules"),
      "dir",
    );
  } catch (e) {
    debug(
      "integration-loop",
      `symlink node_modules failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // tsconfig for `tsc --noEmit -p dir`. Matches test-runner's shape
  // so the integration typecheck agrees with the per-function
  // typecheck. Notably: `types: ["node"]` so `fs`, `http`,
  // `IncomingMessage`, etc. resolve; `strict: false` because proc-ts
  // bodies use dynamic imports that don't narrow well under strict;
  // `allowImportingTsExtensions` because generated test files import
  // siblings via `./foo.js` that resolve to `./foo.ts`.
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
  return dir;
}

export function createIntegrationRunner(
  options: IntegrationRunnerOptions = {},
): (graph: DesignGraph) => Promise<IntegrationRunResult> {
  // 10 min default — long enough for a project-size vitest run on cold
  // TS transforms. Caller can override.
  const timeoutMs = options.timeoutMs ?? 600_000;
  return async (graph) => {
    let dir = options.projectDir;
    let owned = false;
    try {
      if (!dir) {
        dir = await createScaffoldDir(tmpdir());
        owned = true;
      }
      await writeProjectFiles(graph, dir);
      // Phase U2 — spawn decisions.testCommand, parse TAP (JSON
      // fallback via parseVitestFailures when TAP parsing yields
      // nothing). Throw in production when testCommand is missing;
      // VITEST env keeps the legacy vitest spawn for harness tests.
      const decisions = graph.getProjectConfig();
      const rawCmd = decisions?.testCommand?.trim() ?? "";
      let testCmd: string;
      let testArgs: string[];
      if (rawCmd.length > 0) {
        const tokens = splitCommand(rawCmd);
        testCmd = tokens[0];
        testArgs = tokens.slice(1);
      } else if (process.env.VITEST) {
        testCmd = "npx";
        testArgs = ["vitest", "run", "--reporter=json", "--root", dir];
      } else {
        throw new Error(
          "integration-runner: missing decisions.testCommand. Phase 0 must commit to a test framework + command.",
        );
      }
      // Run tests + tsc in PARALLEL — they're independent processes.
      const [vitest, tsc] = await Promise.all([
        shellOut(testCmd, testArgs, dir, timeoutMs),
        shellOut(
          "npx",
          ["tsc", "--noEmit", "-p", dir],
          dir,
          timeoutMs,
        ),
      ]);
      const vitestFailures =
        parseTestFailuresTap(vitest.stdout) ?? parseVitestFailures(vitest.stdout);
      const tscFailures = parseTscErrors(tsc.stdout);
      debug(
        "integration-loop",
        `ran vitest — exit=${vitest.exitCode} failures=${vitestFailures.length}`,
      );
      debug(
        "integration-loop",
        `ran tsc — exit=${tsc.exitCode} errors=${tscFailures.length}`,
      );
      const failures: IntegrationFailure[] = [
        ...vitestFailures,
        ...tscFailures,
      ];
      // Synthetic failure for vitest-crash: gated on vitestFailures
      // (NOT combined). If tsc found errors in the same run, we still
      // want to surface the vitest crash signal too — the errors may
      // be complementary (type error caused by the same missing
      // import that broke vitest load).
      if (vitest.exitCode !== 0 && vitestFailures.length === 0) {
        const stderrTail = vitest.stderr.slice(-2000);
        const stdoutTail = vitest.stdout.slice(-800);
        const stderrHead = stderrTail.split("\n").slice(0, 4).join(" | ");
        debug(
          "integration-loop",
          `VITEST CRASH exit=${vitest.exitCode} stderr[head]: ${stderrHead.slice(0, 400)}`,
        );
        failures.push({
          testName: "project.runner",
          message: `vitest exited ${vitest.exitCode} with no parseable test results. First stderr lines: ${stderrHead.slice(0, 500)}`,
          stackTrace: `stderr (last 2000 chars):\n${stderrTail}\n\nstdout (last 800 chars):\n${stdoutTail}`,
        });
      }
      // Symmetric synthetic for tsc-crash: when tsc exits non-zero
      // but our regex captured nothing (e.g., tsc itself blew up or
      // printed in an unexpected format), we still need SOMETHING
      // the loop can act on.
      if (tsc.exitCode !== 0 && tscFailures.length === 0) {
        const tscStderrTail = tsc.stderr.slice(-2000);
        const tscStdoutTail = tsc.stdout.slice(-2000);
        // tsc prints "error TSxxxx: ..." lines to STDOUT (not stderr).
        // Config-level errors (TS6053 no inputs, TS5023 unknown option)
        // have no file:line prefix, so parseTscErrors misses them —
        // the synthetic failure below is our only surfacing, hence
        // showing both streams in the debug.
        debug(
          "integration-loop",
          `TSC CRASH exit=${tsc.exitCode} stdout[head]: ${tscStdoutTail.split("\n").slice(0, 4).join(" | ").slice(0, 400)} stderr[head]: ${tscStderrTail.split("\n").slice(0, 4).join(" | ").slice(0, 400)}`,
        );
        failures.push({
          testName: "project.typecheck",
          message: `tsc exited ${tsc.exitCode} with no parseable errors (format change or tsc itself crashed).`,
          stackTrace: `stderr (last 2000 chars):\n${tscStderrTail}\n\nstdout (last 800 chars):\n${tscStdoutTail}`,
        });
      }
      return {
        ok:
          vitest.exitCode === 0 &&
          tsc.exitCode === 0 &&
          failures.length === 0,
        failures,
      };
    } finally {
      if (owned && dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
