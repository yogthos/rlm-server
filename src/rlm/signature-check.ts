/**
 * Signature-compatibility check powered by the TypeScript compiler.
 *
 * The wrapper-kill refactor (Phase 5) introduced a signature drift
 * validator. The first cut used literal string compare after whitespace
 * normalization — a pragmatic shortcut that flagged legitimate
 * equivalences as drift: `Array` vs `Array<any>`, `GuestbookEntry[]`
 * vs `Array`, `Promise<GuestbookEntry[]>` vs `Promise<Array>`, etc.
 * Run 12 saw 15+ false-positive rejections burn attempts.
 *
 * This module routes the check through tsc instead. We build a tiny
 * snippet that declares `type Expected` and `type Actual` and assigns
 * one to the other — if tsc finds no errors, the types are compatible
 * under the project's `strict: false` rules (which the test-runner
 * and integration-runner both use).
 *
 * Unknown named types in the signatures (like `GuestbookEntry`) are
 * auto-declared as `any` so the check focuses on STRUCTURE not
 * resolvability — the implementer's full file will declare those
 * types inline, and tsc validates them at integration time.
 *
 * Compiler state is cached per-process so repeat calls share lib.d.ts
 * loading cost.
 */

import * as ts from "typescript";

export interface SignatureShape {
  params: Array<{ name: string; type: string }>;
  returnType: string;
  isAsync: boolean;
}

export type CompatibilityResult =
  | { ok: true }
  | { ok: false; reason: string };

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  lib: ["lib.es2022.d.ts"],
};

// Lazy-initialized default-lib host, shared across calls for warmth.
let cachedHost: ts.CompilerHost | null = null;
function getBaseHost(): ts.CompilerHost {
  if (!cachedHost) cachedHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
  return cachedHost;
}

/** Extract capitalized identifiers from a type string so we can auto-
 *  declare them as `any` before compiling. Avoids false "Cannot find
 *  name 'GuestbookEntry'" errors when the implementer declares types
 *  inline in their file body. Built-in names like `Array` / `Promise` /
 *  `Map` / `Set` / `Date` / `Error` etc. are excluded — the compiler
 *  resolves those from lib.d.ts. */
const BUILTIN_TYPES = new Set<string>([
  "Array",
  "ReadonlyArray",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "RegExp",
  "Object",
  "Function",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Iterable",
  "Iterator",
  "IterableIterator",
  "AsyncIterable",
  "AsyncIterator",
  "Record",
  "Partial",
  "Readonly",
  "Required",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "Awaited",
  "ReturnType",
  "Parameters",
  "NonNullable",
  "ArrayBuffer",
  "Uint8Array",
  "Buffer",
  "Ctx",
]);

/** Extract identifiers to stub as `any` so the check focuses on
 *  structural compatibility rather than resolvability. Two shapes:
 *    - Bare capitalized type names → `type X = any`
 *    - Dotted type references like `http.IncomingMessage` → emit
 *      `declare namespace http { type IncomingMessage = any }` so the
 *      reference resolves. The implementer's full file may well have
 *      `import * as http from "node:http"` and the real type — tsc
 *      validates that at integration time. For the validator's
 *      purposes we just need the shape to parse. */
function collectUnknownIdentifiers(types: readonly string[]): {
  bareTypes: string[];
  namespaces: Map<string, Set<string>>;
} {
  const bareTypes = new Set<string>();
  const namespaces = new Map<string, Set<string>>();
  for (const t of types) {
    // Dotted: <word>.<CapitalizedWord>
    for (const match of t.matchAll(
      /\b([a-zA-Z_$][A-Za-z0-9_$]*)\.([A-Z][A-Za-z0-9_]*)\b/g,
    )) {
      const ns = match[1];
      const member = match[2];
      if (!namespaces.has(ns)) namespaces.set(ns, new Set());
      namespaces.get(ns)!.add(member);
    }
    // Bare capitalized identifiers (skip any that were part of a
    // dotted reference — captured above).
    for (const match of t.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
      const id = match[0];
      if (!BUILTIN_TYPES.has(id)) bareTypes.add(id);
    }
  }
  // Do NOT delete namespace members from bareTypes — the same
  // identifier may appear BOTH as `X.Member` on one side and bare
  // `Member` on the other. Keeping both stubs (namespace + bare type
  // alias) lets either form resolve. The alias is harmless — both
  // resolve to `any`.
  return { bareTypes: [...bareTypes], namespaces };
}

