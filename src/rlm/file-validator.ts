/**
 * Validate a complete TypeScript file against an expected function
 * signature. Used after the wrapper-kill refactor: the implementer
 * emits a full file (imports + signature + body); the dispatcher
 * must verify the file honors the architect's declared contract
 * (name, param count + types, return type, async-ness).
 *
 * Signature-equivalence uses literal comparison with whitespace
 * normalization (Phase 1 MVP from the plan). Structural TS-type
 * equivalence (`string | undefined` vs `undefined | string`, or
 * generic-argument variance) is deliberately NOT attempted — that
 * requires real type inference which tsc already does at build time.
 * If the feedback loop shows spurious drift-rejects in practice we
 * can upgrade this.
 *
 * Param NAMES are informational and ignored for validation: the
 * runtime contract is structural (call-site argument order matters,
 * not names).
 */

import type { Node as TreeSitterNode } from "web-tree-sitter";
import {
  initTreeSitter,
  parse,
} from "./vendor/pi-code-graph/tree-sitter/index.js";
import { SupportedLanguage } from "./vendor/pi-code-graph/constants.js";
import type { Signature } from "./design-graph.js";
import { signaturesCompatible } from "./signature-check.js";

export interface ValidationTarget {
  name: string;
  signature: Signature;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initTreeSitter();
  return initPromise;
}


interface ParsedSignature {
  isAsync: boolean;
  /** `[ [name, type], ... ]` — preserves order; types are raw source. */
  params: Array<[string, string]>;
  returnType: string;
}

/**
 * Find the default-exported function in the tree and extract its
 * signature. Returns null if no recognizable default-export function
 * is present.
 *
 * Handles three shapes:
 *   1. `export default function foo(...) { ... }`
 *   2. `export default async function foo(...) { ... }`
 *   3. `const foo = (...): R => { ... }; export default foo;`
 *      (plus `function foo(...) { ... }; export default foo;`)
 */
function findDefaultExportFunction(
  root: TreeSitterNode,
  source: string,
): { node: TreeSitterNode; parsed: ParsedSignature; name: string } | null {
  // First pass: look for `export default <function_declaration>` directly.
  for (const top of root.namedChildren) {
    if (!top) continue;
    if (top.type === "export_statement") {
      // The syntax `export default function foo(...) {}` surfaces as an
      // export_statement whose first named child is the function
      // declaration. But when the syntax is `export default foo;` (name
      // reference), the child is an identifier.
      for (const child of top.namedChildren) {
        if (!child) continue;
        if (
          child.type === "function_declaration" ||
          child.type === "generator_function_declaration"
        ) {
          const parsed = parseFunctionDeclaration(child, source);
          const name = parseFunctionName(child) ?? "(anonymous)";
          if (parsed) return { node: child, parsed, name };
        }
      }
      // `export default NAME;` — find NAME elsewhere at top level.
      const ident = findDefaultIdentifier(top);
      if (ident) {
        const target = findDeclarationByName(root, source, ident);
        if (target) return target;
      }
    }
  }
  return null;
}

function parseFunctionName(fnDecl: TreeSitterNode): string | null {
  const nameNode = fnDecl.childForFieldName("name");
  return nameNode ? nameNode.text : null;
}

function findDefaultIdentifier(exportStmt: TreeSitterNode): string | null {
  // An `export default foo;` node contains an identifier child named `foo`.
  for (const c of exportStmt.namedChildren) {
    if (!c) continue;
    if (c.type === "identifier") return c.text;
  }
  return null;
}

function findDeclarationByName(
  root: TreeSitterNode,
  source: string,
  name: string,
): { node: TreeSitterNode; parsed: ParsedSignature; name: string } | null {
  for (const top of root.namedChildren) {
    if (!top) continue;
    // `function foo(...) {}` at top level
    if (top.type === "function_declaration") {
      if (parseFunctionName(top) === name) {
        const parsed = parseFunctionDeclaration(top, source);
        if (parsed) return { node: top, parsed, name };
      }
    }
    // `const foo = (...) => ...;` or `const foo = function (...) {}`
    if (top.type === "lexical_declaration" || top.type === "variable_declaration") {
      for (const decl of top.namedChildren) {
        if (!decl) continue;
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        if (!nameNode || nameNode.text !== name) continue;
        const value = decl.childForFieldName("value");
        if (!value) continue;
        if (
          value.type === "arrow_function" ||
          value.type === "function_expression" ||
          value.type === "function"
        ) {
          const parsed = parseFunctionExpression(value, source);
          if (parsed) return { node: value, parsed, name };
        }
      }
    }
  }
  return null;
}

/** Parse a function_declaration node (async + params + return). */
function parseFunctionDeclaration(
  node: TreeSitterNode,
  source: string,
): ParsedSignature | null {
  return parseCallable(node, source);
}

