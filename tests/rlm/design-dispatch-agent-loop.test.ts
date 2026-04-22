// Phase P3 — system prompt + full conversation loop tests.
// Exercises the agent end-to-end with stub chat scripts that emulate
// an LLM doing a TDD flow: inspect spec, write tests, run tests,
// write body, run tests, done.

import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  runDispatchAgent,
  renderAgentPrompt,
  createAgentSession,
} from "../../src/rlm/design-dispatch-agent.js";

function seed() {
  const g = createDesignGraph();
  g.addFunction(
    "src/a.ts",
    "add",
    {
      params: [
        { name: "x", type: "number" },
        { name: "y", type: "number" },
      ],
      returnType: "number",
    },
    "adds two numbers",
  );
  g.setSpec("src/a.ts", "add", {
    purpose: "return x + y",
    inputs: [],
    output: { type: "number", description: "sum" },
    sideEffects: [],
    dependencies: [],
    edgeCases: ["negatives", "zero"],
    examples: [{ input: "1, 2", output: "3" }],
  });
  g.setProjectConfig({
    runtime: "node",
    moduleSystem: "esm",
    testFramework: "vitest",
    testCommand: "npx vitest run --reporter=tap",
    singleTestCommand: "npx vitest run --reporter=tap {file}",
    testImports: "import { it, expect } from 'vitest';",
    packageJson: "{}",
    tsconfig: "{}",
  });
  return g;
}

describe("renderAgentPrompt", () => {
  it("includes target identity, signature, and tool catalog", () => {
    const g = seed();
    const s = createAgentSession(g, "src/a.ts", "add");
    const p = renderAgentPrompt(s, []);
    expect(p).toContain("src/a.ts#add");
    expect(p).toContain("function add(x: number, y: number): number");
    expect(p).toMatch(/Available tools/i);
    expect(p).toContain("get_spec");
    expect(p).toContain("run_tests");
    expect(p).toContain("done");
    expect(p).toContain("give_up");
  });

  it("surfaces externalFeedback (upstream failure context) when present", () => {
    const g = seed();
    const s = createAgentSession(g, "src/a.ts", "add", {
      externalFeedback: "integration test failed: POST /sign returned 500",
    });
    const p = renderAgentPrompt(s, []);
    expect(p).toContain("POST /sign returned 500");
  });

  it("renders conversation history oldest-first with call + result", () => {
    const g = seed();
    const s = createAgentSession(g, "src/a.ts", "add");
    const p = renderAgentPrompt(s, [
      { toolCall: { name: "get_spec", args: {} }, result: "spec content" },
      {
        toolCall: { name: "run_tests", args: {} },
        result: "ok: false\nfailed: 1",
      },
    ]);
    expect(p).toContain("Turn 1");
    expect(p).toContain("get_spec");
    expect(p).toContain("spec content");
    expect(p).toContain("Turn 2");
    expect(p).toContain("run_tests");
    expect(p).toContain("failed: 1");
    // Turn 1 before Turn 2.
    expect(p.indexOf("Turn 1")).toBeLessThan(p.indexOf("Turn 2"));
  });

  it("stays under ~8KB even with several turns of history", () => {
    const g = seed();
    const s = createAgentSession(g, "src/a.ts", "add");
    const history = Array.from({ length: 6 }, (_, i) => ({
      toolCall: { name: "get_spec", args: {} },
      result: `turn ${i} result — medium-size body of text about 200 chars long to simulate real history that the model accumulates during a dispatch so the prompt does not blow up over time because the renderer caps each turn's result at a reasonable budget`,
    }));
    const p = renderAgentPrompt(s, history);
    expect(p.length).toBeLessThan(8000);
  });
});

