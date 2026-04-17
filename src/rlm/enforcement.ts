/**
 * Five-layer mechanical enforcement for hierarchical agents.
 * See docs/hierarchical-agents.md §3.4.
 *
 * Layers (cheapest first, each gates the next):
 *   1. parse      — tree-sitter syntax check
 *   2. typecheck  — tsc --noEmit (shell-out; optional for now)
 *   3. structural — tree-sitter → Prolog facts, run canned rules + per-envelope contract
 *   4. lint       — biome/eslint (advisory; optional)
 *   5. test       — vitest run (shell-out; optional for now)
 */

import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseSource, parseSourceAsync, getLanguageForFile } from "./graph/parser.js";
import {
  extractStructuralFacts,
  structuralFactsToProlog,
} from "./structural-facts.js";
import { prologBatchQuery } from "./prolog-bridge.js";
import type { FileSet, TestContract } from "./envelopes.js";

export type LayerName = "parse" | "typecheck" | "structural" | "lint" | "test";
export type LayerStatus = "pass" | "fail" | "skipped" | "advisory";
export type Severity = "blocking" | "advisory";

export interface LayerError {
  severity: Severity;
  layer: LayerName;
  message: string;
  file?: string;
  line?: number;
}

export interface LayerResult {
  status: LayerStatus;
  errors: LayerError[];
  durationMs: number;
}

export interface EnforceReport {
  ok: boolean;
  layers: Record<LayerName, LayerResult>;
  blockingErrors: LayerError[];
}

export interface EnforceOptions {
  artifact: FileSet;
  tests: TestContract;
  structuralContract?: string;
  skipLayers?: LayerName[];
  workDir?: string;
}

const ALL_LAYERS: LayerName[] = ["parse", "typecheck", "structural", "lint", "test"];

/**
 * Stable anchor for paths that must resolve independent of `process.cwd()`.
 * From `src/rlm/enforcement.ts`, two levels up is the project root; from the
 * built `dist/rlm/enforcement.js`, two levels up is also the project root.
 */
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROJECT_TSC = resolve(PROJECT_ROOT, "node_modules/.bin/tsc");
const PROJECT_TYPE_ROOTS = resolve(PROJECT_ROOT, "node_modules/@types");

let cachedRules: string | null = null;
async function loadRules(): Promise<string> {
  if (cachedRules !== null) return cachedRules;
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Source lives at src/rlm/structural-rules.pl; this file is co-located.
  cachedRules = await readFile(resolve(here, "structural-rules.pl"), "utf8");
  return cachedRules;
}

function skippedResult(): LayerResult {
  return { status: "skipped", errors: [], durationMs: 0 };
}

export async function enforce(opts: EnforceOptions): Promise<EnforceReport> {
  // Detect file-path collisions between artifact and test files up front.
  // Silently overwriting the artifact with a test file would corrupt the run.
  const collisions = Object.keys(opts.artifact).filter((p) => p in opts.tests.files);
  if (collisions.length > 0) {
    throw new Error(
      `enforce: file-path collision between artifact and tests.files: ${collisions.join(", ")}`,
    );
  }

  const skip = new Set<LayerName>(opts.skipLayers ?? []);
  const layers: Record<LayerName, LayerResult> = {
    parse: skippedResult(),
    typecheck: skippedResult(),
    structural: skippedResult(),
    lint: skippedResult(),
    test: skippedResult(),
  };

  // Layer 1: parse
  if (!skip.has("parse")) {
    layers.parse = await parseLayer(opts.artifact);
  }
  // Parse failure short-circuits everything else except typecheck/lint/test
  // which are already-skipped in quick mode. They stay skipped either way.
  const parseBlocks = layers.parse.status === "fail";

  // Layer 2: typecheck
  if (!skip.has("typecheck") && !parseBlocks) {
    layers.typecheck = await typecheckLayer(opts.artifact, opts.tests);
  }

  // Layer 3: structural
  if (!skip.has("structural") && !parseBlocks) {
    layers.structural = await structuralLayer(opts.artifact, opts.structuralContract);
  }

  // Layer 4: lint (advisory, off by default until wired)
  if (!skip.has("lint") && !parseBlocks) {
    layers.lint = await lintLayer();
  }

  // Layer 5: test (stub — shell-out deferred to round 2)
  if (!skip.has("test") && !parseBlocks) {
    layers.test = await testLayer();
  }

  const blockingErrors: LayerError[] = [];
  for (const name of ALL_LAYERS) {
    for (const e of layers[name].errors) {
      if (e.severity === "blocking") blockingErrors.push(e);
    }
  }

  return {
    ok: blockingErrors.length === 0,
    layers,
    blockingErrors,
  };
}