/** Parse an arrow or function_expression (shapes differ slightly
 *  from function_declaration but the field names are compatible). */
function parseFunctionExpression(
  node: TreeSitterNode,
  source: string,
): ParsedSignature | null {
  return parseCallable(node, source);
}

function parseCallable(
  node: TreeSitterNode,
  source: string,
): ParsedSignature | null {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return null;
  const params: Array<[string, string]> = [];
  for (const p of paramsNode.namedChildren) {
    if (!p) continue;
    if (p.type === "comment") continue;
    const nameType = extractParamNameAndType(p, source);
    if (!nameType) continue; // skip rest params / destructuring for now
    params.push(nameType);
  }
  const returnNode = node.childForFieldName("return_type");
  const returnType = returnNode ? extractTypeAnnotationText(returnNode, source) : "void";
  // Async-ness: walk children looking for an `async` keyword.
  let isAsync = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === "async") {
      isAsync = true;
      break;
    }
  }
  return { params, returnType, isAsync };
}

function extractParamNameAndType(
  paramNode: TreeSitterNode,
  source: string,
): [string, string] | null {
  // `required_parameter` / `optional_parameter` have:
  //   pattern: <identifier | destructuring>
  //   type:    <type_annotation>
  const patternNode = paramNode.childForFieldName("pattern");
  const typeNode = paramNode.childForFieldName("type");
  if (!patternNode) return null;
  const name = patternNode.text;
  const type = typeNode
    ? extractTypeAnnotationText(typeNode, source)
    : "any";
  return [name, type];
}

function extractTypeAnnotationText(
  typeNode: TreeSitterNode,
  source: string,
): string {
  // A type_annotation wraps the actual type: `: string`. Slice off the
  // leading `:` by finding the inner named child (the type node).
  if (typeNode.type === "type_annotation") {
    for (const c of typeNode.namedChildren) {
      if (!c) continue;
      return source.slice(c.startIndex, c.endIndex);
    }
  }
  return source.slice(typeNode.startIndex, typeNode.endIndex);
}

export async function validateFunctionFile(
  source: string,
  target: ValidationTarget,
): Promise<ValidationResult> {
  await ensureInit();
  let tree;
  try {
    tree = await parse(source, SupportedLanguage.TS);
  } catch (e) {
    return {
      ok: false,
      reason: `could not parse file: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const root = tree.rootNode;
  if (root.hasError) {
    // Tree-sitter recovers on errors; if the file has syntax errors
    // that prevented finding the default export, we'll fall through
    // to the not-found branch below with a useful reason. Only bail
    // early when the whole parse was unusable.
  }
  const found = findDefaultExportFunction(root, source);
  if (!found) {
    return {
      ok: false,
      reason: `no default export function found in file — expected \`export default function ${target.name}(...): ${target.signature.returnType}\``,
    };
  }
  if (found.name !== target.name) {
    return {
      ok: false,
      reason: `default export name mismatch — expected "${target.name}", got "${found.name}"`,
    };
  }
  const expectedUserParams = target.signature.params;
  // Phase N3 — natural mode: no ctx injection. The architect's
  // declared params ARE the signature, compared position-for-position.
  const actualUserParams = found.parsed.params;
  if (actualUserParams.length !== expectedUserParams.length) {
    return {
      ok: false,
      reason: `${target.name}: param count mismatch — expected ${expectedUserParams.length} param(s), got ${actualUserParams.length}`,
    };
  }
  // Delegate the actual type-equivalence check to the TypeScript
  // compiler. Handles Array ≡ Array<any> ≡ any[], covariant returns,
  // Promise<T[]>, user-declared types, etc. without manual aliasing.
  const actualShape = {
    params: actualUserParams.map(([name, type]) => ({ name, type })),
    returnType: found.parsed.returnType,
    isAsync: found.parsed.isAsync,
  };
  const expectedShape = {
    params: expectedUserParams,
    returnType: target.signature.returnType,
    isAsync: target.signature.isAsync === true,
  };
  const compat = signaturesCompatible(expectedShape, actualShape);
  if (!compat.ok) {
    return {
      ok: false,
      reason: `${target.name}: ${compat.reason}`,
    };
  }
  // async-ness is not checked by signaturesCompatible (tsc treats
  // `async () => Promise<T>` and `() => Promise<T>` as equivalent).
  // Keep the explicit check here: a declared async function that
  // isn't declared `async` in the emitted body may miss the
  // automatic Promise-wrapping the architect expected.
  const expectedAsync = target.signature.isAsync === true;
  if (expectedAsync !== found.parsed.isAsync) {
    return {
      ok: false,
      reason: `${target.name}: async mismatch — expected \`${expectedAsync ? "async " : ""}function\`, got \`${found.parsed.isAsync ? "async " : ""}function\``,
    };
  }
  return { ok: true };
}
