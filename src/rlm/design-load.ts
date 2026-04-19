/**
 * Load an existing proc-ts project into the DesignGraph.
 *
 * Scope: a proc-ts-style `.ts` file (filename = function name) where
 * each file has exactly one `export default function name(ctx: Ctx, …)`.
 * Extracts the signature (ignoring the injected `ctx: Ctx` first param)
 * and the body, then registers the function on the graph.
 *
 * `designLoad(graph, path)` accepts either a single file or a directory.
 * For a directory, every non-test `.ts` file is imported; `<name>.test.ts`
 * and `ctx.ts` / `ctx_fns.d.ts` are skipped.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DesignGraph, ParamSpec, Signature } from "./design-graph.js";
import { debug } from "./debug.js";

export interface LoadedFunction {
  name: string;
  signature: Signature;
  body: string;
}

export interface LoadReport {
  path: string;
  functions: string[];
  skipped: string[];
}

const EXPORT_FN_RE =
  /export\s+(?:default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^\s{][^{]*?))?\s*\{/g;

function parseParams(raw: string): ParamSpec[] {
  if (!raw.trim()) return [];
  let parts = splitTopLevel(raw);
  // Strip a leading param literally named `ctx` (regardless of its
  // annotated type). Proc-ts always injects `ctx: Ctx` first; our
  // graph stores business-logic params only. Matching by name keeps
  // this robust against custom Ctx types (`AppCtx`, `TestCtx`, etc.).
  if (parts.length > 0) {
    const first = parts[0].trim();
    if (/^ctx\b/.test(first)) {
      parts = parts.slice(1);
    }
  }
  return parts.map((part) => {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      const eq = trimmed.indexOf("=");
      const nameRaw = eq < 0 ? trimmed : trimmed.slice(0, eq).trim();
      const name = nameRaw.replace(/\?$/, "");
      return {
        name,
        type: "unknown",
        optional: nameRaw.endsWith("?"),
        ...(eq >= 0 ? { defaultValue: trimmed.slice(eq + 1).trim() } : {}),
      };
    }
    const nameRaw = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    const eq = rest.indexOf("=");
    const type = (eq < 0 ? rest : rest.slice(0, eq).trim()) || "unknown";
    const name = nameRaw.replace(/\?$/, "");
    return {
      name,
      type,
      optional: nameRaw.endsWith("?"),
      ...(eq >= 0 ? { defaultValue: rest.slice(eq + 1).trim() } : {}),
    };
  });
}

/** Split a parameter list on commas at nesting depth 0 only. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.filter((p) => p.trim().length > 0);
}

/** Find the matching closing brace for the `{` at `openIdx`, respecting nesting. */
function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseExports(source: string): LoadedFunction[] {
  const out: LoadedFunction[] = [];
  const re = new RegExp(EXPORT_FN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const isAsync = Boolean(match[1]);
    const name = match[2];
    const paramsRaw = match[3];
    const returnType = (match[4] ?? "").trim() || "unknown";
    const openIdx = match.index + match[0].length - 1; // points at '{'
    const closeIdx = findMatchingBrace(source, openIdx);
    if (closeIdx < 0) continue;
    const body = source.slice(openIdx + 1, closeIdx).trim();
    out.push({
      name,
      signature: { params: parseParams(paramsRaw), returnType, isAsync },
      body,
    });
  }
  return out;
}

function skippableFile(name: string): boolean {
  if (name === "ctx.ts") return true;
  if (name.endsWith(".d.ts")) return true;
  if (name.endsWith(".test.ts")) return true;
  if (!name.endsWith(".ts")) return true;
  return false;
}

async function loadSingleFile(
  graph: DesignGraph,
  cwd: string,
  relPath: string,
): Promise<LoadReport> {
  const abs = relPath.startsWith("/") ? relPath : path.join(cwd, relPath);
  debug("load", `reading ${abs}`);
  const source = await readFile(abs, "utf8");
  debug("load", `parsed ${source.length}ch from ${relPath}`);
  graph.addModule(relPath);
  const fns = parseExports(source);
  const report: LoadReport = { path: relPath, functions: [], skipped: [] };
  for (const fn of fns) {
    try {
      if (graph.getFunction(relPath, fn.name)) {
        graph.setImplementation(relPath, fn.name, fn.body);
      } else {
        graph.addFunction(relPath, fn.name, fn.signature, "", "load");
        graph.setImplementation(relPath, fn.name, fn.body);
      }
      report.functions.push(fn.name);
    } catch (e) {
      debug(
        "load",
        `skip ${relPath}#${fn.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
      report.skipped.push(fn.name);
    }
  }
  return report;
}

/**
 * Load a file or a directory into the graph. Always returns an array
 * of LoadReport for a uniform caller contract — single-file loads
 * return a one-element array. Directories skip `ctx.ts`, `*.d.ts`,
 * `*.test.ts`, and non-`.ts` files; recursion is not performed
 * (proc-ts layout is flat).
 */
export async function designLoad(
  graph: DesignGraph,
  loadPath: string,
  opts: { cwd?: string } = {},
): Promise<LoadReport[]> {
  const cwd = opts.cwd ?? process.cwd();
  const abs = loadPath.startsWith("/") ? loadPath : path.join(cwd, loadPath);
  const info = await stat(abs);
  if (info.isDirectory()) {
    const entries = await readdir(abs);
    const reports: LoadReport[] = [];
    for (const entry of entries.sort()) {
      if (skippableFile(entry)) {
        debug("load", `skip directory entry ${entry}`);
        continue;
      }
      const relPath = path.join(loadPath, entry);
      const r = await loadSingleFile(graph, cwd, relPath);
      reports.push(r);
    }
    debug(
      "load",
      `loaded directory ${loadPath}: ${reports.length} files, ${reports.reduce((n, r) => n + r.functions.length, 0)} functions`,
    );
    return reports;
  }
  const r = await loadSingleFile(graph, cwd, loadPath);
  debug(
    "load",
    `loaded ${loadPath}: ${r.functions.length} functions, ${r.skipped.length} skipped`,
  );
  return [r];
}