describe("runDispatchAgent — full TDD flow (stubbed runner)", () => {
  it("runs an end-to-end TDD sequence and returns green", async () => {
    const g = seed();
    let turn = 0;
    const chat = async () => {
      turn++;
      switch (turn) {
        case 1:
          return '```tool-call\n{"name": "get_spec"}\n```';
        case 2:
          return `\`\`\`tool-call\n${JSON.stringify({
            name: "write_test_file",
            args: {
              content:
                "import { it, expect } from 'vitest';\nimport add from './add.js';\nit('adds', () => expect(add(1,2)).toBe(3));",
            },
          })}\n\`\`\``;
        case 3:
          return '```tool-call\n{"name": "run_tests"}\n```';
        case 4:
          return `\`\`\`tool-call\n${JSON.stringify({
            name: "write_body",
            args: {
              content:
                "export default function add(x: number, y: number): number { return x + y; }",
            },
          })}\n\`\`\``;
        case 5:
          return '```tool-call\n{"name": "run_tests"}\n```';
        case 6:
          return '```tool-call\n{"name": "done"}\n```';
        default:
          return '```tool-call\n{"name": "give_up", "args": {"reason": "unexpected turn"}}\n```';
      }
    };
    let callCount = 0;
    const runTests = async () => {
      callCount++;
      // Turn 3 run: body missing/stub → red.
      // Turn 5 run: body correct → green.
      if (callCount === 1) {
        return {
          ok: false,
          passed: 0,
          failed: 1,
          output: "not implemented",
          failingTestNames: ["adds"],
          fullFailureMessages: new Map(),
        };
      }
      return {
        ok: true,
        passed: 1,
        failed: 0,
        output: "TAP 1..1 ok 1",
        failingTestNames: [],
        fullFailureMessages: new Map(),
      };
    };
    const result = await runDispatchAgent(g, "src/a.ts", "add", {
      chat,
      runTests,
      turnBudget: 10,
    });
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(6);
    // Graph state mutated by the write_* tools.
    const fn = g.getFunction("src/a.ts", "add")!;
    expect(fn.implementation).toContain("return x + y;");
    expect(fn.unitTestFile).toContain("expect(add(1,2)).toBe(3)");
  });

  it("preserves last implementation when exhausting turn budget", async () => {
    const g = seed();
    g.setImplementation("src/a.ts", "add", "// from earlier attempt");
    let turn = 0;
    const chat = async () => {
      turn++;
      // Model keeps calling get_spec and never calls done/give_up.
      return '```tool-call\n{"name": "get_spec"}\n```';
    };
    const result = await runDispatchAgent(g, "src/a.ts", "add", {
      chat,
      turnBudget: 3,
    });
    expect(result.status).toBe("stagnated");
    expect(result.implementation).toContain("from earlier attempt");
    expect(result.error).toMatch(/turn budget/i);
  });

  it("tolerates parse errors and continues — model gets the error as tool-result", async () => {
    const g = seed();
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) return "```tool-call\n{this is not json\n```";
      return '```tool-call\n{"name": "done"}\n```';
    };
    const result = await runDispatchAgent(g, "src/a.ts", "add", {
      chat,
      turnBudget: 5,
    });
    // First turn's parse error didn't terminate; second turn's done did.
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
  });

  it("surfaces typecheck diagnostics to the model via the typecheck tool", async () => {
    const g = seed();
    const chat = async () => '```tool-call\n{"name": "typecheck"}\n```';
    const result = await runDispatchAgent(g, "src/a.ts", "add", {
      chat,
      runTypecheck: async () => ({
        ran: true,
        ok: false,
        diagnostics:
          "add.ts(3,25): error TS2304: Cannot find name 'Database'.",
      }),
      turnBudget: 2,
    });
    // Turn 1 was typecheck (tool call ran). Turn 2 was the same thing
    // again (loop kept going), budget exhausted.
    expect(result.status).toBe("stagnated");
    expect(result.attempts).toBe(2);
    // (Can't assert on tool result output directly here; the content
    // lands in the next prompt, not the DispatchResult. This test's
    // value is just: typecheck is plumbed end-to-end without throwing.)
  });

  it("unknown tool names return a valid-tools list so the model can recover", async () => {
    const g = seed();
    let turn = 0;
    const chat = async () => {
      turn++;
      if (turn === 1) return '```tool-call\n{"name": "frobnicate"}\n```';
      return '```tool-call\n{"name": "done"}\n```';
    };
    const result = await runDispatchAgent(g, "src/a.ts", "add", {
      chat,
      turnBudget: 5,
    });
    // Turn 1 = bad tool (harness tells model the valid set), turn 2 = done.
    expect(result.status).toBe("tests-green");
    expect(result.attempts).toBe(2);
  });
});
