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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ensureDepsInstalled } from "./install-deps.js";
import { repairPackageJson } from "./design-package-json-repair.js";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesignGraph } from "./design-graph.js";
import { debug } from "./debug.js";

/**
 * Phase M3 — per-projectDir file-content cache. Dispatch attempts
 * re-materialize EVERY file in the graph on each test run (so siblings'
 * green bodies reach disk). For an N-function project, that's N small
 * writes per attempt × many attempts. The cache tracks the last-written
 * SHA-256 per `<dir>/<relPath>` and skips `writeFile` when the content
 * is unchanged. Invalidated implicitly: if a caller deletes/renames the
 * projectDir, the old entries are harmless — they just won't match
 * whatever's being written to the new dir.
 */
const fileHashCache = new Map<string, string>();

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

async function writeFileIfChanged(
  full: string,
  content: string,
): Promise<boolean> {
  const h = shortHash(content);
  if (fileHashCache.get(full) === h && existsSync(full)) {
    return false;
  }
  await writeFile(full, content, "utf8");
  fileHashCache.set(full, h);
  return true;
}

export interface CandidateBody {
  module: string;
  name: string;
  /** Since Phase 3 (wrapper-kill): the COMPLETE file content
   *  (imports + signature + body). Kept named `body` for brevity
   *  across call sites; semantically this is the full file. */
  body: string;
}

export interface TestRunResult {
  ok: boolean;
  passed: number;
  failed: number;
  output: string;
  /** Stable, sorted list of fully-qualified failing test names. Used by
   *  the dispatcher to detect semantic stagnation — when the SAME set
   *  of tests fails across attempts, the Implementer isn't converging
   *  even if the error text wording differs. Optional for back-compat
   *  with older mocks; absent means "unknown." */
  failingTestNames?: string[];
  /** Map of fully-qualified test name → full `failureMessages[0]` text
   *  including the stack trace. Surfaced to the Implementer on request
   *  via the `stack-trace` info channel. Optional for back-compat. */
  fullFailureMessages?: Map<string, string>;
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
  /** Phase H1 — dispose is OPT-IN. Callers no longer invoke this in
   *  their finally block; by default the directory survives so the
   *  user can `cd` into it post-build. To clean up explicitly, set
   *  `RLM_DISPOSE_PROJECT_DIR=1` (respected by design-build and
   *  design-plan-integration) or call `dispose()` manually in tests. */
  dispose(): Promise<void>;
}

/**
 * Create a persistent project directory — materialize the full graph
 * once, keep the package.json/tsconfig/etc. warm across calls.
 *
 * Phase H1 — the project is NO LONGER auto-disposed. Callers can
 * `await dir.dispose()` when they want to remove it, but by default
 * the directory survives so the user can inspect what the LLM built.
 * Default location is `<repo>/benchmark/projects/rlm-<timestamp>/`
 * (previously `/tmp/rlm-project-XXXXXX/`) so the artifacts are where
 * the user expects to find them.
 */
