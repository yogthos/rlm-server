/**
 * Tree-sitter-backed analysis for a TypeScript function file. The
 * legacy ctx.fns-based analyzer (`analyzeBody`) was retired in Phase U8
 * once the natural-import model landed; this module now exports the
 * forward-looking functions only:
 *
 *   - `analyzeSource(src)` — extract top-level imports + direct-call
 *     targets used to maintain the in-memory call graph.
 *   - `collectNaturalViolations(opts)` — structural rejection rules for
 *     the Implementer dispatch loop (phantom relative imports, missing
 *     decomposed children).
 *
 * The parser is lazy-initialized once per process; subsequent calls
 * reuse it.
 */
import type { Node as TreeSitterNode } from "web-tree-sitter";
import {
  initTreeSitter,
  parse,
} from "./vendor/pi-code-graph/tree-sitter/index.js";
import { SupportedLanguage } from "./vendor/pi-code-graph/constants.js";

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initTreeSitter();
  return initPromise;
}

function stripStringQuotes(raw: string): string {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("`") && t.endsWith("`"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function extractImportSource(node: TreeSitterNode): string | null {
  const source = node.childForFieldName("source");
  if (!source) {
    for (const c of node.namedChildren) {
      if (c && c.type === "string") return stripStringQuotes(c.text);
    }
    return null;
  }
  return stripStringQuotes(source.text);
}

// ────────────────────────────────────────────────────────────────────
// Phase N4 — natural-mode structural violations.
//
// The only rules the harness mechanically enforces on an emitted
// implementation are:
//
//   (a) Relative imports must resolve to a known sibling. Catches the
//       model hallucinating a module file ("./types.js") that nobody
//       declared. External packages / node: built-ins are unrestricted
//       — tsc will catch missing runtime deps.
//
//   (b) Every `requiredChildren` entry must be reachable from the body.
//       Reachability: either directly imported + called, or transitively
//       reached through another known sibling (resolved via the caller-
//       supplied `resolveCallees`).
//
// Unparseable sources degrade gracefully to no violations — tsc will
// surface the real diagnostic; we don't want the analyzer itself to
// gate the dispatch.
// ────────────────────────────────────────────────────────────────────

export interface NaturalViolationOptions {
  source: string;
  /** Names of every function the graph knows about. Used to decide
   *  whether a `./<name>` relative import points to a real sibling or
   *  a hallucinated file. Include the target function's own name. */
  knownSiblings: Set<string>;
  /** Decomposition children this function MUST reach. Empty for
   *  leaves. Reachability: direct import + call, or transitive via
   *  `resolveCallees`. */
  requiredChildren?: readonly string[];
  /** Given a sibling name, return its analyzed callees (usually
   *  `graph.getFunction(...).analyzedCallees`). Enables transitive
   *  reachability. Omit to restrict to direct-call-only semantics. */
  resolveCallees?: (name: string) => readonly string[];
}

export async function collectNaturalViolations(
  opts: NaturalViolationOptions,
): Promise<string[]> {
  let analysis: NaturalAnalysis;
  try {
    analysis = await analyzeSource(opts.source);
  } catch {
    // Parse failure — don't gate. Let downstream (tsc / runner) catch
    // the real problem.
    return [];
  }
  const violations: string[] = [];
  // Rule (a): every relative import must name a known sibling. Scan
  // BOTH runtime imports (analysis.imports, skips type-only) AND
  // type-only imports. The latter aren't part of the call graph but
  // still produce TS2307 at compile time if the file doesn't exist —
  // and "import type ... from './types.js'" was the exact phantom-
  // module failure we saw in run 15.
  // Keep a map from source→line so violations can point the model at
  // the offending import.
  const relativeSources = new Map<string, number>();
  // From runtime imports (line attached by analyzeSource):
  for (const imp of analysis.imports) {
    if (imp.source.startsWith("./") && !relativeSources.has(imp.source)) {
      relativeSources.set(imp.source, imp.line);
    }
  }
  // From type-only imports (separate regex pass). Computes a 1-based
  // line number from the byte offset of the match.
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(opts.source)) !== null) {
    if (!m[1].startsWith("./")) continue;
    if (relativeSources.has(m[1])) continue;
    const line =
      opts.source.slice(0, m.index).split("\n").length; // 1-based
    relativeSources.set(m[1], line);
  }
  for (const [source, line] of relativeSources) {
    const parsed = source.match(/^\.\/(.+?)(?:\.js|\.ts)?$/);
    if (!parsed) continue;
    const base = parsed[1];
    if (!opts.knownSiblings.has(base)) {
      violations.push(
        `line ${line}: Relative import "${source}" references "${base}" which is NOT a function in the graph. Remove the import or declare the function first; do not fabricate shared modules like "./types.js" — the harness doesn't create them.`,
      );
    }
  }
  // Rule (b): requiredChildren reachability.
  if (opts.requiredChildren && opts.requiredChildren.length > 0) {
    const directNames = new Set<string>();
    for (const imp of analysis.imports) {
      const m = imp.source.match(/^\.\/(.+?)(?:\.js|\.ts)?$/);
      if (m && opts.knownSiblings.has(m[1])) directNames.add(m[1]);
    }
    // A name is directly invoked when it appears in imports and also
    // in callees under the same binding. The binding might differ from
    // the module name on renamed imports; treat the imported local
    // names as the call surface.
    const bindings = new Map<string, string>();
    for (const imp of analysis.imports) {
      const m = imp.source.match(/^\.\/(.+?)(?:\.js|\.ts)?$/);
      if (m && opts.knownSiblings.has(m[1])) {
        bindings.set(imp.name, m[1]);
      }
    }
    const calledSiblings = new Set<string>();
    for (const callee of analysis.callees) {
      const sibling = bindings.get(callee);
      if (sibling) calledSiblings.add(sibling);
    }
    // Transitive closure from directly-called siblings using
    // resolveCallees when provided.
    const reachable = new Set<string>(calledSiblings);
    if (opts.resolveCallees) {
      const queue: string[] = [...calledSiblings];
      while (queue.length > 0) {
        const name = queue.shift()!;
        for (const c of opts.resolveCallees(name)) {
          if (opts.knownSiblings.has(c) && !reachable.has(c)) {
            reachable.add(c);
            queue.push(c);
          }
        }
      }
    }
    const missing = opts.requiredChildren.filter((c) => !reachable.has(c));
    if (missing.length > 0) {
      const directSummary = calledSiblings.size > 0
        ? `Directly called: ${[...calledSiblings].sort().join(", ")}`
        : `Your body calls no siblings at all`;
      const transitiveExtra = opts.resolveCallees
        ? `. Transitive reach: ${[...reachable].sort().join(", ") || "(none)"}`
        : "";
      violations.push(
        `Decomposed children not reached: ${missing.sort().join(", ")}. ${directSummary}${transitiveExtra}. Import + call each child, or reach it through another sibling you do call.`,
      );
    }
  }
  return violations;
}

