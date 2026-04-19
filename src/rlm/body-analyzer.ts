/**
 * Static analysis for a proc-ts function body. Runs tree-sitter over the
 * source and extracts a small set of facts the dispatcher and Architect
 * review step want to verify mechanically:
 *
 *   - `ctx.fns.<name>(...)` call sites — used to cross-check declared
 *     spec.dependencies and to flag undeclared siblings.
 *   - Top-level `import X from "Y"` statements — forbidden in proc-ts
 *     (bodies must use dynamic `require(...)` or `await import(...)`).
 *   - `await` usage — helps catch async/returnType mismatches.
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

export interface CtxFnCallSite {
  name: string;
  /** 1-based line number where the call appears. */
  line: number;
}

export interface ImportSite {
  source: string;
  /** 1-based line number. */
  line: number;
}

export interface BodyAnalysis {
  ctxFnsCalls: CtxFnCallSite[];
  /** Top-level `import X from "Y"` statements. Empty in a conforming
   *  proc-ts body. Each entry carries the source string + line number. */
  imports: ImportSite[];
  /** True if the body uses `await` anywhere. */
  hasAwait: boolean;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initTreeSitter();
  return initPromise;
}

/**
 * Parse a proc-ts body and collect structural facts. The body is the
 * Implementer's output — statements only, no function declaration
 * wrapping. We feed it to tree-sitter-typescript raw; tree-sitter
 * tolerates top-level statements with error recovery, and the calls /
 * imports / awaits we care about survive any recovery.
 */
export async function analyzeBody(source: string): Promise<BodyAnalysis> {
  await ensureInit();
  const tree = await parse(source, SupportedLanguage.TS);
  const root = tree.rootNode;
  const ctxFnsCalls: CtxFnCallSite[] = [];
  const imports: ImportSite[] = [];
  let hasAwait = false;

  const visit = (node: TreeSitterNode): void => {
    switch (node.type) {
      case "call_expression": {
        const callName = extractCtxFnsCallName(node);
        if (callName !== null) {
          ctxFnsCalls.push({
            name: callName,
            line: node.startPosition.row + 1,
          });
        }
        break;
      }
      case "import_statement": {
        const src = extractImportSource(node);
        if (src !== null)
          imports.push({ source: src, line: node.startPosition.row + 1 });
        break;
      }
      case "await_expression":
        hasAwait = true;
        break;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return { ctxFnsCalls, imports, hasAwait };
}

/**
 * When `node` is a `ctx.fns.<name>(...)` call, return `<name>`. Returns
 * null for any other call shape (bare names, ctx.state.foo(), fns.x(),
 * foo.bar.baz(), etc.).
 */
function extractCtxFnsCallName(node: TreeSitterNode): string | null {
  // call_expression shape: { function: <expr>, arguments: ... }
  const fnNode = node.childForFieldName("function");
  if (!fnNode || fnNode.type !== "member_expression") return null;
  // member_expression: { object: <expr>, property: <property_identifier> }
  const property = fnNode.childForFieldName("property");
  const object = fnNode.childForFieldName("object");
  if (!property || !object) return null;
  if (object.type !== "member_expression") return null;
  const innerObject = object.childForFieldName("object");
  const innerProperty = object.childForFieldName("property");
  if (!innerObject || !innerProperty) return null;
  if (innerObject.text !== "ctx") return null;
  if (innerProperty.text !== "fns") return null;
  return property.text;
}

/**
 * Return the string-literal source of an `import` statement, or null if
 * the node isn't the right shape.
 */
function extractImportSource(node: TreeSitterNode): string | null {
  // import_statement has a `source` child that is a string node.
  const source = node.childForFieldName("source");
  if (!source) {
    // Fall back: walk named children for a string.
    for (const c of node.namedChildren) {
      if (c && c.type === "string") return stripStringQuotes(c.text);
    }
    return null;
  }
  return stripStringQuotes(source.text);
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
