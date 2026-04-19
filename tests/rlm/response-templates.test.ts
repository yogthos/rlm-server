import { describe, it, expect } from "vitest";
import {
  runTemplates,
  ARCHITECT_DISPATCH_SHAPE,
  PLANNER_DISPATCH_SHAPE,
  DISPATCHER_SHAPE,
} from "../../src/rlm/response-templates.js";
import { Role } from "../../src/rlm/roles.js";
import type { RLMContext } from "../../src/rlm/types.js";
import type { ExtractionResult } from "../../src/rlm/code-extractor.js";

function makeCtx(overrides: Partial<RLMContext> = {}): RLMContext {
  return {
    prompt: "",
    systemPrompt: "",
    maxIterations: 30,
    llmClient: {} as any,
    sandboxTimeoutMs: 30_000,
    maxSubRLMDepth: 3,
    subRLMDepth: 0,
    sandbox: null,
    handleStore: {} as any,
    history: [],
    iteration: 2,
    finalAnswer: null,
    lastCode: null,
    lastLLMOutput: null,
    lastError: null,
    noCodeCount: 0,
    totalNoCodeCount: 0,
    repeatedErrorCount: 0,
    repeatedResponseCount: 0,
    spawnStats: { dispatched: 0, completed: 0 },
    decompositionNudged: false,
    requiresPlan: false,
    premateFinalRejections: 0,
    specItems: [],
    specRejections: 0,
    architectDispatchRejections: 0,
    repairAttempts: 0,
    directiveMisplacementNudged: false,
    formatNudges: {},
    ledger: [],
    failureMemory: [],
    trace: [],
    ...overrides,
  } as RLMContext;
}

function extraction(code: string | null, finalAnswer: string | null = null): ExtractionResult {
  return { code, finalAnswer, finalVar: null, finalFiles: null, finalFilesInline: false, reasoning: "" };
}

describe("ARCHITECT_DISPATCH_SHAPE", () => {
  const baseCtx = makeCtx({
    roleBinding: { role: Role.Architect, envelope: {} as any },
  });

  it("applies only when role=Architect at root depth + iter>=1 + no dispatches", () => {
    expect(ARCHITECT_DISPATCH_SHAPE.applies(baseCtx)).toBe(true);
    expect(ARCHITECT_DISPATCH_SHAPE.applies(makeCtx({ ...baseCtx, iteration: 0 }))).toBe(false);
    expect(
      ARCHITECT_DISPATCH_SHAPE.applies(makeCtx({ ...baseCtx, spawnStats: { dispatched: 1, completed: 0 } })),
    ).toBe(false);
    expect(
      ARCHITECT_DISPATCH_SHAPE.applies(makeCtx({ ...baseCtx, subRLMDepth: 1 })),
    ).toBe(false);
    expect(
      ARCHITECT_DISPATCH_SHAPE.applies(makeCtx({ ...baseCtx, roleBinding: undefined })),
    ).toBe(false);
  });

  it("accepts a code block containing a design_* primitive", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction('design_module("src/a.ts");'),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a code block containing design_dispatch(", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction('await design_dispatch("src/a.ts", "foo");'),
    );
    expect(r.ok).toBe(true);
  });

  it("still accepts legacy batch_llm_query( for non-graph recursion", () => {
    // The old pattern remains valid for generic chunked analysis — we
    // only deprecated the Architect's use of it for code assembly.
    const r = ARCHITECT_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction("const r = await batch_llm_query(['foo', 'bar']);"),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts an implement-direct FINAL with code (decide heuristic chose IMPLEMENT)", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(baseCtx, {
      code: null,
      finalAnswer: "```ts\nexport const x = 1;\n```",
      finalVar: null,
      finalFiles: null,
      finalFilesInline: false,
      reasoning: "",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts FINAL_VAR as an implement-direct outcome", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(baseCtx, {
      code: null,
      finalAnswer: null,
      finalVar: "serverJs",
      finalFiles: null,
      finalFilesInline: false,
      reasoning: "",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts FINAL_FILES as the graph-closure outcome", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(baseCtx, {
      code: null,
      finalAnswer: null,
      finalVar: null,
      finalFiles: "finalReport",
      reasoning: "",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a prose-only turn (no code)", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(baseCtx, extraction(null));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nudge.toLowerCase()).toMatch(/design_|dispatch|template/);
    }
  });

  it("rejects a code block with no design_* primitive and no batch_llm_query", () => {
    const r = ARCHITECT_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction("const x = context.length; console.log(x);"),
    );
    expect(r.ok).toBe(false);
  });
});

