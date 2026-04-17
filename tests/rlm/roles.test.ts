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
  it("Architect prompt mentions decomposition and acceptance tests", () => {
    const p = buildRolePrompt(Role.Architect, { ...baseEnvelope, depth: 0 });
    expect(p.toLowerCase()).toContain("architect");
    expect(p.toLowerCase()).toMatch(/acceptance|high-level|decompos/);
  });

  it("Dispatcher prompt explains split-vs-implement", () => {
    const p = buildRolePrompt(Role.Dispatcher, baseEnvelope);
    expect(p.toLowerCase()).toContain("dispatcher");
    expect(p.toLowerCase()).toMatch(/split|implement|decompose/);
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
