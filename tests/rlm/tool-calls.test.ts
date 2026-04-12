import { describe, it, expect } from "vitest";
import {
  convertToolsToFunctions,
  convertToolCallToOpenAI,
} from "../../src/rlm/tool-calls.js";

describe("convertToolsToFunctions", () => {
  it("converts OpenAI tool format to node-llama-cpp function map", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Read the contents of a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      },
    ];

    const result = convertToolsToFunctions(tools);
    expect(result).toHaveProperty("read_file");
    expect(result.read_file.description).toBe("Read the contents of a file");
    expect(result.read_file.params).toEqual(tools[0].function.parameters);
    expect(typeof result.read_file.handler).toBe("function");
  });

  it("converts multiple tools", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "foo", description: "Foo", parameters: {} },
      },
      {
        type: "function" as const,
        function: { name: "bar", description: "Bar", parameters: {} },
      },
    ];

    const result = convertToolsToFunctions(tools);
    expect(Object.keys(result)).toEqual(["foo", "bar"]);
  });

  it("handles tools without description or parameters", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "ping" },
      },
    ];

    const result = convertToolsToFunctions(tools);
    expect(result).toHaveProperty("ping");
  });

  it("ignores non-function tool types", () => {
    const tools = [
      { type: "function" as const, function: { name: "valid" } },
      { type: "other", foo: "bar" } as any,
    ];

    const result = convertToolsToFunctions(tools);
    expect(Object.keys(result)).toEqual(["valid"]);
  });
});

describe("convertToolCallToOpenAI", () => {
  it("converts a captured function call to OpenAI tool_call format", () => {
    const call = {
      name: "read_file",
      params: { path: "/etc/hosts" },
    };

    const result = convertToolCallToOpenAI(call);
    expect(result.type).toBe("function");
    expect(result.id).toMatch(/^call_/);
    expect(result.function.name).toBe("read_file");
    expect(result.function.arguments).toBe('{"path":"/etc/hosts"}');
  });

  it("stringifies complex argument objects", () => {
    const call = {
      name: "search",
      params: { query: "hello", options: { limit: 10, regex: true } },
    };

    const result = convertToolCallToOpenAI(call);
    const parsed = JSON.parse(result.function.arguments);
    expect(parsed).toEqual({
      query: "hello",
      options: { limit: 10, regex: true },
    });
  });

  it("handles empty params", () => {
    const call = { name: "ping", params: {} };
    const result = convertToolCallToOpenAI(call);
    expect(result.function.arguments).toBe("{}");
  });

  it("generates unique ids", () => {
    const c = { name: "f", params: {} };
    const r1 = convertToolCallToOpenAI(c);
    const r2 = convertToolCallToOpenAI(c);
    expect(r1.id).not.toBe(r2.id);
  });
});
