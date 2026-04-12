/**
 * RLM server configuration.
 *
 * Reads from environment variables with sensible defaults.
 * Local inference (modelPath) is preferred over remote (baseUrl).
 */

import type { ServerConfig } from "./types.js";

export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  const modelPath =
    process.env.RLM_MODEL_PATH ?? overrides?.llm?.modelPath ?? undefined;

  // Only use remote baseUrl if no local model path is configured
  const baseUrl = modelPath
    ? undefined
    : process.env.OLLAMA_BASE_URL ??
      overrides?.llm?.baseUrl ??
      "http://localhost:11434";

  return {
    port: num(process.env.RLM_PORT) ?? overrides?.port ?? 3000,
    host: process.env.RLM_HOST ?? overrides?.host ?? "0.0.0.0",
    llm: {
      modelPath,
      baseUrl,
      model:
        process.env.RLM_MODEL ??
        overrides?.llm?.model ??
        "gemma4",
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
      30_000,
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
