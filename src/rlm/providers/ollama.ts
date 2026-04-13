/**
 * Ollama provider — uses Ollama's native /api/chat endpoint.
 *
 * For OpenAI-compatible Ollama (via /v1), use the OpenAI provider
 * with baseUrl=http://localhost:11434/v1 instead.
 */

import type {
  LLMConfig,
  LLMClient,
  ChatMessage,
  LLMResponse,
  ChatOptions,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export function createOllamaProvider(config: LLMConfig): LLMClient {
  const baseUrl = config.baseUrl ?? "http://localhost:11434";
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<LLMResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        const body = {
          model: config.model,
          messages,
          stream: false,
          options: {
            temperature: config.temperature ?? 0.7,
            num_ctx: config.contextWindow ?? 8192,
            ...(config.maxTokens ? { num_predict: config.maxTokens } : {}),
          },
        };
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errorBody = "";
          try { errorBody = await response.text(); } catch { /* ignore */ }
          throw new Error(
            `Ollama error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`,
          );
        }

        const data = (await response.json()) as {
          message?: { content?: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };

        if (!data.message?.content) {
          throw new Error("Ollama returned empty response");
        }

        return {
          content: data.message.content,
          finishReason: "stop",
          usage:
            data.prompt_eval_count != null
              ? {
                  promptTokens: data.prompt_eval_count ?? 0,
                  completionTokens: data.eval_count ?? 0,
                  totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
                }
              : undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async listModels(): Promise<string[]> {
      try {
        const resp = await fetch(`${baseUrl}/api/tags`);
        if (!resp.ok) return [];
        const data = (await resp.json()) as { models?: Array<{ name: string }> };
        return data.models?.map((m) => m.name) ?? [];
      } catch {
        return [];
      }
    },
  };
}
