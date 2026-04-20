import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  attributeFailure,
  extractSubgraph,
} from "../../src/rlm/design-attribution.js";

const sig = () => ({ params: [], returnType: "void" });
function spec(deps: string[] = []) {
  return {
    purpose: "x",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: deps,
    edgeCases: [],
    examples: [],
  };
}

function seed() {
  const g = createDesignGraph();
  g.addFunction("src/a.ts", "startServer", sig());
  g.setSpec("src/a.ts", "startServer", spec(["handleRequest"]));
  g.addFunction("src/a.ts", "handleRequest", sig());
  g.setSpec("src/a.ts", "handleRequest", spec(["serveHomePage", "handleSignPost"]));
  g.addFunction("src/a.ts", "serveHomePage", sig());
  g.setSpec("src/a.ts", "serveHomePage", spec(["generateHtml"]));
  g.addFunction("src/a.ts", "handleSignPost", sig());
  g.setSpec("src/a.ts", "handleSignPost", spec(["parseFormData", "saveEntries"]));
  g.addFunction("src/a.ts", "generateHtml", sig());
  g.setSpec("src/a.ts", "generateHtml", spec());
  g.addFunction("src/a.ts", "parseFormData", sig());
  g.setSpec("src/a.ts", "parseFormData", spec());
  g.addFunction("src/a.ts", "saveEntries", sig());
  g.setSpec("src/a.ts", "saveEntries", spec());
  return g;
}

describe("attributeFailure — direct (stack frame hits a function file)", () => {
  it("matches the topmost in-project function in the stack trace", async () => {
    const g = seed();
    const trace = `
Error: boom
    at parseFormData (/tmp/proj/parseFormData.ts:12:5)
    at handleSignPost (/tmp/proj/handleSignPost.ts:8:3)
    at handleRequest (/tmp/proj/handleRequest.ts:4:3)
`;
    const chat = async () => "should not be called";
    const result = await attributeFailure(g, trace, { chat });
    expect(result.function).toBe("parseFormData");
    expect(result.confidence).toBe("direct");
  });

  it("skips non-project frames (node_modules, vitest internals)", async () => {
    const g = seed();
    const trace = `
    at Object.<anonymous> (node:internal/modules/cjs/loader:1111:14)
    at /Users/x/node_modules/vitest/dist/runner.js:44:10
    at serveHomePage (/tmp/proj/serveHomePage.ts:7:2)
    at handleRequest (/tmp/proj/handleRequest.ts:9:1)
`;
    const chat = async () => "should not be called";
    const result = await attributeFailure(g, trace, { chat });
    expect(result.function).toBe("serveHomePage");
    expect(result.confidence).toBe("direct");
  });
});

describe("attributeFailure — fallback (no in-project frame matches a function)", () => {
  it("invokes the LLM with a subgraph when no frame resolves to a known function", async () => {
    const g = seed();
    const trace = `
Error: ETIMEDOUT
    at internal/net/socket.js:101:7
    at /tmp/proj/scaffold/setup.ts:14:3
`;
    let prompts: string[] = [];
    const chat = async (prompt: string) => {
      prompts.push(prompt);
      return '```json\n{"function":"handleRequest","reason":"routes HTTP, likely source"}\n```';
    };
    const result = await attributeFailure(g, trace, { chat });
    expect(result.function).toBe("handleRequest");
    expect(result.confidence).toBe("fallback");
    // Prompt must include the stack trace and at least some of the
    // graph so the LLM can reason about it.
    expect(prompts[0]).toContain("ETIMEDOUT");
    expect(prompts[0].toLowerCase()).toMatch(/graph|function|call/);
  });

  it("returns unknown when no frame matches AND the LLM can't decide", async () => {
    const g = seed();
    const trace = "Error: total garbage\n    at ???:0:0";
    const chat = async () => "garbage response";
    const result = await attributeFailure(g, trace, { chat });
    expect(result.function).toBeNull();
    expect(result.confidence).toBe("unknown");
  });
});

describe("extractSubgraph", () => {
  it("returns the named function plus one hop of callers and callees", () => {
    const g = seed();
    const sub = extractSubgraph(g, "handleRequest", 1);
    const names = new Set(sub.map((f) => f.name));
    // Self, caller (startServer), and callees (serveHomePage, handleSignPost).
    expect(names).toContain("handleRequest");
    expect(names).toContain("startServer");
    expect(names).toContain("serveHomePage");
    expect(names).toContain("handleSignPost");
    // Two hops away should NOT be included at depth=1.
    expect(names.has("generateHtml")).toBe(false);
    expect(names.has("parseFormData")).toBe(false);
  });

  it("expands to two hops when depth=2", () => {
    const g = seed();
    const sub = extractSubgraph(g, "handleRequest", 2);
    const names = new Set(sub.map((f) => f.name));
    expect(names).toContain("generateHtml");
    expect(names).toContain("parseFormData");
  });

  it("returns just the function when depth=0", () => {
    const g = seed();
    const sub = extractSubgraph(g, "handleRequest", 0);
    expect(sub).toHaveLength(1);
    expect(sub[0].name).toBe("handleRequest");
  });
});
