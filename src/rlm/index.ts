// RLM subsystem barrel exports

// Types
export type {
  LLMConfig,
  ChatMessage,
  LLMResponse,
  LLMClient,
  Handle,
  HandleStore,
  Z3Result,
  PrologResult,
  RLMContext,
  RLMResult,
  TraceEntry,
  ServerConfig,
} from "./types.js";

// Handle store
export { createHandleStore, commandToSlug, createStub } from "./handles.js";

// Code extraction
export { extractCode } from "./code-extractor.js";
export type { ExtractionResult } from "./code-extractor.js";

// Metadata
export { promptMetadata, stdoutMetadata, resultMetadata } from "./metadata.js";

// System prompt
export { buildSystemPrompt } from "./system-prompt.js";
export type { PromptConfig } from "./system-prompt.js";

// Solver bridges
export { z3Solve, Z3_IMPL, prepareSmtlib } from "./z3-bridge.js";
export { prologQuery, PROLOG_IMPL } from "./prolog-bridge.js";
export type { PrologOptions } from "./prolog-bridge.js";

// LLM client
export { createLLMClient } from "./llm-client.js";
export { createLocalLLMClient, disposeLocalLLM } from "./local-llm.js";

// Config
export { loadConfig } from "./config.js";

// Core RLM loop
export { runRLMLoop } from "./loop.js";
export type { RunRLMOptions } from "./loop.js";

// HTTP server
export { createServer, startServer } from "./server.js";
