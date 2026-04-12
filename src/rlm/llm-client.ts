/**
 * LLM client factory.
 *
 * - If `config.modelPath` is set → local inference via node-llama-cpp (in-process)
 * - If `config.baseUrl` contains `/v1` → OpenAI chat completions format
 * - Otherwise → Ollama /api/chat format
 *
 * Local inference is the default and recommended path — no HTTP overhead,
 * model stays loaded between requests.
 */

import type { LLMConfig, LLMClient, ChatMessage, LLMResponse } from "./types.js";
import { createLocalLLMClient } from "./local-llm.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * Create an LLM client based on configuration.
 *
 * - `modelPath` set → local inference (node-llama-cpp, in-process)
 * - `baseUrl` set → remote inference (Ollama or OpenAI-compatible)
 */
export function createLLMClient(config: LLMConfig): LLMClient {
  if (config.modelPath) {
    return createLocalLLMClient(config);
  }

  if (!config.baseUrl) {
    throw new Error(
      "LLM config must specify either modelPath (local inference) or baseUrl (remote inference)",
    );
  }

  return createRemoteLLMClient(config);
}

// ─── Remote client (Ollama / OpenAI-compatible) ───────────────────────

function isOpenAIFormat(baseUrl: string): boolean {
  return baseUrl.includes("/v1");
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
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }

    if (attempt < maxRetries) {
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.random() * delay * 0.1;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

function createRemoteLLMClient(config: LLMConfig): LLMClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl!;
  const openai = isOpenAIFormat(baseUrl);

  return {
    async chat(messages: ChatMessage[]): Promise<LLMResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (openai) {
          return await chatOpenAI(config, baseUrl, messages, controller.signal);
        }
        return await chatOllama(config, baseUrl, messages, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },

    async listModels(): Promise<string[]> {
      try {
        if (openai) {
          const resp = await fetch(`${baseUrl}/models`);
          const data = (await resp.json()) as { data?: Array<{ id: string }> };
          return data.data?.map((m) => m.id) ?? [];
        }
        const resp = await fetch(`${baseUrl}/api/tags`);
        const data = (await resp.json()) as {
          models?: Array<{ name: string }>;
        };
        return data.models?.map((m) => m.name) ?? [];
      } catch {
        return [];
      }
    },
  };
}

async function chatOllama(
  config: LLMConfig,
  baseUrl: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<LLMResponse> {
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

  const response = await fetchWithRetry(
    `${baseUrl}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }
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
    usage: data.prompt_eval_count != null
      ? {
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        }
      : undefined,
  };
}

async function chatOpenAI(
  config: LLMConfig,
  baseUrl: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<LLMResponse> {
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
  };

  const apiKey =
    process.env.OPENAI_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    },
  );

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }
    throw new Error(
      `OpenAI API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI API returned empty response");
  }

  return {
    content,
    finishReason: data.choices?.[0]?.finish_reason ?? "stop",
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