export async function createProjectDir(
  graph: DesignGraph,
  options: {
    tmpRoot?: string;
    projectRoot?: string;
    /** Phase H3 — when provided, a failed `npm install` triggers a
     *  `repairPackageJson` round trip. Up to `maxRepairAttempts`
     *  repair+retry cycles before we give up and materialize anyway
     *  (the downstream dispatch will surface compile errors). */
    chat?: (prompt: string) => Promise<string>;
    maxRepairAttempts?: number;
  } = {},
): Promise<ProjectDir> {
  // Resolution order: explicit projectRoot (preferred) → tmpRoot
  // (back-compat for tests) → <repo>/benchmark/projects.
  // Under VITEST, default to the OS tmpdir so test runs never pollute
  // benchmark/projects (tests don't set projectRoot and accumulated
  // dirs there are just noise).
  const root =
    options.projectRoot ??
    options.tmpRoot ??
    (process.env.VITEST ? tmpdir() : defaultProjectRoot());
  await mkdir(root, { recursive: true });
  const stamp = projectTimestamp();
  const dir = path.join(root, `rlm-${stamp}`);
  await mkdir(dir, { recursive: true });
  debug("testrun", `created persistent project dir ${dir}`);
  const files = graph.materialize();
  const runtime = graph.getProjectConfig()?.runtime ?? "node";
  // Phase U5 — minimal scaffolding. Architect-authored package.json /
  // tsconfig in the asset map always wins; we only provide fallbacks.
  await writeScaffolding(
    dir,
    "package.json" in files,
    "tsconfig.json" in files,
    runtime,
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  // Phase H2 — install declared dependencies once, right after the
  // initial materialize. Phase H3 — when install fails and a `chat`
  // fn is available, loop through architect-driven repair rounds
  // until install succeeds or the budget runs out. Phase U4 — use
  // decisions.packageManager to pick npm / pnpm / yarn / bun / skip.
  const packageManager = graph.getProjectConfig()?.packageManager;
  const maxRepairAttempts = options.maxRepairAttempts ?? 3;
  let installRes = await ensureDepsInstalled(dir, { packageManager });
  if (!installRes.ok && options.chat) {
    for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
      debug(
        "testrun",
        `install failed (attempt ${attempt}/${maxRepairAttempts}) — invoking pkg-repair`,
      );
      const repair = await repairPackageJson(graph, installRes.stderr, {
        chat: options.chat,
      });
      if (!repair.ok) {
        debug("testrun", `pkg-repair gave up: ${repair.error}`);
        break;
      }
      // Rewrite package.json on disk from the revised graph asset.
      const revised =
        graph.getAsset("package.json") ??
        graph.getProjectConfig()?.packageJson;
      if (!revised) break;
      await writeFile(path.join(dir, "package.json"), revised, "utf8");
      installRes = await ensureDepsInstalled(dir, { packageManager });
      if (installRes.ok) break;
    }
  }
  if (!installRes.ok) {
    debug(
      "testrun",
      `npm install still FAILED after repair loop — proceeding; dispatch will surface the error: ${installRes.stderr.slice(0, 400)}`,
    );
  } else if (installRes.ran) {
    debug("testrun", `npm install OK in ${dir}`);
  }
  return {
    path: dir,
    async dispose() {
      debug("testrun", `disposing project dir ${dir}`);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function defaultProjectRoot(): string {
  // Walk upwards from this file looking for the repo root (the one
  // with a `benchmark/` dir). Fall back to cwd/benchmark/projects.
  let cur = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, "benchmark");
    if (existsSync(candidate)) return path.join(candidate, "projects");
    cur = path.dirname(cur);
  }
  return path.join(process.cwd(), "benchmark", "projects");
}

function projectTimestamp(): string {
  // e.g. "20260421-160115-abc1" — sortable + unique across rapid runs.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const salt = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${salt}`;
}

/**
 * Phase U5 — minimal scaffolding. The architect owns `package.json`
 * and `tsconfig.json` via phase-0 decisions (materialize emits them
 * from the graph's asset map). This helper only writes sensible
 * fallbacks for the files the architect did NOT provide, plus the
 * host `node_modules` symlink for Node-runtime projects.
 *
 * Previously we also wrote a `jest.config.js` when `framework === "jest"`
 * — retired. The architect now declares jest config via the project's
 * own `package.json` ("jest" field) or as an asset.
 */
async function writeScaffolding(
  dir: string,
  hasPackageJson: boolean,
  hasTsconfig: boolean,
  runtime: string = "node",
): Promise<void> {
  if (!hasPackageJson) {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "rlm-test", type: "module", private: true }),
      "utf8",
    );
  }
  if (!hasTsconfig) {
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
  }
  // Phase U9 — symlink the host's node_modules only for Node-runtime
  // projects. Deno resolves dependencies via URL imports; Bun uses its
  // central cache; neither benefits from (and may be confused by) a
  // node_modules tree dropped in.
  if (runtime === "node") {
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
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a shell-ish command into argv, honoring single- and double-quoted
 * segments. Backslash-escapes INSIDE quotes are preserved as-is (Node's
 * `spawn` doesn't interpret them — the caller gets the literal byte).
 * Not a full POSIX shell parser: no `$VAR` expansion, no `\\` escaping
 * outside quotes, no redirection tokens. Covers the common cases:
 *   npx vitest run
 *   node --test
 *   npx vitest run --dir "sub dir"
 *   bun test 'pattern with space'
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      continue;
    }
    if (/\s/.test(c)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
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
  // Test framework is a project-level choice made in phase 0. If phase
  // 0 didn't run (manual graphs in tests, resume from old disk state),
  // default to vitest to preserve previous behavior.
  const framework = graph.getProjectConfig()?.testFramework ?? "vitest";
  // Persistent-dir path: the caller manages lifecycle. Rewrite ALL
  // emitted files (not just the target's) so siblings' just-committed
  // implementations reach disk — a dispatch dependent (ordered after
  // its dep in topo sort) must see the dep's green body, not the stub
  // that was on disk at init time. Writing N small files is cheap
  // compared to a vitest run.
  if (options.projectDir) {
    const dir = options.projectDir;
    let wrote = 0;
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      if (await writeFileIfChanged(full, content)) wrote++;
    }
    debug(
      "testrun",
      `reused project dir ${dir} — rewrote ${wrote}/${Object.keys(files).length} files (rest unchanged)`,
    );
    // Phase H2 — if package.json was among the rewritten files,
    // `ensureDepsInstalled` will re-run the install. When unchanged,
    // the hash check skips the spawn. Phase U4 — honors
    // decisions.packageManager.
    const install = await ensureDepsInstalled(dir, {
      packageManager: graph.getProjectConfig()?.packageManager,
    });
    if (!install.ok) {
      debug(
        "testrun",
        `npm install FAILED mid-dispatch: ${install.stderr.slice(0, 400)}`,
      );
    }
    const result = await invokeTestRunner(
      dir,
      options,
      hasTests,
      framework,
      nameFilter,
      resolvePerNodeCommand(graph.getProjectConfig(), candidate.name),
    );
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
    await writeScaffolding(
      dir,
      "package.json" in files,
      "tsconfig.json" in files,
      graph.getProjectConfig()?.runtime ?? "node",
    );
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    debug(
      "testrun",
      `materialized ${Object.keys(files).length} files to ${dir} hasTests=${hasTests} filter=${nameFilter}`,
    );
    const result = await invokeTestRunner(
      dir,
      options,
      hasTests,
      framework,
      nameFilter,
      resolvePerNodeCommand(graph.getProjectConfig(), candidate.name),
    );
    debug(
      "testrun",
      `result ${candidate.module}#${candidate.name} ok=${result.ok} passed=${result.passed} failed=${result.failed}`,
    );
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Phase U12 — resolve the per-node test command. Prefer
 * `singleTestCommand` with `{file}` interpolated to `<name>.test.ts`
 * so dispatch spawns ONE test file. Fall back to `testCommand` when
 * `singleTestCommand` is absent (legacy graphs, VITEST-env tests). The
 * fallback keeps old call sites working; phase 0 now requires the new
 * field for every fresh run.
 */
function resolvePerNodeCommand(
  cfg: import("./design-graph.js").ProjectDecisions | null | undefined,
  candidateName: string,
): string | undefined {
  if (!cfg) return undefined;
  const tpl = cfg.singleTestCommand?.trim();
  if (tpl && tpl.length > 0) {
    return tpl.replaceAll("{file}", `${candidateName}.test.ts`);
  }
  return cfg.testCommand;
}

function invokeTestRunner(
  dir: string,
  options: RunTestsOptions,
  hasTests: boolean,
  framework: string,
  nameFilter: string | undefined,
  testCommand: string | undefined,
): Promise<TestRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Phase U1 — universal spawn. `decisions.testCommand` is REQUIRED in
  // production. Under VITEST (the harness's own test suite), fall back
  // to the legacy vitest/jest hardcoded spawn so existing tests keep
  // exercising that code path — but any real run must commit to a
  // testCommand at phase 0.
  let command: string;
  let args: string[];
  let useProjectDirAsCwd = false;
  const trimmedCommand = testCommand?.trim() ?? "";
  // Treat explicit-but-empty testCommand as misconfiguration — phase 0
  // committed to "run nothing," which is never what the architect
  // means. Only the VITEST fallback or a throw are valid downstream.
  if (trimmedCommand.length > 0) {
    const tokens = splitCommand(trimmedCommand);
    command = tokens[0];
    args = tokens.slice(1);
    useProjectDirAsCwd = true;
  } else if (process.env.VITEST) {
    // Test-suite fallback — keeps the existing `runTests — end-to-end
    // via vitest` tests working without setProjectConfig ceremony.
    if (framework === "jest") {
      command = "npx";
      args = ["jest", "--json", "--rootDir", dir];
    } else {
      command = "npx";
      args = ["vitest", "run", "--reporter=json", "--root", dir];
    }
    if (nameFilter) args.push("--testNamePattern", nameFilter);
  } else {
    throw new Error(
      "runTests: missing decisions.testCommand. Phase 0 must commit to a test framework + command before dispatch; the harness no longer defaults to vitest.",
    );
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: useProjectDirAsCwd ? dir : cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      const parsed = parseTestOutput(stdout);
      const output = buildTestOutput(parsed, stderr, hasTests, stdout);
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
        failingTestNames: parsed?.failingTestNames ?? [],
        fullFailureMessages: parsed?.fullFailureMessages ?? new Map(),
      });
    });
  });
}

