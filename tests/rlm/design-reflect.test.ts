import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  parseReflectDecision,
  reflectOnStagnation,
} from "../../src/rlm/design-reflect.js";

const sig = () => ({ params: [], returnType: "void" });
function spec() {
  return {
    purpose: "do a thing",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: [],
    edgeCases: [],
    examples: [],
  };
}

describe("parseReflectDecision", () => {
  it("parses RETRY with hint", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "retry",
        rationale: "the implementation misread the input shape",
        hint: "parse the body as a URLSearchParams, not JSON",
      }) +
      "\n```";
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("retry");
    if (d?.kind === "retry") {
      expect(d.hint).toContain("URLSearchParams");
    }
  });

  it("parses REWRITE-TESTS with hint", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "rewrite-tests",
        rationale: "tests assert stricter behavior than the spec promises",
        hint: "drop the whitespace-trimming assertion; spec only says non-empty",
      }) +
      "\n```";
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("rewrite-tests");
    if (d?.kind === "rewrite-tests") {
      expect(d.hint).toContain("whitespace");
    }
  });

  it("parses DECOMPOSE", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "decompose",
        rationale: "function coordinates 3 distinct concerns",
      }) +
      "\n```";
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("decompose");
  });

  it("parses GIVE-UP", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "give-up",
        rationale: "spec demands behavior impossible with available siblings",
      }) +
      "\n```";
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("give-up");
  });

  it("parses REVISE-CHILD with childName + hint", () => {
    // E1: a stagnated PARENT can signal a specific child needs
    // revision. Reflect returns the child name and a hint the child
    // will see as feedback on re-dispatch.
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "revise-child",
        childName: "parseBody",
        rationale: "child returns a Map; parent needs an object",
        hint: "return a plain object keyed by field name, not a Map",
      }) +
      "\n```";
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("revise-child");
    if (d?.kind === "revise-child") {
      expect(d.childName).toBe("parseBody");
      expect(d.hint).toContain("plain object");
    }
  });

  it("rejects REVISE-CHILD without childName", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({
        decision: "revise-child",
        rationale: "no target",
        hint: "fix something",
      }) +
      "\n```";
    // Missing childName → invalid → null.
    expect(parseReflectDecision(resp)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseReflectDecision("not json")).toBeNull();
    expect(parseReflectDecision("```reflect\nnot json\n```")).toBeNull();
  });

  it("returns null on unknown decision value", () => {
    const resp =
      "```reflect\n" +
      JSON.stringify({ decision: "panic", rationale: "" }) +
      "\n```";
    expect(parseReflectDecision(resp)).toBeNull();
  });

  it("tolerates bare JSON (no fence)", () => {
    // The LLM sometimes drops the fence; accept the JSON anyway.
    const resp = JSON.stringify({
      decision: "retry",
      rationale: "typo in deps",
      hint: "fix the typo",
    });
    const d = parseReflectDecision(resp);
    expect(d?.kind).toBe("retry");
  });
});

describe("reflectOnStagnation", () => {
  it("builds a prompt including spec, failing tests, and body", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    g.setImplementation("src/a.ts", "stuck", "return 42;");
    let seenPrompt = "";
    const chat = async (p: string) => {
      seenPrompt = p;
      return "```reflect\n" + JSON.stringify({ decision: "retry", rationale: "ok", hint: "try again" }) + "\n```";
    };
    await reflectOnStagnation(g, "src/a.ts", "stuck", {
      testOutput: "AssertionError: expected 42 to be 7",
      attempts: 4,
    }, chat);
    expect(seenPrompt).toContain("stuck");
    expect(seenPrompt).toContain("return 42");
    expect(seenPrompt).toContain("expected 42 to be 7");
    expect(seenPrompt).toContain("do a thing"); // spec.purpose
  });

  it("includes test CODE (not just names) so reflect can judge rewrite-tests", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    g.replaceTests("src/a.ts", "stuck", [
      {
        name: "asserts strictly",
        code: "expect(stuck(ctx)).toBe(42);\nexpect(stuck(ctx)).toBeLessThan(100);",
      },
    ]);
    let seenPrompt = "";
    const chat = async (p: string) => {
      seenPrompt = p;
      return "```reflect\n" + JSON.stringify({ decision: "give-up", rationale: "" }) + "\n```";
    };
    await reflectOnStagnation(
      g,
      "src/a.ts",
      "stuck",
      { testOutput: "", attempts: 4 },
      chat,
    );
    expect(seenPrompt).toContain("asserts strictly");
    // Actual test code lines must be in the prompt.
    expect(seenPrompt).toContain("expect(stuck(ctx)).toBe(42)");
    expect(seenPrompt).toContain("toBeLessThan(100)");
  });

  it("includes top-level task when provided — helps judge intent", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    let seenPrompt = "";
    const chat = async (p: string) => {
      seenPrompt = p;
      return "```reflect\n" + JSON.stringify({ decision: "give-up", rationale: "" }) + "\n```";
    };
    await reflectOnStagnation(
      g,
      "src/a.ts",
      "stuck",
      {
        testOutput: "",
        attempts: 4,
        task: "Build a Node.js guestbook app with JSON storage",
      },
      chat,
    );
    expect(seenPrompt).toContain("guestbook");
    expect(seenPrompt).toMatch(/Top-level user task/i);
  });

  it("falls back to give-up when the LLM response is unparseable", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    const chat = async () => "garbage response";
    const d = await reflectOnStagnation(g, "src/a.ts", "stuck", {
      testOutput: "err",
      attempts: 4,
    }, chat);
    expect(d.kind).toBe("give-up");
  });

  it("returns the LLM's decision when parseable", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "stuck", sig());
    g.setSpec("src/a.ts", "stuck", spec());
    const chat = async () =>
      "```reflect\n" +
      JSON.stringify({
        decision: "decompose",
        rationale: "three concerns",
      }) +
      "\n```";
    const d = await reflectOnStagnation(g, "src/a.ts", "stuck", {
      testOutput: "err",
      attempts: 4,
    }, chat);
    expect(d.kind).toBe("decompose");
  });
});
