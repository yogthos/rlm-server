#!/usr/bin/env node

/**
 * CLI entry point for the RLM server.
 *
 * Provider selection (auto-detected from env, override with RLM_PROVIDER):
 *   - RLM_MODEL_PATH set → "local" (in-process llama.cpp)
 *   - DEEPSEEK_API_KEY set → "deepseek"
 *   - OPENAI_API_KEY set → "openai"
 *   - default → "ollama" (assumes localhost:11434)
 *
 * Examples:
 *   # Local GGUF model
 *   RLM_MODEL_PATH=./models/Qwen3.6-35B-A3B-Q8_0.gguf npm start
 *
 *   # DeepSeek API
 *   DEEPSEEK_API_KEY=sk-... npm start
 *   DEEPSEEK_API_KEY=sk-... RLM_MODEL=deepseek-reasoner npm start
 *
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... RLM_MODEL=gpt-4o-mini npm start
 *
 *   # Ollama
 *   RLM_PROVIDER=ollama RLM_MODEL=qwen2.5:32b npm start
 *
 * All env vars:
 *   RLM_PROVIDER       — "local" | "openai" | "deepseek" | "ollama"
 *   RLM_MODEL_PATH     — GGUF path or HuggingFace URI (local inference)
 *   RLM_BASE_URL       — Override the API endpoint
 *   RLM_MODEL          — Model name (provider-specific default)
 *   DEEPSEEK_API_KEY   — DeepSeek auth
 *   OPENAI_API_KEY     — OpenAI auth
 *   OLLAMA_BASE_URL    — Ollama URL (default http://localhost:11434)
 *   RLM_PORT           — Server port (default: 3000)
 *   RLM_HOST           — Bind host (default: 0.0.0.0)
 *   RLM_MAX_ITERATIONS — Max RLM iterations (default: 30)
 *   RLM_MAX_TOKENS     — Per-iteration max tokens (default: 2048)
 *   RLM_TEMPERATURE    — Sampling temperature (default: 0.7)
 *   RLM_CONTEXT_WINDOW — Context window size in tokens (default: 131072)
 *   RLM_GPU_LAYERS     — GPU layers (-1=all, 0=CPU; local only)
 *   RLM_SANDBOX_TIMEOUT — Sandbox execution timeout in ms (default: 120000)
 *   RLM_MAX_HANDLES    — Max handles before LRU eviction (default: 200)
 *   RLM_MAX_SUB_DEPTH  — Max sub-RLM recursion depth (default: 3)
 */

import { loadConfig } from "../src/rlm/config.js";
import { startServer } from "../src/rlm/server.js";

const config = loadConfig();

// Sanity check: each provider needs something
const provider = config.llm.provider ?? "ollama";
if (provider === "local" && !config.llm.modelPath) {
  console.error("Error: RLM_PROVIDER=local but no RLM_MODEL_PATH set.");
  process.exit(1);
}
if (
  (provider === "openai" || provider === "deepseek") &&
  !process.env.OPENAI_API_KEY &&
  !process.env.DEEPSEEK_API_KEY &&
  !config.llm.apiKey
) {
  console.error(
    `Error: provider=${provider} but no API key set (OPENAI_API_KEY / DEEPSEEK_API_KEY).`,
  );
  process.exit(1);
}

startServer(config);
