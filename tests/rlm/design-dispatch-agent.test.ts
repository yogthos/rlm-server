// Phase P1 — agent dispatcher scaffolding tests. Describes the loop
// shape: tool-call protocol, session state, turn budget, result shape.
// The real tool backends land in P2; here we use stub chats that emit
// canned tool calls + stub tools that return canned results.

import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  runDispatchAgent,
  parseToolCall,
} from "../../src/rlm/design-dispatch-agent.js";

function seedFn() {
  const g = createDesignGraph();
  g.addFunction(
    "src/a.ts",
    "foo",
    { params: [], returnType: "void" },
    "does foo",
  );
  g.setSpec("src/a.ts", "foo", {
    purpose: "x",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: [],
    edgeCases: [],
    examples: [],
  });
  return g;
}

describe("parseToolCall", () => {
  it("extracts a tool call from a ```tool-call fenced JSON block", () => {
    const response = [
      "I'm going to check the spec first.",
      "",
      "```tool-call",
      '{"name": "get_spec"}',
      "```",
    ].join("\n");
    expect(parseToolCall(response)).toEqual({ name: "get_spec", args: {} });
  });

  it("parses args when provided", () => {
    const response = [
      "```tool-call",
      '{"name": "write_body", "args": {"content": "return 1;"}}',
      "```",
    ].join("\n");
    expect(parseToolCall(response)).toEqual({
      name: "write_body",
      args: { content: "return 1;" },
    });
  });

  it("returns null when no fence present", () => {
    expect(parseToolCall("no tools here")).toBeNull();
  });

  it("returns an error marker when JSON is malformed", () => {
    const response = "```tool-call\n{broken\n```";
    const parsed = parseToolCall(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.parseError).toBeTruthy();
  });

  it("prefers the FIRST tool-call fence when multiple are present", () => {
    // Model may emit multiple calls; harness processes one per turn.
    const response = [
      "```tool-call",
      '{"name": "first"}',
      "```",
      "```tool-call",
      '{"name": "second"}',
      "```",
    ].join("\n");
    expect(parseToolCall(response)!.name).toBe("first");
  });
});

describe("runDispatchAgent — basic loop shape", () => {
  it("returns stagnated when model never emits a tool call", async () => {
    // Happens when the model hallucinates / ignores the tool protocol.
    // Harness treats as unrecoverable for this turn; after turn budget,
    // bail as stagnated so the outer loop can reflect / decompose.
    const g = seedFn();
    const chat = async () => "I don't know what to do, sorry.";
    const result = await runDispatchAgent(g, "src/a.ts", "foo", {
      chat,
      turnBudget: 3,
    });
    expect(result.status).toBe("stagnated");
    expect(result.error).toMatch(/no tool call|turn budget/i);
  });

  it("terminates when model calls done() (green)", async () => {
    const g = seedFn();
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) {
        return '```tool-call\n{"name": "done"}\n```';
      }
      return "unused";
    };
    const result = await runDispatchAgent(g, "src/a.ts", "foo", {
      chat,
      turnBudget: 5,
    });
    expect(result.status).toBe("tests-green");
    expect(turn).toBe(1);
  });

  it("terminates when model calls give_up(reason)", async () => {
    const g = seedFn();
    const chat = async () =>
      '```tool-call\n{"name": "give_up", "args": {"reason": "this is too hard"}}\n```';
    const result = await runDispatchAgent(g, "src/a.ts", "foo", {
      chat,
      turnBudget: 5,
    });
    expect(result.status).toBe("stagnated");
    expect(result.error).toMatch(/this is too hard|give.?up/i);
  });

  it("bails after turn budget exhausted", async () => {
    const g = seedFn();
    let turn = 0;
    // Model keeps calling the same tool without making progress.
    const chat = async () => {
      turn++;
      return '```tool-call\n{"name": "get_spec"}\n```';
    };
    const result = await runDispatchAgent(g, "src/a.ts", "foo", {
      chat,
      turnBudget: 4,
    });
    expect(result.status).toBe("stagnated");
    expect(result.error).toMatch(/turn budget/i);
    // Exactly `turnBudget` chat calls before bail.
    expect(turn).toBe(4);
  });

  it("respects RLM_AGENT_TURN_BUDGET env var when option omitted", async () => {
    const g = seedFn();
    const saved = process.env.RLM_AGENT_TURN_BUDGET;
    process.env.RLM_AGENT_TURN_BUDGET = "2";
    try {
      let turn = 0;
      const chat = async () => {
        turn++;
        return '```tool-call\n{"name": "get_spec"}\n```';
      };
      const result = await runDispatchAgent(g, "src/a.ts", "foo", { chat });
      expect(turn).toBe(2);
      expect(result.status).toBe("stagnated");
    } finally {
      if (saved === undefined) delete process.env.RLM_AGENT_TURN_BUDGET;
      else process.env.RLM_AGENT_TURN_BUDGET = saved;
    }
  });

  it("returns DispatchResult shape compatible with the existing dispatcher", async () => {
    const g = seedFn();
    const chat = async () => '```tool-call\n{"name": "done"}\n```';
    const result = await runDispatchAgent(g, "src/a.ts", "foo", {
      chat,
      turnBudget: 5,
    });
    expect(result.module).toBe("src/a.ts");
    expect(result.name).toBe("foo");
    expect(typeof result.attempts).toBe("number");
    expect(typeof result.testOutput).toBe("string");
    expect(result.status).toBeDefined();
  });
});
