/**
 * RLM server configuration.
 *
 * Reads from environment variables with sensible defaults.
 *
 * Provider selection priority:
 *   1. RLM_PROVIDER explicitly set ("local" | "openai" | "deepseek" | "ollama")
 *   2. RLM_MODEL_PATH set → "local"
 *   3. DEEPSEEK_API_KEY set → "deepseek"
 *   4. OPENAI_API_KEY set → "openai"
 *   5. Default: "ollama" (assume local Ollama)
 */

import type { ServerConfig, ProviderType } from "./types.js";

function pickProvider(envProvider: string | undefined): ProviderType {
  if (envProvider) {
    if (["local", "openai", "deepseek", "ollama"].includes(envProvider)) {
      return envProvider as ProviderType;
    }
  }
  if (process.env.RLM_MODEL_PATH) return "local";
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

function defaultBaseUrl(provider: ProviderType): string | undefined {
  switch (provider) {
    case "local":
      return undefined;
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "ollama":
      return "http://localhost:11434";
  }
}

function defaultModel(provider: ProviderType): string {
  switch (provider) {
    case "deepseek":
      return "deepseek-chat";
    case "openai":
      return "gpt-4o-mini";
    default:
      return "gemma4";
  }
}

export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  const provider =
    overrides?.llm?.provider ?? pickProvider(process.env.RLM_PROVIDER);

  const modelPath =
    process.env.RLM_MODEL_PATH ?? overrides?.llm?.modelPath ?? undefined;

  const baseUrl =
    process.env.RLM_BASE_URL ??
    process.env.OLLAMA_BASE_URL ??
    overrides?.llm?.baseUrl ??
    defaultBaseUrl(provider);

  return {
    port: num(process.env.RLM_PORT) ?? overrides?.port ?? 3000,
    host: process.env.RLM_HOST ?? overrides?.host ?? "0.0.0.0",
    llm: {
      provider,
      modelPath,
      baseUrl,
      apiKey: overrides?.llm?.apiKey,
      model:
        process.env.RLM_MODEL ?? overrides?.llm?.model ?? defaultModel(provider),
      maxTokens:
        num(process.env.RLM_MAX_TOKENS) ??
        overrides?.llm?.maxTokens ??
        2048,
      temperature:
        num(process.env.RLM_TEMPERATURE) ??
        overrides?.llm?.temperature ??
        0.7,
      timeoutMs:
        num(process.env.RLM_TIMEOUT_MS) ??
        overrides?.llm?.timeoutMs ??
        120_000,
      contextWindow:
        num(process.env.RLM_CONTEXT_WINDOW) ??
        overrides?.llm?.contextWindow ??
        131_072,
      gpuLayers:
        num(process.env.RLM_GPU_LAYERS) ??
        overrides?.llm?.gpuLayers ??
        undefined,
    },
    maxIterations:
      num(process.env.RLM_MAX_ITERATIONS) ??
      overrides?.maxIterations ??
      30,
    sandboxTimeoutMs:
      num(process.env.RLM_SANDBOX_TIMEOUT) ??
      overrides?.sandboxTimeoutMs ??
      120_000,
    maxHandles:
      num(process.env.RLM_MAX_HANDLES) ??
      overrides?.maxHandles ??
      200,
    maxSubRLMDepth:
      num(process.env.RLM_MAX_SUB_DEPTH) ??
      overrides?.maxSubRLMDepth ??
      3,
  };
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}
