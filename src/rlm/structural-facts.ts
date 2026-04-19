/**
 * Structural facts extractor: tree-sitter AST → complexity metrics + Prolog facts.
 * Extends the existing graph/ extractor with cyclomatic complexity, body-line count,
 * and nesting depth per function. See docs/hierarchical-agents.md §3.4.
 */

import { extractGraph } from "./graph/extractor.js";
import { parseSource, parseSourceAsync, getLanguageForFile } from "./graph/parser.js";
import { escapeAtom, graphToProlog } from "./graph/facts.js";
import type { CodeGraph } from "./graph/types.js";

export interface ComplexityFact {
  name: string;
  file: string;
  cyclomatic: number;
  bodyLines: number;
  nesting: number;
}

export interface SignatureFact {
  name: string;
  file: string;
  /** Total declared parameter count (required + optional + rest). */
  argCount: number;
  /** Count of required-only parameters (excludes optional, default, rest). */
  requiredCount: number;
  /** Whether the function has a rest parameter (`...xs`) → unbounded arity. */
  hasRest: boolean;
  hasReturnType: boolean;
}

export interface CallArityFact {
  callee: string;
  argCount: number;
  /** "plain" = identifier call (`foo(x)`); "method" = member call (`obj.foo(x)`). */
  kind: "plain" | "method";
}

export interface StructuralFacts {
  graph: CodeGraph;
  complexity: ComplexityFact[];
  signatures: SignatureFact[];
  callArities: CallArityFact[];
}

export async function extractStructuralFacts(
  files: Array<{ path: string; content: string }>,
): Promise<StructuralFacts> {
  const graph = await extractGraph(files);
  const complexity: ComplexityFact[] = [];
  const signatures: SignatureFact[] = [];
  const callArities: CallArityFact[] = [];

  for (const file of files) {
    const lang = getLanguageForFile(file.path);
    if (lang !== "typescript" && lang !== "tsx" && lang !== "javascript") continue;

    const tree = parseSource(file.content, file.path)
      ?? await parseSourceAsync(file.content, file.path);
    if (!tree) continue;

    try {
      walkForComplexity(tree.rootNode, file.path, complexity);
      walkForSignatures(tree.rootNode, file.path, signatures, callArities);
    } finally {
      (tree as any).delete?.();
    }
  }

  return { graph, complexity, signatures, callArities };
}

const FUNCTION_NODES = new Set([
  "function_declaration",
  "method_definition",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
]);

const BLOCK_NODES = new Set([
  "statement_block",
  "if_statement",
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
  "catch_clause",
]);

function walkForComplexity(node: any, filePath: string, out: ComplexityFact[]): void {
  const queue: any[] = [node];
  while (queue.length > 0) {
    const n = queue.shift();
    if (!n) continue;
    if (FUNCTION_NODES.has(n.type)) {
      const fact = computeComplexity(n, filePath);
      if (fact) out.push(fact);
    }
    for (let i = 0; i < n.childCount; i++) queue.push(n.child(i));
  }
}

function computeComplexity(fnNode: any, filePath: string): ComplexityFact | null {
  const name = functionName(fnNode);
  if (!name) return null;

  const startRow: number = fnNode.startPosition.row;
  const endRow: number = fnNode.endPosition.row;
  const bodyLines = Math.max(1, endRow - startRow + 1);

  let cyclomatic = 1;
  let maxNesting = 0;

  function walk(n: any, depth: number): void {
    if (!n) return;
    // Do not descend into nested function definitions — they get their own entry.
    if (n !== fnNode && FUNCTION_NODES.has(n.type)) return;

    cyclomatic += cyclomaticDelta(n);
    const nextDepth = BLOCK_NODES.has(n.type) ? depth + 1 : depth;
    if (nextDepth > maxNesting) maxNesting = nextDepth;
    for (let i = 0; i < n.childCount; i++) walk(n.child(i), nextDepth);
  }

  walk(fnNode, 0);

  return {
    name,
    file: filePath,
    cyclomatic,
    bodyLines,
    nesting: maxNesting,
  };
}

