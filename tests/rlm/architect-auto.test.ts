import { describe, it, expect } from "vitest";
import { maybeArchitectBinding } from "../../src/rlm/architect-auto.js";
import { Role } from "../../src/rlm/roles.js";
import { validateTaskEnvelope } from "../../src/rlm/envelopes.js";

const CODING_PROMPT =
  "Build a Node.js guestbook web application with these requirements:\n1. Persist to SQLite\n2. Expose POST /sign";

const NON_CODING_PROMPT = "What is the capital of France?";

describe("maybeArchitectBinding", () => {
  it("returns undefined when explicit override is false", () => {
    expect(maybeArchitectBinding(CODING_PROMPT, false, 3)).toBeUndefined();
  });

  it("returns an Architect binding when explicit override is true, regardless of prompt", () => {
    const b = maybeArchitectBinding(NON_CODING_PROMPT, true, 3);
    expect(b).toBeDefined();
    expect(b!.role).toBe(Role.Architect);
  });

  it("returns an Architect binding for a coding prompt when override is undefined", () => {
    const b = maybeArchitectBinding(CODING_PROMPT, undefined, 3);
    expect(b).toBeDefined();
    expect(b!.role).toBe(Role.Architect);
  });

  it("returns undefined for a non-coding prompt when override is undefined", () => {
    expect(maybeArchitectBinding(NON_CODING_PROMPT, undefined, 3)).toBeUndefined();
  });

  it("produces an envelope that passes the envelope validator", () => {
    const b = maybeArchitectBinding(CODING_PROMPT, true, 3);
    const r = validateTaskEnvelope(b!.envelope);
    expect(r.ok).toBe(true);
  });

  it("envelope depth is 0 and maxDepth matches the caller-supplied value", () => {
    const b = maybeArchitectBinding(CODING_PROMPT, true, 4);
    expect(b!.envelope.depth).toBe(0);
    expect(b!.envelope.maxDepth).toBe(4);
  });

  it("envelope.goal preserves the prompt up to a reasonable cap", () => {
    const b = maybeArchitectBinding(CODING_PROMPT, true, 3);
    expect(b!.envelope.goal).toContain("guestbook");
    expect(b!.envelope.goal.length).toBeLessThanOrEqual(1000);
  });

  it("envelope carries placeholder targetModule/targetExports for root", () => {
    const b = maybeArchitectBinding(CODING_PROMPT, true, 3);
    // Root Architect determines children's modules; validator requires
    // non-empty placeholders.
    expect(b!.envelope.targetModule.length).toBeGreaterThan(0);
    expect(b!.envelope.targetExports.length).toBeGreaterThan(0);
  });
});
