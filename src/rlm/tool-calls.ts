/**
 * Tool calling support — bridge between OpenAI's function calling API
 * and node-llama-cpp's ChatSessionModelFunctions.
 *
 * The flow with opencode-style clients:
 *   1. Client sends request with `tools: [{type, function: {name, description, parameters}}]`
 *   2. We convert tools → node-llama-cpp functions (with capture handlers)
 *   3. Model generates; if it decides to call a tool, handler captures the call and aborts
 *   4. We return the response with `tool_calls: [...]` in OpenAI format
 *   5. Client executes the tool, sends back a `role: "tool"` message
 *   6. Model continues generation with the tool result
 */

import crypto from "node:crypto";

/** OpenAI tool definition (as sent by clients like opencode) */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** OpenAI tool_call format (as returned in responses) */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-stringified parameters
  };
}

/** A captured function call from the model */
export interface CapturedCall {
  name: string;
  params: unknown;
}

/**
 * Convert OpenAI-format tools into a node-llama-cpp functions map.
 *
 * Handlers are stubs that capture the call into `captures` (if provided)
 * and throw an abort sentinel so the model stops after the call instead
 * of continuing with a fake result.
 *
 * The caller should surround the prompt() call in a try/catch, check
 * `captures`, and return OpenAI tool_calls if any were captured.
 */
export function convertToolsToFunctions(
  tools: OpenAITool[],
  captures?: CapturedCall[],
): Record<
  string,
  { description?: string; params?: Record<string, unknown>; handler: Function }
> {
  const result: Record<
    string,
    {
      description?: string;
      params?: Record<string, unknown>;
      handler: Function;
    }
  > = {};

  for (const tool of tools) {
    if (tool.type !== "function" || !tool.function?.name) continue;
    const { name, description, parameters } = tool.function;

    const handler = (params: unknown) => {
      captures?.push({ name, params });
      // Return a sentinel; the caller should abort before this result
      // reaches the model. If it does reach the model, return a generic
      // pending indicator.
      return { __pending__: true, name };
    };

    result[name] = {
      description,
      params: parameters as Record<string, unknown> | undefined,
      handler,
    };
  }

  return result;
}

/** Convert a captured function call to OpenAI tool_call format */
export function convertToolCallToOpenAI(call: CapturedCall): OpenAIToolCall {
  const id = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.params ?? {}),
    },
  };
}