function cyclomaticDelta(n: any): number {
  switch (n.type) {
    case "if_statement":
    case "for_statement":
    case "for_in_statement":
    case "for_of_statement":
    case "while_statement":
    case "do_statement":
    case "catch_clause":
    case "ternary_expression":
      return 1;
    case "switch_case": {
      // default clause doesn't add a branch
      const first = n.child(0);
      if (first && first.type === "default") return 0;
      return 1;
    }
    case "binary_expression": {
      const opNode = n.childForFieldName?.("operator") ?? n.child(1);
      const op = opNode?.text;
      if (op === "&&" || op === "||" || op === "??") return 1;
      return 0;
    }
    default:
      return 0;
  }
}

interface ParamStats {
  total: number;     // every real parameter
  required: number;  // strict minimum (excludes optional, default, rest)
  hasRest: boolean;
}

/**
 * Analyze a `formal_parameters` node. TypeScript encodes:
 *   - required_parameter: may still be optional if its inner node is an
 *     assignment_pattern (default value) or ends with `?`.
 *   - optional_parameter: explicit `?` form.
 *   - rest_pattern: `...xs` — unbounded arity.
 * We conservatively treat any default value or `?` mark as "not required".
 */
function analyzeParams(paramsNode: any): ParamStats {
  let total = 0;
  let required = 0;
  let hasRest = false;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const c = paramsNode.child(i);
    const t = c?.type;
    if (!t || t === "(" || t === ")" || t === "," || t === "comment") continue;
    if (t === "rest_pattern") {
      hasRest = true;
      total++;
      continue;
    }
    if (t === "optional_parameter") {
      total++;
      continue;
    }
    if (t === "required_parameter") {
      // In TS's tree-sitter grammar a rest parameter appears as a
      // required_parameter whose first child is a rest_pattern — detect
      // that and mark the function as variadic.
      const first = c.child(0);
      if (first?.type === "rest_pattern") {
        hasRest = true;
        total++;
        continue;
      }
      total++;
      // A required_parameter with a default value (`a = 5`) is effectively
      // optional — the tree wraps the identifier in an assignment_pattern.
      const text: string = c.text ?? "";
      const hasDefault = /[^=!<>]=(?!=)/.test(text);
      const hasOptionalMark = /\w\?\s*[:)]/.test(text);
      if (!hasDefault && !hasOptionalMark) required++;
      continue;
    }
    if (
      t === "identifier" ||
      t === "object_pattern" ||
      t === "array_pattern"
    ) {
      total++;
      required++;
      continue;
    }
    if (t === "assignment_pattern") {
      total++; // default value at top level
      continue;
    }
  }
  return { total, required, hasRest };
}

/** Count expression-level arguments in a call_expression's `arguments` node. */
function countCallArgs(argsNode: any): number {
  let n = 0;
  for (let i = 0; i < argsNode.childCount; i++) {
    const c = argsNode.child(i);
    const t = c?.type;
    // Skip punctuation and comments; everything else is an argument expression.
    if (t && t !== "(" && t !== ")" && t !== "," && t !== "comment") n++;
  }
  return n;
}

function calleeInfo(callNode: any): { name: string; kind: "plain" | "method" } | null {
  const fn = callNode.childForFieldName?.("function");
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, kind: "plain" };
  if (fn.type === "member_expression") {
    // foo.bar(...) — property name is the callee; arity rules treat this
    // as a method call so we don't false-collide with an unrelated
    // top-level function that shares the property's name.
    const prop = fn.childForFieldName?.("property");
    const n = prop?.text ?? fn.text;
    return n ? { name: n, kind: "method" } : null;
  }
  return fn.text ? { name: fn.text, kind: "plain" } : null;
}