async function parseLayer(artifact: FileSet): Promise<LayerResult> {
  const started = Date.now();
  const errors: LayerError[] = [];

  for (const [path, content] of Object.entries(artifact)) {
    const lang = getLanguageForFile(path);
    if (!lang) continue;
    const tree = parseSource(content, path) ?? (await parseSourceAsync(content, path));
    if (!tree) continue;

    try {
      const root = tree.rootNode;
      if (root.hasError) {
        const loc = findFirstError(root);
        errors.push({
          severity: "blocking",
          layer: "parse",
          message: `parse error in ${path}`,
          file: path,
          line: loc?.line,
        });
      }
    } finally {
      (tree as any).delete?.();
    }
  }

  return {
    status: errors.length > 0 ? "fail" : "pass",
    errors,
    durationMs: Date.now() - started,
  };
}

function findFirstError(node: any): { line: number } | null {
  const missing = typeof node.isMissing === "function" ? node.isMissing() : !!node.isMissing;
  if (node.type === "ERROR" || missing) {
    return { line: node.startPosition.row + 1 };
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.hasError) {
      const found = findFirstError(child);
      if (found) return found;
    }
  }
  return null;
}

async function typecheckLayer(
  artifact: FileSet,
  tests: TestContract,
): Promise<LayerResult> {
  const started = Date.now();
  const tmp = await mkdtemp(join(tmpdir(), "rlm-enforce-"));
  try {
    await writeFiles(tmp, artifact);
    await writeFiles(tmp, tests.files);
    await writeFile(
      join(tmp, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "es2022",
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            typeRoots: [PROJECT_TYPE_ROOTS],
          },
          include: ["**/*.ts", "**/*.tsx"],
        },
        null,
        2,
      ),
    );

    const { stdout, code } = await runCommand(PROJECT_TSC, ["--noEmit", "-p", tmp], tmp);
    if (code === 0) {
      return { status: "pass", errors: [], durationMs: Date.now() - started };
    }
    const errors: LayerError[] = parseTscOutput(stdout);
    return { status: "fail", errors, durationMs: Date.now() - started };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function parseTscOutput(output: string): LayerError[] {
  const errors: LayerError[] = [];
  const re = /^(.+?)\((\d+),\d+\): error TS\d+: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      severity: "blocking",
      layer: "typecheck",
      message: m[3],
      file: m[1],
      line: Number(m[2]),
    });
  }
  if (errors.length === 0 && output.trim()) {
    errors.push({
      severity: "blocking",
      layer: "typecheck",
      message: output.trim().slice(0, 500),
    });
  }
  return errors;
}

async function writeFiles(root: string, files: FileSet): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? -1 });
    });
    proc.on("error", () => {
      resolvePromise({ stdout, stderr, code: -1 });
    });
  });
}

async function structuralLayer(
  artifact: FileSet,
  contract?: string,
): Promise<LayerResult> {
  const started = Date.now();
  const errors: LayerError[] = [];

  const files = Object.entries(artifact).map(([path, content]) => ({ path, content }));
  const facts = await extractStructuralFacts(files);
  const factProgram = structuralFactsToProlog(facts);
  const rules = await loadRules();
  const program = [factProgram, rules, contract ?? ""].filter(Boolean).join("\n");

  // Batch all three queries against a single consulted session — ~3x faster
  // than issuing them one by one (which re-consults the fact program each time).
  const goals = contract
    ? ["blocking_violation(Kind, Name).", "forbidden.", "advisory_violation(Kind, Name)."]
    : ["blocking_violation(Kind, Name).", "advisory_violation(Kind, Name)."];
  const results = await prologBatchQuery(program, goals);
  const [blocking, maybeForbid, maybeAdvisory] = results;
  const advisory = contract ? maybeAdvisory : maybeForbid;
  const forbid = contract ? maybeForbid : null;

  if (blocking.status === "success") {
    for (const ans of blocking.answers ?? []) {
      const kind = ans.bindings.Kind ?? "?";
      const name = ans.bindings.Name ?? "?";
      errors.push({
        severity: "blocking",
        layer: "structural",
        message: `blocking structural violation [${kind}]: ${name}`,
      });
    }
  }

  if (forbid && forbid.status === "success" && (forbid.answers ?? []).length > 0) {
    errors.push({
      severity: "blocking",
      layer: "structural",
      message: `envelope structural contract violated (forbidden)`,
    });
  }

  if (advisory.status === "success") {
    for (const ans of advisory.answers ?? []) {
      const kind = ans.bindings.Kind ?? "?";
      const name = ans.bindings.Name ?? "?";
      errors.push({
        severity: "advisory",
        layer: "structural",
        message: `advisory [${kind}]: ${name}`,
      });
    }
  }

  const hasBlocking = errors.some((e) => e.severity === "blocking");
  return {
    status: hasBlocking ? "fail" : "pass",
    errors,
    durationMs: Date.now() - started,
  };
}

async function lintLayer(): Promise<LayerResult> {
  // Deferred to round 2. Advisory by design.
  return { status: "skipped", errors: [], durationMs: 0 };
}

async function testLayer(): Promise<LayerResult> {
  // Deferred to round 2 (shell-out to vitest run).
  return { status: "skipped", errors: [], durationMs: 0 };
}
