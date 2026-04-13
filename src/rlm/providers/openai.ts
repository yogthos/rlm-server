/**
 * OpenAI-compatible provider.
 *
 * Works with any service that implements the OpenAI chat completions
 * API: OpenAI itself, DeepSeek, OpenRouter, Together, etc. Also Ollama
 * via its `/v1` compatibility layer.
 *
 * Full feature parity with the local provider:
 *   - chat / chatStream
 *   - tools / tool_choice (returns OpenAI-format tool_calls)
 *   - response_format (json_object, json_schema)
 *   - AbortSignal
 *   - retry with exponential backoff
 */

import type {
  LLMConfig,
  LLMClient,
  ChatMessage,
  LLMResponse,
  ChatOptions,
} from "../types.js";
import { debug } from "../debug.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

interface OpenAIChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  delta?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      // Don't retry on 4xx
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Don't retry on abort
      if (lastError.name === "AbortError") throw lastError;
    }
    if (attempt < maxRetries) {
      const delay =
        INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) +
        Math.random() * INITIAL_RETRY_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

/** Build the JSON body for /chat/completions. */
function buildBody(
  config: LLMConfig,
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    ...(config.topP !== undefined ? { top_p: config.topP } : {}),
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    if (options.toolChoice !== undefined) {
      body.tool_choice = options.toolChoice;
    }
  }
  if (options?.responseFormat) {
    body.response_format = options.responseFormat;
  }
  return body;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function getApiKey(config: LLMConfig, providerHint: string): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (providerHint === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  if (providerHint === "openai" && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  // Fallback: try common env vars
  return (
    process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    undefined
  );
}

export interface OpenAIProviderOptions {
  /** Hint for env var fallback ("openai", "deepseek", or any custom). */
  providerHint?: string;
}

export function createOpenAIProvider(
  config: LLMConfig,
  options: OpenAIProviderOptions = {},
): LLMClient {
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error("OpenAI provider requires baseUrl in config");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = getApiKey(config, options.providerHint ?? "openai");

  return {
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<LLMResponse> {
      // Combine external signal with our timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        const body = buildBody(config, messages, opts, false);
        debug(
          "queue",
          `openai POST ${baseUrl}/chat/completions msgs=${messages.length} tools=${opts?.tools?.length ?? 0}`,
        );

        const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errorBody = "";
          try { errorBody = await response.text(); } catch { /* ignore */ }
          throw new Error(
            `OpenAI API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 300)}` : ""}`,
          );
        }

        const data = (await response.json()) as OpenAIResponse;
        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? "";
        const toolCalls = choice?.message?.tool_calls;

        return {
          content,
          finishReason: choice?.finish_reason ?? "stop",
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
                totalTokens: data.usage.total_tokens ?? 0,
              }
            : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async chatStream(
      messages: ChatMessage[],
      onChunk: (token: string) => void,
      opts?: ChatOptions,
    ): Promise<LLMResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      let collected = "";
      const accumulatedToolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      let finishReason = "stop";

      try {
        const body = buildBody(config, messages, opts, true);
        const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errorBody = "";
          try { errorBody = await response.text(); } catch { /* ignore */ }
          throw new Error(
            `OpenAI API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 300)}` : ""}`,
          );
        }

        if (!response.body) {
          throw new Error("OpenAI streaming returned empty body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as OpenAIResponse;
              const choice = chunk.choices?.[0];
              const delta = choice?.delta?.content;
              if (delta) {
                collected += delta;
                onChunk(delta);
              }
              const toolDeltas = choice?.delta?.tool_calls;
              if (toolDeltas) {
                for (const td of toolDeltas) {
                  const idx = td.index ?? 0;
                  if (!accumulatedToolCalls[idx]) {
                    accumulatedToolCalls[idx] = {
                      id: td.id ?? `call_${idx}`,
                      type: "function",
                      function: {
                        name: td.function?.name ?? "",
                        arguments: td.function?.arguments ?? "",
                      },
                    };
                  } else {
                    if (td.function?.name) {
                      accumulatedToolCalls[idx].function.name += td.function.name;
                    }
                    if (td.function?.arguments) {
                      accumulatedToolCalls[idx].function.arguments += td.function.arguments;
                    }
                  }
                }
              }
              if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
              }
            } catch {
              /* skip malformed chunk */
            }
          }
        }

        return {
          content: collected,
          finishReason,
          toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async listModels(): Promise<string[]> {
      try {
        const resp = await fetch(`${baseUrl}/models`, {
          headers: buildHeaders(apiKey),
        });
        if (!resp.ok) return [config.model];
        const data = (await resp.json()) as { data?: Array<{ id: string }> };
        const ids = data.data?.map((m) => m.id) ?? [];
        return ids.length > 0 ? ids : [config.model];
      } catch {
        return [config.model];
      }
    },
  };
}
