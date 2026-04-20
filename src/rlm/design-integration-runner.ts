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

export interface IntegrationRunnerOptions {
  /** Reuse an existing project dir instead of materializing a fresh
   *  one. When set, the runner rewrites only changed files. */
  projectDir?: string;
  timeoutMs?: number;
}

/**
 * Parse vitest --reporter=json stdout into structured failures.
 *
 * Pure function — takes a JSON string, returns `IntegrationFailure[]`.
 * Safe on malformed input (returns empty array), so a non-JSON
 * stderr / crash surface produces zero failures rather than throwing.
 */
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
      const vitest = await shellOut(
        "npx",
        ["vitest", "run", "--reporter=json", "--root", dir],
        dir,
        timeoutMs,
      );
      const failures = parseVitestFailures(vitest.stdout);
      debug(
        "integration-loop",
        `ran vitest — exit=${vitest.exitCode} failures=${failures.length}`,
      );
      // If vitest crashed / was SIGKILL'd and stdout has no parseable
      // failures, we'd silently return `ok:false, failures:[]` and the
      // integration loop would bail with "no failures attributable."
      // Synthesize a diagnostic failure so the loop / user knows the
      // runner itself went sideways.
      if (vitest.exitCode !== 0 && failures.length === 0) {
        const stderrTail = vitest.stderr.slice(-2000);
        const stdoutTail = vitest.stdout.slice(-800);
        // Log a short excerpt of stderr prominently — when this
        // happens, the real error (syntax error in the test file,
        // missing import, etc.) is almost always in stderr. Without
        // visibility here, the integration loop just spins dispatching
        // function fixes that can't resolve a test-file problem.
        const stderrHead = stderrTail.split("\n").slice(0, 4).join(" | ");
        debug(
          "integration-loop",
          `RUNNER CRASH exit=${vitest.exitCode} stderr[head]: ${stderrHead.slice(0, 400)}`,
        );
        return {
          ok: false,
          failures: [
            {
              testName: "project.runner",
              message: `vitest exited ${vitest.exitCode} with no parseable test results (timeout ${timeoutMs}ms may have fired). First stderr lines: ${stderrHead.slice(0, 500)}`,
              stackTrace: `stderr (last 2000 chars):\n${stderrTail}\n\nstdout (last 800 chars):\n${stdoutTail}`,
            },
          ],
        };
      }
      return {
        ok: vitest.exitCode === 0 && failures.length === 0,
        failures,
      };
    } finally {
      if (owned && dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