/**
 * Scan stderr for well-known error markers and return the matching
 * lines. We surface these explicitly because the 800-char `stderr tail`
 * can push the actual diagnostic off-screen when noise (deprecation
 * warnings, long stack frames, vitest's own banner) comes after the
 * error line.
 */
export function extractStderrDiagnostic(stderr: string): string {
  if (!stderr) return "";
  const markers =
    /^.*\b(SyntaxError|TypeError|ReferenceError|RangeError|URIError|EvalError|Error \[ERR_[A-Z_]+\]):.*$/gm;
  const hits = stderr.match(markers);
  if (!hits || hits.length === 0) return "";
  // Dedupe in order, cap at a handful so a repeating error doesn't
  // dominate the prompt.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of hits) {
    const line = h.trim();
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= 4) break;
  }
  return lines.join("\n");
}

/** Extract jest-style "Test suite failed to run" errors from stdout.
 *  Jest's test-load failures go to stdout (human-readable) even under
 *  --json reporter — the JSON payload is incomplete in that case.
 *  Captures the "● Test suite failed to run" block until the next
 *  blank line so the implementer sees the parse / import error. */
export function extractStdoutDiagnostic(stdout: string): string {
  if (!stdout) return "";
  const sections: string[] = [];
  // Jest pattern: "● Test suite failed to run" followed by indented
  // lines. Capture until a blank line or end.
  const jestBlock =
    /(?:^|\n)(\s*●\s*Test suite failed to run[\s\S]*?)(?:\n\s*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = jestBlock.exec(stdout)) !== null) {
    sections.push(m[1].trim());
    if (sections.length >= 2) break;
  }
  // Vitest can print "SyntaxError" / "TypeError" to stdout too when the
  // file fails to transform. Scan those as a fallback.
  if (sections.length === 0) {
    const markers =
      /^.*\b(SyntaxError|TypeError|ReferenceError|RangeError|URIError|EvalError):.*$/gm;
    const hits = stdout.match(markers);
    if (hits) {
      const seen = new Set<string>();
      for (const h of hits) {
        const line = h.trim();
        if (seen.has(line)) continue;
        seen.add(line);
        sections.push(line);
        if (sections.length >= 4) break;
      }
    }
  }
  return sections.join("\n\n");
}

