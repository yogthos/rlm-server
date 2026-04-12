/**
 * Shared type definitions for the RLM subsystem.
 */

import type { Sandbox } from "../types.js";

/** Configuration for the LLM backend. */
export interface LLMConfig {
  /** For local inference: path to GGUF file or HuggingFace URI (e.g. "hf:user/repo:Q4_K_M"). */
  modelPath?: string;
  /** For remote inference: base URL of Ollama or OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Model name (used for remote backends and API responses). */
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  /** Context window size in tokens (for local: passed to createContext). */
  contextWindow?: number;
  /** GPU layers to offload (-1 = all, 0 = CPU only). Local inference only. */
  gpuLayers?: number;
}

/** A single chat message in OpenAI format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The LLM's response from a single generation. */
export interface LLMResponse {
  content: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** LLM client interface. */
export interface LLMClient {
  chat(messages: ChatMessage[]): Promise<LLMResponse>;
  /** Streaming variant — calls onChunk for each generated token. */
  chatStream?(
    messages: ChatMessage[],
    onChunk: (token: string) => void,
  ): Promise<LLMResponse>;
  listModels(): Promise<string[]>;
}

/** A handle: server-side stored result with a stub shown to the LLM. */
export interface Handle {
  name: string;
  data: unknown;
  stub: string;
  createdAt: number;
}

/** Handle store interface. */
export interface HandleStore {
  set(data: unknown, code?: string): Handle;
  get(name: string): Handle | undefined;
  resolve(name: string): unknown;
  getResults(): Handle | undefined;
  buildContext(): string;
  clear(): void;
  readonly size: number;
}

/** Z3 solver result. */
export interface Z3Result {
  status: "sat" | "unsat" | "unknown" | "error";
  model?: Record<string, string>;
  unsatCore?: string[];
  error?: string;
}

/** Prolog query result. */
export interface PrologResult {
  status: "success" | "error";
  answers?: Array<{ bindings: Record<string, string>; formatted: string }>;
  exhausted?: boolean;
  trace?: string[];
  error?: string;
}

/** A single trace entry from the RLM loop. */
export interface TraceEntry {
  iteration: number;
  code: string;
  stdout: string;
  handlesSummary: string;
  error?: string;
  durationMs: number;
}

/** Context for the RLM FSM loop. */
export interface RLMContext {
  // Immutable config
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly maxIterations: number;
  readonly llmClient: LLMClient;
  readonly sandboxTimeoutMs: number;
  readonly maxSubRLMDepth: number;
  readonly subRLMDepth: number;

  // Mutable state
  sandbox: Sandbox | null;
  handleStore: HandleStore;
  history: ChatMessage[];
  iteration: number;
  finalAnswer: string | null;
  lastCode: string | null;
  lastLLMOutput: string | null;
  lastError: string | null;
  noCodeCount: number;
  trace: TraceEntry[];
}

/** Result of running the RLM loop. */
export interface RLMResult {
  answer: string;
  iterations: number;
  trace: TraceEntry[];
}

/** RLM server configuration. */
export interface ServerConfig {
  port: number;
  host: string;
  llm: LLMConfig;
  maxIterations: number;
  sandboxTimeoutMs: number;
  maxHandles: number;
  maxSubRLMDepth: number;
}
