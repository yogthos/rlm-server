/**
 * Phase H2 — ensure declared dependencies are installed in a project
 * directory. Runs `npm install` (or the caller's chosen installer)
 * exactly once per unique package.json content: a SHA-256 hash of the
 * file is stored in `${dir}/.rlm-install-hash` after a successful
 * install, and subsequent calls skip the installer until the hash
 * changes.
 *
 * The installer is injectable (`opts.runInstall`) for testability —
 * the default spawns `npm install` in `dir` and captures stderr.
 * Malformed `package.json` is surfaced as an install failure BEFORE
 * spawning, so the downstream repair loop sees a JSON parse error as
 * plainly as a missing-package error.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { debug } from "./debug.js";

export interface InstallResult {
  ok: boolean;
  /** True when the installer actually ran (first call, or after a
   *  package.json change). False when we skipped because the hash was
   *  up to date. */
  ran: boolean;
  /** Captured stderr (or synthetic message for malformed package.json).
   *  Empty on success or when no-op. */
  stderr: string;
  /** Hash we computed for the current package.json. Empty when no
   *  package.json exists. */
  hash: string;
}

export interface InstallCommand {
  bin: string;
  args: string[];
}

export interface EnsureDepsOptions {
  /** Phase U4 — which package manager to invoke. Resolved from
   *  `decisions.packageManager`. Defaults to `npm`. `(none)` is a
   *  sentinel meaning "skip install entirely" (for runtimes like
   *  deno/bun-script that resolve imports at runtime without a local
   *  install step). */
  packageManager?: string;
  /** Injected installer — primarily for tests. Receives the project
   *  dir AND the resolved install command; returns `{ ok, stderr }`.
   *  Default spawns the command. */
  runInstall?: (
    dir: string,
    cmd: InstallCommand,
  ) => Promise<{ ok: boolean; stderr: string }>;
  /** Timeout for the default install spawn. Ignored when
   *  `runInstall` is injected. */
  timeoutMs?: number;
}

/**
 * Phase U4 — resolve which package manager to invoke. Returns the
 * binary and args to pass to `spawn()`. A sentinel result with
 * `bin === ""` means "skip install" — caller treats it as a no-op.
 */
export function buildInstallCommand(
  packageManager?: string,
): InstallCommand {
  const pm = (packageManager ?? "npm").trim();
  if (pm === "(none)" || pm === "" || pm === "none") {
    return { bin: "", args: [] };
  }
  switch (pm) {
    case "npm":
      return { bin: "npm", args: ["install", "--no-audit", "--no-fund"] };
    case "pnpm":
      return { bin: "pnpm", args: ["install"] };
    case "yarn":
      return { bin: "yarn", args: ["install"] };
    case "bun":
      return { bin: "bun", args: ["install"] };
    default:
      throw new Error(
        `unknown packageManager "${packageManager}" — supported: npm, pnpm, yarn, bun, (none)`,
      );
  }
}

const HASH_FILE = ".rlm-install-hash";

export async function ensureDepsInstalled(
  dir: string,
  opts: EnsureDepsOptions = {},
): Promise<InstallResult> {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return { ok: true, ran: false, stderr: "", hash: "" };
  }
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch (e) {
    return {
      ok: false,
      ran: false,
      stderr: `could not read package.json: ${e instanceof Error ? e.message : String(e)}`,
      hash: "",
    };
  }
  // Validate JSON shape BEFORE invoking the installer — gives the
  // repair loop a direct parse-error signal without burning an
  // `npm install` round-trip on garbage input.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      ran: false,
      stderr: `package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      hash: "",
    };
  }
  // Fast path: no runtime dependencies declared ⇒ nothing to install.
  // Lets tests that fabricate a minimal package.json skip the npm
  // spawn entirely without needing to inject a mock runner.
  const deps = countDeps(parsed);
  if (deps === 0) {
    return { ok: true, ran: false, stderr: "", hash: sha256(raw) };
  }
  const hash = sha256(raw);
  const hashPath = path.join(dir, HASH_FILE);
  if (existsSync(hashPath)) {
    try {
      const prior = (await readFile(hashPath, "utf8")).trim();
      if (prior === hash) {
        return { ok: true, ran: false, stderr: "", hash };
      }
    } catch {
      /* fall through — treat as stale */
    }
  }
  // Phase U4 — resolve the install command from decisions.packageManager.
  // Sentinel "(none)" skips install entirely for runtimes that don't
  // need a local node_modules tree.
  let cmd: InstallCommand;
  try {
    cmd = buildInstallCommand(opts.packageManager);
  } catch (e) {
    return {
      ok: false,
      ran: false,
      stderr: e instanceof Error ? e.message : String(e),
      hash,
    };
  }
  if (cmd.bin === "") {
    return { ok: true, ran: false, stderr: "", hash };
  }
  // In tests (VITEST=true), skip the default installer unless one is
  // explicitly injected. Tests that exercise install semantics pass
  // `runInstall`; the rest just want createProjectDir to no-op here.
  if (!opts.runInstall && process.env.VITEST) {
    return { ok: true, ran: false, stderr: "", hash };
  }
  const runner =
    opts.runInstall ?? ((d, c) => defaultInstall(d, c, opts.timeoutMs));
  debug("install-deps", `running ${cmd.bin} ${cmd.args.join(" ")} in ${dir}`);
  const result = await runner(dir, cmd);
  if (!result.ok) {
    return { ok: false, ran: true, stderr: result.stderr, hash };
  }
  await writeFile(hashPath, hash, "utf8");
  return { ok: true, ran: true, stderr: result.stderr, hash };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function countDeps(pkg: Record<string, unknown>): number {
  let total = 0;
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const v = pkg[key];
    // Guard: a well-formed package.json has deps as an object-map, but
    // a hand-rolled or hallucinated one might put a string/array/null
    // there. Only count plain object-maps; ignore anything else
    // (caller treats "0 deps" as "skip install", which is safe).
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      total += Object.keys(v as Record<string, unknown>).length;
    }
  }
  return total;
}

function defaultInstall(
  dir: string,
  cmd: InstallCommand,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd.bin, cmd.args, {
      cwd: dir,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        stderr: `${cmd.bin} ${cmd.args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`,
      });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      // `npm install`'s informational output lands on stdout ("added X
      // packages"). Merge both streams so the repair loop sees the
      // actual error content.
      const out = [stderr, stdout].filter((s) => s.trim().length > 0).join("\n");
      resolve({ ok: code === 0, stderr: out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: `failed to spawn ${cmd.bin}: ${e.message}` });
    });
  });
}