/**
 * Assemble the test-output blob fed back to the Implementer. Distinguishes
 * three cases:
 *   1. 0/0 + hasTests — the test FILE didn't load (vitest reported no
 *      tests ran). Leads with an explicit "TEST FILE DID NOT LOAD"
 *      banner so the Implementer knows it's a compile/import error,
 *      not an assertion failure.
 *
 *      INVARIANT: 0/0 means load failure (not a filtered-out test run)
 *      because `renderFunctionTestFile` always wraps tests in
 *      `describe(<fnName>)` and `runTests` filters with
 *      `^<fnName>\b` — the filter always matches at least the
 *      describe block. If that emitter convention ever changes, this
 *      banner's claim becomes unsound.
 *   2. Some tests ran (passed or failed counted) — emits the failure
 *      digest + counts + stderr tail as before.
 *   3. Parse failed entirely (non-null `parsed` required) — falls back
 *      to the raw stderr so the Implementer can still see something.
 */
export function buildTestOutput(
  parsed: VitestCounts | null,
  stderr: string,
  hasTests: boolean,
  stdout: string = "",
): string {
  if (!parsed) {
    // Parse fully failed — surface everything we have. Jest's test-
    // load errors go to stdout (JSON reporter doesn't intercept
    // them); vitest's go to stderr. Including both keeps the
    // implementer from missing the actual diagnostic.
    const parts: string[] = [];
    if (stderr.trim().length > 0) {
      parts.push(`----- stderr -----\n${stderr.slice(-1500)}`);
    }
    if (stdout.trim().length > 0) {
      parts.push(`----- stdout -----\n${stdout.slice(-1500)}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : stderr;
  }
  const sections: string[] = [];
  if (hasTests && parsed.passed === 0 && parsed.failed === 0) {
    sections.push(
      "[TEST FILE DID NOT LOAD — no tests ran.]",
      "The test file or the function body likely has a syntax error,",
      "bad import, or top-level throw preventing the module from",
      "loading. Check the key error(s) below and revise the body",
      "(and/or tests) so the file compiles, then resubmit. This is",
      "NOT an assertion failure.",
    );
  } else if (parsed.failureDigest) {
    sections.push(`----- failures -----\n${parsed.failureDigest}`);
  }
  // Surface the first few error lines near the top so they survive
  // even when the 800-char tail windows miss them. Scan BOTH streams:
  // jest emits "Test suite failed to run" blocks to stdout, vitest
  // pushes SyntaxError / TypeError to stderr. Without both, the
  // implementer sees "[TEST FILE DID NOT LOAD]" but no specifics.
  const stderrErrors = extractStderrDiagnostic(stderr);
  const stdoutErrors = extractStdoutDiagnostic(stdout);
  const keyErrors = [stderrErrors, stdoutErrors]
    .filter((s) => s.length > 0)
    .join("\n\n");
  if (keyErrors) {
    sections.push(`----- key errors -----\n${keyErrors}`);
  }
  sections.push(
    `----- counts -----\npassed=${parsed.passed} failed=${parsed.failed}`,
  );
  if (stdout.trim().length > 0) {
    sections.push(`----- stdout tail -----\n${stdout.slice(-800)}`);
  }
  if (stderr.trim().length > 0) {
    sections.push(`----- stderr tail -----\n${stderr.slice(-800)}`);
  }
  return sections.join("\n");
}

export interface VitestCounts {
  passed: number;
  failed: number;
  /** First-line assertion errors per failing test, joined for prompt feedback. */
  failureDigest: string;
  /** Fully-qualified names of failing tests (sorted, deduped). */
  failingTestNames: string[];
  /** Map of test name → full failure message (including stack trace). */
  fullFailureMessages: Map<string, string>;
}

/**
 * Phase F — universal TAP parser. Handles TAP13/14 output from any
 * runner (node:test, bun test, deno test --reporter=tap, tape, etc.).
 * Minimal by design: scan for `ok N` / `not ok N` lines, split the
 * directive from the description, accumulate a failure digest keyed by
 * the test's name.
 *
 * Tolerant of:
 *   - leading `TAP version 13` / `1..N` plan lines
 *   - YAML diagnostic blocks (`  ---` … `  ...`) — we capture their
 *     content as the failure message for the preceding `not ok`
 *   - `ok N - name` or `ok N name` (hyphen optional)
 *   - `SKIP` / `TODO` directives — counted as passed (SKIP) or failed
 *     (TODO) following common convention
 */
function parseTapOutput(stdout: string): VitestCounts | null {
  const lines = stdout.split("\n");
  let passed = 0;
  let failed = 0;
  let sawAnyTap = false;
  const failures: string[] = [];
  const failingNames = new Set<string>();
  const fullFailureMessages = new Map<string, string>();
  let pendingFailName: string | null = null;
  let yamlBuffer: string[] | null = null;
  const TAP_RE = /^(\s*)(ok|not ok)\s+(\d+)?\s*-?\s*(.*)$/;
  for (const raw of lines) {
    // YAML-block capture for a preceding "not ok".
    if (yamlBuffer !== null) {
      if (/^\s*\.\.\.\s*$/.test(raw)) {
        const joined = yamlBuffer.join("\n");
        if (pendingFailName) fullFailureMessages.set(pendingFailName, joined);
        yamlBuffer = null;
        pendingFailName = null;
        continue;
      }
      yamlBuffer.push(raw);
      continue;
    }
    if (/^\s*---\s*$/.test(raw) && pendingFailName !== null) {
      yamlBuffer = [];
      continue;
    }
    const m = raw.match(TAP_RE);
    if (!m) continue;
    const verdict = m[2];
    const rest = m[4].trim();
    const directive = /#\s*(SKIP|TODO)\b/i.exec(rest)?.[1]?.toUpperCase();
    // Strip directive comment from the displayed name.
    const name = rest.replace(/\s*#\s*(SKIP|TODO)\b.*$/i, "").trim() || "(unnamed)";
    sawAnyTap = true;
    if (verdict === "ok") {
      if (directive === "TODO") {
        failed++;
        failingNames.add(name);
        failures.push(`✗ ${name}: # TODO`);
      } else {
        passed++;
      }
    } else {
      if (directive === "SKIP") {
        passed++; // skipped-and-ok treated as non-failing
      } else {
        failed++;
        failingNames.add(name);
        failures.push(`✗ ${name}`);
        pendingFailName = name;
      }
    }
  }
  if (!sawAnyTap) return null;
  return {
    passed,
    failed,
    failureDigest: failures.slice(0, 20).join("\n"),
    failingTestNames: [...failingNames].sort(),
    fullFailureMessages,
  };
}