/** Generics that require at least one type argument. Architects often
 *  write the bare name (`Array`, `Promise`) meaning "any-valued"; tsc
 *  rejects those with TS2314. We patch them to `Array<any>` etc. before
 *  compiling so the check focuses on STRUCTURAL compatibility, not
 *  missing-type-arg pedantry. Value is the arity. */
const GENERIC_ARITY: Record<string, number> = {
  Array: 1,
  ReadonlyArray: 1,
  Promise: 1,
  Set: 1,
  ReadonlySet: 1,
  WeakSet: 1,
  Iterable: 1,
  Iterator: 1,
  IterableIterator: 1,
  AsyncIterable: 1,
  AsyncIterator: 1,
  Partial: 1,
  Readonly: 1,
  Required: 1,
  NonNullable: 1,
  Awaited: 1,
  ReturnType: 1,
  Parameters: 1,
  Map: 2,
  ReadonlyMap: 2,
  WeakMap: 2,
  Record: 2,
  Pick: 2,
  Omit: 2,
  Exclude: 2,
  Extract: 2,
};

function fillGenericArgs(type: string): string {
  // Word boundary + not already followed by `<` → bare generic usage.
  // Substitute in `<any, any, ...>` with the right arity.
  return type.replace(
    /\b([A-Z][A-Za-z0-9_]*)\b(?!\s*<)/g,
    (match, name) => {
      const arity = GENERIC_ARITY[name];
      if (!arity) return match;
      const args = Array<string>(arity).fill("any").join(", ");
      return `${name}<${args}>`;
    },
  );
}

function renderParamList(
  params: readonly { name: string; type: string }[],
): string {
  return params
    .map((p, i) => `p${i}: ${fillGenericArgs(p.type)}`)
    .join(", ");
}

export function signaturesCompatible(
  expected: SignatureShape,
  actual: SignatureShape,
): CompatibilityResult {
  if (expected.params.length !== actual.params.length) {
    return {
      ok: false,
      reason: `param count (arity) mismatch — expected ${expected.params.length}, got ${actual.params.length}`,
    };
  }
  const expectedFn = `(ctx: any${expected.params.length > 0 ? ", " + renderParamList(expected.params) : ""}) => ${fillGenericArgs(expected.returnType)}`;
  const actualFn = `(ctx: any${actual.params.length > 0 ? ", " + renderParamList(actual.params) : ""}) => ${fillGenericArgs(actual.returnType)}`;
  const { bareTypes, namespaces } = collectUnknownIdentifiers([
    ...expected.params.map((p) => p.type),
    ...actual.params.map((p) => p.type),
    expected.returnType,
    actual.returnType,
  ]);
  const stubLines: string[] = [];
  for (const id of bareTypes) stubLines.push(`type ${id} = any;`);
  for (const [ns, members] of namespaces) {
    const memberLines = [...members].map((m) => `  export type ${m} = any;`);
    stubLines.push(
      `declare namespace ${ns} {`,
      ...memberLines,
      `}`,
    );
  }
  const source = [
    ...stubLines,
    `type __Expected = ${expectedFn};`,
    `type __Actual = ${actualFn};`,
    `declare const __a: __Actual;`,
    `const __check: __Expected = __a;`,
  ].join("\n");
  const fileName = "__sig_check__.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    COMPILER_OPTIONS.target!,
    true,
  );
  const baseHost = getBaseHost();
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      if (name === fileName) return sourceFile;
      return baseHost.getSourceFile(name, languageVersion, onError, shouldCreate);
    },
    writeFile: () => {},
  };
  const program = ts.createProgram([fileName], COMPILER_OPTIONS, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  if (diagnostics.length === 0) return { ok: true };
  // First diagnostic is usually the most actionable; format it concisely.
  const d = diagnostics[0];
  const msg = ts.flattenDiagnosticMessageText(d.messageText, " | ");
  // Include a hint about what was compared so the feedback points
  // the implementer at the right place.
  return {
    ok: false,
    reason: `signature incompatible: ${msg} (expected \`${expectedFn}\`, got \`${actualFn}\`)`,
  };
}
