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
      return "local-model";
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
        4096,
      temperature:
        num(process.env.RLM_TEMPERATURE) ??
        overrides?.llm?.temperature ??
        0.7,
      timeoutMs:
        num(process.env.RLM_TIMEOUT_MS) ??
        overrides?.llm?.timeoutMs ??
        // 5 min default — deepseek can exceed 2 min on complex prompts,
        // and local GGUF inference on long contexts routinely hits
        // 3-4 min. Too short a default causes spurious AbortController
        // exhaustion before the model has a chance to respond.
        300_000,
      contextWindow:
        num(process.env.RLM_CONTEXT_WINDOW) ??
        overrides?.llm?.contextWindow ??
        131_072,
      gpuLayers:
        num(process.env.RLM_GPU_LAYERS) ??
        overrides?.llm?.gpuLayers ??
        undefined,
      // Default ON — for agent workflows the model benefits from seeing
      // its own prior reasoning and KV-cache reuse improves.
      preserveThinking:
        bool(process.env.RLM_PRESERVE_THINKING) ??
        overrides?.llm?.preserveThinking ??
        true,
    },
    maxIterations:
      num(process.env.RLM_MAX_ITERATIONS) ??
      overrides?.maxIterations ??
      30,
    sandboxTimeoutMs:
      num(process.env.RLM_SANDBOX_TIMEOUT) ??
      overrides?.sandboxTimeoutMs ??
      // 2 hours. The sandbox hosts `design_plan` / `design_build`, which
      // drive a multi-turn LLM pipeline — phase 1 + N phase 2 turns + N
      // dispatch attempts + finalize. On local inference each turn is
      // 30–180s, so a 12-function build easily runs 45+ minutes. Prior
      // 10-minute cap killed runs mid phase 2 with work lost. Bridges
      // carry their own per-operation timeouts (test-runner 60s,
      // finalize 120s); this is the outer safety net only.
      7_200_000,
    maxHandles:
      num(process.env.RLM_MAX_HANDLES) ??
      overrides?.maxHandles ??
      200,
    maxSubRLMDepth:
      num(process.env.RLM_MAX_SUB_DEPTH) ??
      overrides?.maxSubRLMDepth ??
      3,
    maxReviewCycles:
      num(process.env.RLM_MAX_REVIEW_CYCLES) ??
      overrides?.maxReviewCycles ??
      3,
  };
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase().trim();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}