export { parseTapOutput };

/**
 * Phase F — try TAP first, fall back to JSON. TAP is the universal
 * contract the ProjectDecisions target; JSON is the legacy
 * (vitest/jest) path.
 */
export function parseTestOutput(stdout: string): VitestCounts | null {
  const tap = parseTapOutput(stdout);
  if (tap !== null) return tap;
  return parseVitestJson(stdout);
}

function parseVitestJson(stdout: string): VitestCounts | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const json = JSON.parse(stdout.slice(start));
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];
    const failingNames = new Set<string>();
    const fullFailureMessages = new Map<string, string>();
    const results = Array.isArray(json.testResults) ? json.testResults : [];
    for (const file of results) {
      for (const t of file.assertionResults ?? []) {
        if (t.status === "passed") passed++;
        else if (t.status === "failed") {
          failed++;
          const title = String(
            t.fullName ?? t.title ?? t.ancestorTitles?.join(" > ") ?? "(test)",
          );
          failingNames.add(title);
          const msgs = Array.isArray(t.failureMessages) ? t.failureMessages : [];
          const raw = (msgs[0] ?? "").toString();
          if (raw) fullFailureMessages.set(title, raw);
          const firstLine = raw.split("\n")[0].slice(0, 240);
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
      failingTestNames: [...failingNames].sort(),
      fullFailureMessages,
    };
  } catch {
    return null;
  }
}
