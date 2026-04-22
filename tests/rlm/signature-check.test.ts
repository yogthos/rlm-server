import { describe, it, expect } from "vitest";
import { signaturesCompatible } from "../../src/rlm/signature-check.js";

const sig = (
  params: Array<[string, string]>,
  returnType: string,
  isAsync = false,
) => ({
  params: params.map(([name, type]) => ({ name, type })),
  returnType,
  isAsync,
});

describe("signaturesCompatible", () => {
  it("accepts identical signatures", () => {
    const r = signaturesCompatible(sig([], "void"), sig([], "void"));
    expect(r.ok).toBe(true);
  });

  it("accepts `Array` against `Array<any>`", () => {
    // Architect declared bare `Array` (implicit Array<any>); implementer
    // wrote `Array<any>`. TypeScript treats these as identical.
    const r = signaturesCompatible(
      sig([["arr", "Array"]], "void"),
      sig([["arr", "Array<any>"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts `Array` against `any[]`", () => {
    const r = signaturesCompatible(
      sig([["arr", "Array"]], "void"),
      sig([["arr", "any[]"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts `Array` against `Array<unknown>` (non-strict bivariance)", () => {
    // In non-strict mode, unknown is bivariant enough with any that
    // tsc allows the substitution.
    const r = signaturesCompatible(
      sig([["arr", "Array"]], "void"),
      sig([["arr", "Array<unknown>"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts narrower return type (covariant return)", () => {
    // Architect says return `Array` (Array<any>); implementer returns
    // `GuestbookEntry[]`. That's assignable to Array<any>, so valid.
    const r = signaturesCompatible(
      sig([], "Array"),
      sig([], "GuestbookEntry[]"),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts Promise<T[]> against Promise<Array>", () => {
    const r = signaturesCompatible(
      sig([], "Promise<Array>"),
      sig([], "Promise<GuestbookEntry[]>"),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects unrelated return type (number vs Array)", () => {
    const r = signaturesCompatible(sig([], "Array"), sig([], "number"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/return|assignable/i);
  });

  it("rejects unrelated param type", () => {
    const r = signaturesCompatible(
      sig([["x", "string"]], "void"),
      sig([["x", "number"]], "void"),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a wider param type on the implementer side (bivariant under non-strict)", () => {
    // Architect says param is `string`; implementer types it as `any`.
    // Under our non-strict mode (matching the test-runner/integration
    // tsconfig), this passes. If we later switch to strict, this test
    // becomes a rejection — document the policy then.
    const r = signaturesCompatible(
      sig([["x", "string"]], "void"),
      sig([["x", "any"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("tolerates custom type names by treating unknowns as `any`", () => {
    // Implementer's signature references `GuestbookEntry` — a type the
    // implementer will declare inline in their body. The validator
    // shouldn't reject just because the name isn't ambient.
    const r = signaturesCompatible(
      sig([["entries", "Array"]], "void"),
      sig([["entries", "GuestbookEntry[]"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("handles async signatures (return type wraps Promise)", () => {
    const r = signaturesCompatible(
      sig([], "Promise<Array>", true),
      sig([], "Promise<Array<any>>", true),
    );
    expect(r.ok).toBe(true);
  });

  it("handles same-name-bare-and-dotted across expected/actual", async () => {
    // Architect declared `IncomingMessage` (perhaps expecting an
    // ambient type); implementer used `http.IncomingMessage`. Both
    // should resolve under the stubs — neither namespace deletion
    // nor bare-stub omission should break the check.
    const r = signaturesCompatible(
      sig([["req", "IncomingMessage"]], "void"),
      sig([["req", "http.IncomingMessage"]], "void"),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when param count differs", () => {
    const r = signaturesCompatible(
      sig([["a", "string"]], "void"),
      sig([], "void"),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/param.*count|arity/i);
  });
});
