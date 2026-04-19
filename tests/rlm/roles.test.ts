import { describe, it, expect } from "vitest";
import { Role, buildRolePrompt, selectRole } from "../../src/rlm/roles.js";
import type { TaskEnvelope } from "../../src/rlm/envelopes.js";

const baseEnvelope: TaskEnvelope = {
  goal: "build guestbook db layer",
  parentContext: "guestbook app, SQLite-backed",
  tests: {
    framework: "vitest",
    files: { "tests/db.test.ts": "import { connectDb } from '../src/db.js';" },
  },
  targetModule: "src/db.ts",
  targetExports: ["connectDb", "closeDb"],
  depth: 1,
  maxDepth: 3,
  budgetHint: "hours",
};

describe("selectRole", () => {
  it("returns Architect at depth 0", () => {
    expect(selectRole({ ...baseEnvelope, depth: 0 })).toBe(Role.Architect);
  });

  it("returns Dispatcher at internal depths", () => {
    expect(selectRole({ ...baseEnvelope, depth: 1, maxDepth: 3 })).toBe(Role.Dispatcher);
    expect(selectRole({ ...baseEnvelope, depth: 2, maxDepth: 3 })).toBe(Role.Dispatcher);
  });

  it("returns Implementer at maxDepth (auto-degrade)", () => {
    expect(selectRole({ ...baseEnvelope, depth: 3, maxDepth: 3 })).toBe(Role.Implementer);
  });
});

describe("buildRolePrompt", () => {
  it("Architect prompt routes everything through design_plan", () => {
    const p = buildRolePrompt(Role.Architect, { ...baseEnvelope, depth: 0 });
    expect(p.toLowerCase()).toContain("architect");
    // The one-liner is the contract — design_plan must appear literally
    // so the model knows the single entry point.
    expect(p).toContain("design_plan");
  });

  it("Architect prompt tells the model NOT to call graph primitives by hand", () => {
    const p = buildRolePrompt(Role.Architect, { ...baseEnvelope, depth: 0 });
    // Without this, the model falls back to manual design_module /
    // design_function / design_build and skips the test-writing phase.
    expect(p.toLowerCase()).toMatch(/do not declare|do not call|by hand/);
  });

  it("Architect prompt documents the design_plan phase outcomes", () => {
    const p = buildRolePrompt(Role.Architect, { ...baseEnvelope, depth: 0 });
    expect(p).toContain("FINAL_FILES");
    expect(p).toContain("phase");
    expect(p).toMatch(/plan|dispatch|finalize/);
  });

  it("Dispatcher prompt carries the same decide heuristic", () => {
    const p = buildRolePrompt(Role.Dispatcher, baseEnvelope);
    const lower = p.toLowerCase();
    expect(lower).toMatch(/implement\b.*\bor\b.*dispatch|dispatch\b.*\bor\b.*implement|decide/);
    expect(lower).toMatch(/multi-file|multiple concerns|distinct spec|unsure/);
  });

  it("Architect prompt does not hardcode project-specific terminology", () => {
    // Use a neutral envelope so we're measuring the static scaffolding only.
    const neutral = {
      ...baseEnvelope,
      goal: "neutral task",
      parentContext: "none",
      depth: 0,
    };
    const p = buildRolePrompt(Role.Architect, neutral);
    const lower = p.toLowerCase();
    // Guardrail: no leakage of our guestbook benchmark into the generic prompt.
    expect(lower).not.toContain("guestbook");
    expect(lower).not.toContain("sqlite");
    expect(lower).not.toContain("http server");
  });

  it("Dispatcher role produces an AGENT-mode prompt with split-vs-implement guidance", () => {
    const p = buildRolePrompt(Role.Dispatcher, baseEnvelope);
    expect(p.toLowerCase()).toMatch(/agent|dispatcher/);
    expect(p.toLowerCase()).toMatch(/split|implement|decompose|dispatch/);
  });

  it("Implementer prompt forbids sub-dispatch", () => {
    const p = buildRolePrompt(Role.Implementer, { ...baseEnvelope, depth: 3 });
    expect(p.toLowerCase()).toContain("implementer");
    expect(p.toLowerCase()).toMatch(/no sub-?dispatch|do not decompose|must not decompose/);
  });

  it("includes targetModule and targetExports", () => {
    const p = buildRolePrompt(Role.Implementer, baseEnvelope);
    expect(p).toContain("src/db.ts");
    expect(p).toContain("connectDb");
    expect(p).toContain("closeDb");
  });

  it("includes goal and parentContext", () => {
    const p = buildRolePrompt(Role.Dispatcher, baseEnvelope);
    expect(p).toContain(baseEnvelope.goal);
    expect(p).toContain(baseEnvelope.parentContext);
  });

  it("includes depth and maxDepth", () => {
    const p = buildRolePrompt(Role.Dispatcher, baseEnvelope);
    expect(p).toContain("1");
    expect(p).toContain("3");
  });

  it("Dispatcher prompt at maxDepth-1 warns that split will hit leaf", () => {
    const p = buildRolePrompt(Role.Dispatcher, { ...baseEnvelope, depth: 2, maxDepth: 3 });
    expect(p.toLowerCase()).toMatch(/leaf|max.*depth|last level/);
  });

  it("surfaces sibling summaries when provided", () => {
    const p = buildRolePrompt(Role.Dispatcher, {
      ...baseEnvelope,
      siblingSummaries: ["auth module handles login", "routes module handles HTTP"],
    });
    expect(p).toContain("auth module handles login");
    expect(p).toContain("routes module handles HTTP");
  });

  it("surfaces structural contract when provided", () => {
    const p = buildRolePrompt(Role.Implementer, {
      ...baseEnvelope,
      structuralContract: "forbidden :- imports(db, routes).",
    });
    expect(p).toContain("forbidden :- imports(db, routes).");
  });
});