describe("PLANNER_DISPATCH_SHAPE", () => {
  const baseCtx = makeCtx({ requiresPlan: true });

  it("applies when requiresPlan + no roleBinding + no dispatch + iter>=1", () => {
    expect(PLANNER_DISPATCH_SHAPE.applies(baseCtx)).toBe(true);
    expect(
      PLANNER_DISPATCH_SHAPE.applies(makeCtx({ ...baseCtx, requiresPlan: false })),
    ).toBe(false);
    expect(
      PLANNER_DISPATCH_SHAPE.applies(
        makeCtx({ ...baseCtx, roleBinding: { role: Role.Architect, envelope: {} as any } }),
      ),
    ).toBe(false);
  });

  it("accepts a code block containing batch_llm_query(", () => {
    const r = PLANNER_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction("const results = await batch_llm_query([...]);"),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a code block without batch_llm_query nor skeleton plan", () => {
    const r = PLANNER_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction("const x = 1; console.log(x);"),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a code block with a skeleton-plan comment pattern", () => {
    const r = PLANNER_DISPATCH_SHAPE.validate(
      baseCtx,
      extraction("// 1. list things\n// 2. compute impact\n// 3. rank\nconst tasks = [];"),
    );
    expect(r.ok).toBe(true);
  });
});

describe("DISPATCHER_SHAPE", () => {
  const dispatcherCtx = makeCtx({
    subRLMDepth: 1, // internal depth — not root
    roleBinding: { role: Role.Dispatcher, envelope: {} as any },
  });

  it("applies when role=Dispatcher at internal depth with no dispatches yet", () => {
    expect(DISPATCHER_SHAPE.applies(dispatcherCtx)).toBe(true);
  });

  it("does NOT apply when role=Architect", () => {
    expect(
      DISPATCHER_SHAPE.applies(
        makeCtx({
          subRLMDepth: 1,
          roleBinding: { role: Role.Architect, envelope: {} as any },
        }),
      ),
    ).toBe(false);
  });

  it("does NOT apply once the agent has dispatched", () => {
    expect(
      DISPATCHER_SHAPE.applies(
        makeCtx({
          ...dispatcherCtx,
          spawnStats: { dispatched: 1, completed: 0 },
        }),
      ),
    ).toBe(false);
  });

  it("accepts a FINAL with code (decide chose IMPLEMENT)", () => {
    const r = DISPATCHER_SHAPE.validate(dispatcherCtx, {
      code: null,
      finalAnswer: "```ts\nexport const x = 1;\n```",
      finalVar: null,
      reasoning: "",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a code block calling batch_llm_query (decide chose DISPATCH)", () => {
    const r = DISPATCHER_SHAPE.validate(dispatcherCtx, {
      code: "const r = await batch_llm_query(['x','y']);",
      finalAnswer: null,
      finalVar: null,
      reasoning: "",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a prose-only turn", () => {
    const r = DISPATCHER_SHAPE.validate(dispatcherCtx, {
      code: null,
      finalAnswer: null,
      finalVar: null,
      reasoning: "hmm, thinking...",
    });
    expect(r.ok).toBe(false);
  });
});

describe("runTemplates", () => {
  it("returns null when no template matches", () => {
    const ctx = makeCtx({ iteration: 0 });
    expect(runTemplates(ctx, extraction("const x = 1;"))).toBeNull();
  });

  it("returns the first failing template for a prose-only Architect turn", () => {
    const ctx = makeCtx({
      roleBinding: { role: Role.Architect, envelope: {} as any },
    });
    const r = runTemplates(ctx, extraction(null));
    expect(r).not.toBeNull();
    expect(r!.template.name).toBe(ARCHITECT_DISPATCH_SHAPE.name);
  });

  it("respects per-template cap in ctx.formatNudges", () => {
    const ctx = makeCtx({
      roleBinding: { role: Role.Architect, envelope: {} as any },
      formatNudges: { [ARCHITECT_DISPATCH_SHAPE.name]: 3 },
    });
    // Once the cap is reached, the template stops firing.
    expect(runTemplates(ctx, extraction(null))).toBeNull();
  });
});
