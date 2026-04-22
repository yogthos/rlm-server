import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  parseWalkthroughResult,
  walkthroughTask,
} from "../../src/rlm/design-walkthrough.js";

const sig = () => ({ params: [], returnType: "void" });

describe("parseWalkthroughResult", () => {
  it("parses a no-gap response", () => {
    const r = parseWalkthroughResult(
      "```json\n" +
        JSON.stringify({
          coverage: [{ useCase: "handle X", handledBy: ["doX"] }],
          missing: [],
        }) +
        "\n```",
    );
    expect(r).not.toBeNull();
    expect(r!.missing).toEqual([]);
  });

  it("parses a response with missing functions", () => {
    const r = parseWalkthroughResult(
      "```json\n" +
        JSON.stringify({
          coverage: [{ useCase: "GET /", handledBy: ["serveIndex"] }],
          missing: [
            {
              module: "src/server.js",
              name: "handleError",
              signature: { params: [], returnType: "void" },
              description: "catches thrown errors",
              reason: "no function handles 500s",
            },
          ],
        }) +
        "\n```",
    );
    expect(r).not.toBeNull();
    expect(r!.missing).toHaveLength(1);
    expect(r!.missing[0].name).toBe("handleError");
  });

  it("returns null on malformed input", () => {
    expect(parseWalkthroughResult("not json")).toBeNull();
    expect(parseWalkthroughResult("```json\n{ not valid }\n```")).toBeNull();
  });

  it("returns null when missing shape is wrong", () => {
    const r = parseWalkthroughResult(
      "```json\n" +
        JSON.stringify({
          coverage: [],
          missing: [{ name: "noModule" }],
        }) +
        "\n```",
    );
    expect(r).toBeNull();
  });
});

describe("walkthroughTask", () => {
  it("adds missing functions to the graph with origin 'plan'", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/server.js",
      "serveIndex",
      sig(),
      "GET /",
      "plan",
    );
    const chat = async () =>
      "```json\n" +
      JSON.stringify({
        coverage: [{ useCase: "GET /", handledBy: ["serveIndex"] }],
        missing: [
          {
            module: "src/server.js",
            name: "handleError",
            signature: { params: [], returnType: "void" },
            description: "catches 500s",
            reason: "no error handler",
          },
        ],
      }) +
      "\n```";
    const result = await walkthroughTask(g, "build an app", chat);
    expect(result.addedNames).toContain("handleError");
    const added = g.getFunction("src/server.js", "handleError");
    expect(added).toBeDefined();
    expect(added!.description).toBe("catches 500s");
    expect(added!.origin).toBe("plan");
  });

  it("silent-skips duplicates so walkthrough is idempotent", async () => {
    const g = createDesignGraph();
    g.addFunction(
      "src/server.js",
      "serveIndex",
      sig(),
      "GET /",
      "plan",
    );
    const chat = async () =>
      "```json\n" +
      JSON.stringify({
        coverage: [],
        missing: [
          {
            module: "src/server.js",
            name: "serveIndex", // already exists
            signature: { params: [], returnType: "void" },
            description: "re-proposed",
            reason: "redundant",
          },
        ],
      }) +
      "\n```";
    const result = await walkthroughTask(g, "task", chat);
    // Silent-skipped; not in addedNames.
    expect(result.addedNames).not.toContain("serveIndex");
    // Original description preserved.
    expect(g.getFunction("src/server.js", "serveIndex")!.description).toBe(
      "GET /",
    );
  });

  it("returns an empty added list when the LLM response is garbage", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig(), "", "plan");
    const chat = async () => "not remotely json";
    const result = await walkthroughTask(g, "task", chat);
    expect(result.addedNames).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
