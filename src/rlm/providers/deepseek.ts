/**
 * DeepSeek provider.
 *
 * DeepSeek's API is OpenAI-compatible. This is a thin preset that
 * sets the base URL and looks for DEEPSEEK_API_KEY by default.
 *
 * Common models:
 *   - deepseek-chat (general)
 *   - deepseek-reasoner (R1-style reasoning)
 *   - deepseek-coder (code)
 */

import type { LLMConfig, LLMClient } from "../types.js";
import { createOpenAIProvider } from "./openai.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export function createDeepSeekProvider(config: LLMConfig): LLMClient {
  return createOpenAIProvider(
    {
      ...config,
      baseUrl: config.baseUrl ?? DEEPSEEK_BASE_URL,
    },
    { providerHint: "deepseek" },
  );
}
