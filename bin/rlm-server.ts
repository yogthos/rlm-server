#!/usr/bin/env node

/**
 * CLI entry point for the RLM server.
 *
 * Usage:
 *   # Local inference (recommended — no HTTP overhead):
 *   RLM_MODEL_PATH=./models/gemma-4-26B-A4B-it-Q4_K_M.gguf npm start
 *
 *   # Or use a HuggingFace URI:
 *   RLM_MODEL_PATH="hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M" npm start
 *
 *   # Remote inference fallback (Ollama, vLLM, etc.):
 *   OLLAMA_BASE_URL=http://localhost:11434 RLM_MODEL=gemma4 npm start
 *
 * Environment variables:
 *   RLM_MODEL_PATH     — Path to GGUF file or HuggingFace URI (local inference)
 *   OLLAMA_BASE_URL    — Remote LLM base URL (fallback if no model path)
 *   RLM_MODEL          — Model name (default: gemma4)
 *   RLM_PORT           — Server port (default: 3000)
 *   RLM_HOST           — Bind host (default: 0.0.0.0)
 *   RLM_MAX_ITERATIONS — Max RLM iterations (default: 30)
 *   RLM_TEMPERATURE    — Sampling temperature (default: 0.7)
 *   RLM_CONTEXT_WINDOW — Context window size in tokens (default: 131072)
 *   RLM_GPU_LAYERS     — GPU layers to offload, -1=all, 0=CPU (local only)
 *   RLM_SANDBOX_TIMEOUT — Sandbox execution timeout in ms (default: 30000)
 *   RLM_MAX_HANDLES    — Max handles before LRU eviction (default: 200)
 *   RLM_MAX_SUB_DEPTH  — Max sub-RLM recursion depth (default: 3)
 */

import { loadConfig } from "../src/rlm/config.js";
import { startServer } from "../src/rlm/server.js";

const config = loadConfig();

if (!config.llm.modelPath && !config.llm.baseUrl) {
  console.error("Error: Set RLM_MODEL_PATH for local inference or OLLAMA_BASE_URL for remote.");
  console.error("");
  console.error("Examples:");
  console.error('  RLM_MODEL_PATH="hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M" npm start');
  console.error("  RLM_MODEL_PATH=./models/gemma4.gguf npm start");
  console.error("  OLLAMA_BASE_URL=http://localhost:11434 npm start");
  process.exit(1);
}

startServer(config);