function walkForSignatures(
  root: any,
  filePath: string,
  signatures: SignatureFact[],
  callArities: CallArityFact[],
): void {
  const queue: any[] = [root];
  while (queue.length > 0) {
    const n = queue.shift();
    if (!n) continue;
    if (FUNCTION_NODES.has(n.type)) {
      const name = functionName(n);
      if (name) {
        const params = n.childForFieldName?.("parameters");
        const stats = params
          ? analyzeParams(params)
          : { total: 0, required: 0, hasRest: false };
        const ret = n.childForFieldName?.("return_type");
        signatures.push({
          name,
          file: filePath,
          argCount: stats.total,
          requiredCount: stats.required,
          hasRest: stats.hasRest,
          hasReturnType: !!ret,
        });
      }
    }
    if (n.type === "call_expression") {
      const info = calleeInfo(n);
      const args = n.childForFieldName?.("arguments");
      const argCount = args ? countCallArgs(args) : 0;
      if (info) callArities.push({ callee: info.name, argCount, kind: info.kind });
    }
    for (let i = 0; i < n.childCount; i++) queue.push(n.child(i));
  }
}

function functionName(fnNode: any): string | null {
  const nameField = fnNode.childForFieldName?.("name");
  if (nameField?.text) return nameField.text;

  const parent = fnNode.parent;
  if (!parent) return null;

  // const foo = () => ...  or  const foo = function () {}
  if (parent.type === "variable_declarator") {
    const n = parent.childForFieldName?.("name");
    if (n?.text) return n.text;
  }

  // foo: () => ...  in an object literal
  if (parent.type === "pair" || parent.type === "property_signature") {
    const key = parent.childForFieldName?.("key");
    if (key?.text) return key.text;
  }

  return null;
}

export function structuralFactsToProlog(
  facts: StructuralFacts,
  entryPoints?: string[],
): string {
  const lines: string[] = [];

  lines.push(":- dynamic(function/3).");
  lines.push(":- dynamic(cyclomatic/2).");
  lines.push(":- dynamic(body_lines/2).");
  lines.push(":- dynamic(nesting/2).");
  lines.push(":- dynamic(signature/3).");
  lines.push(":- dynamic(required_arity/2).");
  lines.push(":- dynamic(has_rest_param/1).");
  lines.push(":- dynamic(call_arity/2).");
  lines.push(":- dynamic(method_call_arity/2).");
  lines.push(":- dynamic(entry_point/1).");
  lines.push("");

  // function(Name, File, Line) — derived from defines with kind in {function, method}
  for (const d of facts.graph.defines) {
    if (d.kind === "function" || d.kind === "method") {
      lines.push(`function(${escapeAtom(d.name)}, ${escapeAtom(d.file)}, ${d.line}).`);
    }
  }
  if (facts.graph.defines.length > 0) lines.push("");

  for (const c of facts.complexity) {
    lines.push(`cyclomatic(${escapeAtom(c.name)}, ${c.cyclomatic}).`);
    lines.push(`body_lines(${escapeAtom(c.name)}, ${c.bodyLines}).`);
    lines.push(`nesting(${escapeAtom(c.name)}, ${c.nesting}).`);
  }
  if (facts.complexity.length > 0) lines.push("");

  for (const s of facts.signatures) {
    lines.push(`signature(${escapeAtom(s.name)}, ${escapeAtom(s.file)}, ${s.argCount}).`);
    lines.push(`required_arity(${escapeAtom(s.name)}, ${s.requiredCount}).`);
    if (s.hasRest) {
      lines.push(`has_rest_param(${escapeAtom(s.name)}).`);
    }
  }
  if (facts.signatures.length > 0) lines.push("");

  for (const ca of facts.callArities) {
    const head = ca.kind === "method" ? "method_call_arity" : "call_arity";
    lines.push(`${head}(${escapeAtom(ca.callee)}, ${ca.argCount}).`);
  }
  if (facts.callArities.length > 0) lines.push("");

  // Reuse graph facts (defines/calls/imports/exports/contains + entry_point).
  // graphToProlog already emits its own dynamic declarations and entry points.
  lines.push(graphToProlog(facts.graph, entryPoints));

  return lines.join("\n");
}