// ────────────────────────────────────────────────────────────────────
// Phase N1 — natural-style analysis.
//
// Extracts what the in-memory graph wants to know about a plain TS
// file: which modules it imports at the top level (and under which
// local name), and which bare-identifier function calls it makes.
// This replaces the ctx.fns-based introspection as we migrate away
// from the ctx convention.
//
// Scope: whole file. Under the one-file-per-function convention,
// anything at file scope is part of the function's implementation.
// ────────────────────────────────────────────────────────────────────

export interface NaturalImport {
  /** The literal string in `from "..."`. Project-relative for siblings,
   *  bare for externals. */
  source: string;
  /** The local binding name the body uses for this import. For a
   *  default import, the binding the user wrote. For a named import,
   *  the renamed alias when `as` is used, otherwise the imported name.
   *  For a namespace import, the alias. */
  name: string;
  /** True for `import <name> from "..."`. False for named imports and
   *  namespace imports (`*`). Useful downstream so call-graph
   *  resolution can distinguish default vs. named bindings. */
  isDefault: boolean;
  /** 1-based source line of the enclosing `import` statement. Lets
   *  violation messages point the Implementer at the offending line. */
  line: number;
}

export interface NaturalAnalysis {
  imports: NaturalImport[];
  /** Bare-identifier function call targets, deduped and sorted.
   *  Member calls (`obj.method()`) are NOT included — they aren't
   *  sibling invocations in the one-default-export model. */
  callees: string[];
}

export async function analyzeSource(source: string): Promise<NaturalAnalysis> {
  await ensureInit();
  const tree = await parse(source, SupportedLanguage.TS);
  const root = tree.rootNode;
  const imports: NaturalImport[] = [];
  const calleeSet = new Set<string>();

  for (const top of root.namedChildren) {
    if (!top) continue;
    if (top.type !== "import_statement") continue;
    // Drop `import type ...` entirely — type-only deps aren't runtime.
    if (isTypeOnlyImport(top)) continue;
    const src = extractImportSource(top);
    if (src === null) continue;
    const importClause = top.namedChildren.find(
      (c) => c !== null && c.type === "import_clause",
    );
    if (!importClause) continue;
    collectImportsFromClause(importClause, src, top.startPosition.row + 1, imports);
  }

  const visit = (node: TreeSitterNode): void => {
    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode && fnNode.type === "identifier") {
        calleeSet.add(fnNode.text);
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);

  return {
    imports,
    callees: [...calleeSet].sort(),
  };
}

/** `import type { T } from "./x"` — the whole statement is type-only.
 *  Tree-sitter exposes the `type` keyword as the first child when
 *  present; check both that shape and the text prefix as a fallback. */
function isTypeOnlyImport(node: TreeSitterNode): boolean {
  // Look at the raw text prefix — robust across TS grammar versions.
  const prefix = node.text.trimStart();
  return /^import\s+type\b/.test(prefix);
}

function collectImportsFromClause(
  clause: TreeSitterNode,
  source: string,
  line: number,
  out: NaturalImport[],
): void {
  for (const child of clause.namedChildren) {
    if (!child) continue;
    if (child.type === "identifier") {
      // Default import: `import foo from "..."`.
      out.push({ source, name: child.text, isDefault: true, line });
      continue;
    }
    if (child.type === "namespace_import") {
      // `import * as X from "..."`.
      const alias = child.namedChildren.find(
        (c) => c !== null && c.type === "identifier",
      );
      if (alias) {
        out.push({ source, name: alias.text, isDefault: false, line });
      }
      continue;
    }
    if (child.type === "named_imports") {
      for (const specNode of child.namedChildren) {
        if (!specNode) continue;
        if (specNode.type !== "import_specifier") continue;
        // Drop specifiers that are themselves type-only
        // (`{ type T, real }`).
        if (/^\s*type\s/.test(specNode.text)) continue;
        const nameNode = specNode.childForFieldName("name");
        const aliasNode = specNode.childForFieldName("alias");
        const bound = (aliasNode ?? nameNode)?.text;
        if (!bound) continue;
        out.push({ source, name: bound, isDefault: false, line });
      }
    }
  }
}
