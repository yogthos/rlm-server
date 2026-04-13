/**
 * Provider registry.
 *
 * createLLMClient(config) picks a provider based on:
 *   1. config.provider explicitly set ("local" | "openai" | "ollama" | "deepseek")
 *   2. config.modelPath set → "local"
 *   3. config.baseUrl with ":11434" or no /v1 → "ollama"
 *   4. config.baseUrl with "/v1" → "openai"
 */

import type { LLMConfig, LLMClient, ProviderType } from "../types.js";
import { createLocalProvider, disposeLocalProvider } from "./local.js";
import { createOpenAIProvider } from "./openai.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { createOllamaProvider } from "./ollama.js";

export { createLocalProvider, disposeLocalProvider } from "./local.js";
export { createOpenAIProvider } from "./openai.js";
export { createDeepSeekProvider } from "./deepseek.js";
export { createOllamaProvider } from "./ollama.js";

export function pickProvider(config: LLMConfig): ProviderType {
  if (config.provider) return config.provider;
  if (config.modelPath) return "local";
  const url = config.baseUrl ?? "";
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes(":11434") && !url.includes("/v1")) return "ollama";
  if (url.includes("/v1") || url.startsWith("https://")) return "openai";
  if (url.includes("11434")) return "ollama";
  // Default: if there's a baseUrl assume OpenAI-compatible
  if (url) return "openai";
  return "local";
}

export function createLLMClient(config: LLMConfig): LLMClient {
  const provider = pickProvider(config);
  switch (provider) {
    case "local":
      return createLocalProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    case "deepseek":
      return createDeepSeekProvider(config);
    case "ollama":
      return createOllamaProvider(config);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
