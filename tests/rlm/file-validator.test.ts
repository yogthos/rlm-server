import { describe, it, expect } from "vitest";
import { validateFunctionFile } from "../../src/rlm/file-validator.js";

const sig = (
  params: Array<{ name: string; type: string }> = [],
  returnType = "void",
  isAsync = false,
) => ({ params, returnType, isAsync });

describe("validateFunctionFile", () => {
  it("accepts a valid file with matching signature", async () => {
    const file = `export default function foo(): void {
  return;
}`;
    const r = await validateFunctionFile(file, { name: "foo", signature: sig() });
    expect(r.ok).toBe(true);
  });

  it("flags missing default export", async () => {
    const file = `function foo(): void { return; }`;
    const r = await validateFunctionFile(file, { name: "foo", signature: sig() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/default export/i);
  });

  it("flags wrong default export name", async () => {
    const file = `export default function bar(): void { return; }`;
    const r = await validateFunctionFile(file, { name: "foo", signature: sig() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expected.*foo.*got.*bar/i);
  });

  it("flags wrong param count", async () => {
    const file = `export default function foo(req: string): void { return; }`;
    const r = await validateFunctionFile(file, { name: "foo", signature: sig() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/param count/i);
  });

  it("accepts a natural signature (no ctx) when arity + types match (Phase N3)", async () => {
    // Natural mode: the architect's declared params ARE the signature.
    // No ctx injection, no ctx-first requirement.
    const file = `export default function foo(req: string): void { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "req", type: "string" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("flags wrong user-param type via tsc compat check", async () => {
    const file = `export default function foo(req: number): void { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "req", type: "string" }]),
    });
    expect(r.ok).toBe(false);
    // TS compiler's diagnostic mentions the types involved. Be
    // liberal about phrasing since tsc versions may vary.
    expect(r.reason).toMatch(/incompatible|not assignable|signature/i);
  });

  it("normalizes whitespace when comparing types — `string |undefined` matches `string | undefined`", async () => {
    const file = `export default function foo(req: string |undefined): void { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "req", type: "string | undefined" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("ACCEPTS narrower return type (covariant; string is assignable to void at call sites)", async () => {
    // Under TS non-strict rules, a function returning `string` is
    // assignable to one returning `void` — the return value is simply
    // ignored by callers. The validator now delegates to tsc, so this
    // is accepted rather than flagged as drift. For genuinely wrong
    // returns (e.g., number when Array expected), tsc still rejects.
    const file = `export default function foo(): string { return "x"; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([], "void"),
    });
    expect(r.ok).toBe(true);
  });

  it("flags genuinely incompatible return type (number vs Array)", async () => {
    const file = `export default function foo(): number { return 1; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([], "Array"),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/incompatible|not assignable/i);
  });

  it("flags async mismatch — declared async, body sync", async () => {
    const file = `export default function foo(): Promise<void> { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([], "Promise<void>", true),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/async/i);
  });

  it("accepts async function with matching async signature", async () => {
    const file = `export default async function foo(): Promise<void> { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([], "Promise<void>", true),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts file with top-level imports above the signature", async () => {
    const file = `import * as http from "node:http";
import type * as fs from "node:fs";

export default function foo(req: http.IncomingMessage): void {
  return;
}`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "req", type: "http.IncomingMessage" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts user-param name differences (names are informational; only types + arity matter)", async () => {
    // Architect declares `req`; implementer writes `request`. Tolerate:
    // the proc-ts contract is structural at runtime, and name drift is
    // noise the type system doesn't care about.
    const file = `export default function foo(request: string): void { return; }`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "req", type: "string" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("reports unparseable input as a validation failure", async () => {
    const file = `this is not typescript at all {{{`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig(),
    });
    expect(r.ok).toBe(false);
    // Either "could not parse" or "default export" — depends on how
    // tree-sitter recovers. Both are acceptable failure messages.
    expect(r.reason).toBeTruthy();
  });

  it("supports arrow-function default export: `export default (ctx) => ...`", async () => {
    // Architect's declared shape is a `function` declaration, but some
    // implementers emit arrow form. Accept either as long as the
    // signature matches.
    const file = `const foo = (n: number): number => n + 1;
export default foo;`;
    const r = await validateFunctionFile(file, {
      name: "foo",
      signature: sig([{ name: "n", type: "number" }], "number"),
    });
    expect(r.ok).toBe(true);
  });
});
