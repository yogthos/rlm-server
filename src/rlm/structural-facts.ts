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

export interface StructuralFacts {
  graph: CodeGraph;
  complexity: ComplexityFact[];
}

export async function extractStructuralFacts(
  files: Array<{ path: string; content: string }>,
): Promise<StructuralFacts> {
  const graph = await extractGraph(files);
  const complexity: ComplexityFact[] = [];

  for (const file of files) {
    const lang = getLanguageForFile(file.path);
    if (lang !== "typescript" && lang !== "tsx" && lang !== "javascript") continue;

    const tree = parseSource(file.content, file.path)
      ?? await parseSourceAsync(file.content, file.path);
    if (!tree) continue;

    try {
      walkForComplexity(tree.rootNode, file.path, complexity);
    } finally {
      (tree as any).delete?.();
    }
  }

  return { graph, complexity };
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

  // Reuse graph facts (defines/calls/imports/exports/contains + entry_point).
  // graphToProlog already emits its own dynamic declarations and entry points.
  lines.push(graphToProlog(facts.graph, entryPoints));

  return lines.join("\n");
}
