/**
 * Shared type definitions for the RLM subsystem.
 */

import type { Sandbox } from "../types.js";

/** Provider type — picks the LLM backend implementation. */
export type ProviderType = "local" | "openai" | "ollama" | "deepseek";

/** Configuration for the LLM backend. */
export interface LLMConfig {
  /** Which provider to use. If omitted, inferred from modelPath/baseUrl. */
  provider?: ProviderType;
  /** For local inference: path to GGUF file or HuggingFace URI (e.g. "hf:user/repo:Q4_K_M"). */
  modelPath?: string;
  /** For remote inference: base URL. Defaults vary per provider. */
  baseUrl?: string;
  /** API key for cloud providers (or set via env var). */
  apiKey?: string;
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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For assistant messages that called a tool */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** For role: "tool" — the id of the assistant's tool_call this responds to */
  tool_call_id?: string;
}

/** The LLM's response from a single generation. */
export interface LLMResponse {
  content: string;
  finishReason: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Options passed to chat() — includes OpenAI tools and response_format. */
export interface ChatOptions {
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** OpenAI response_format: forces structured JSON output from the model. */
  responseFormat?:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { schema: Record<string, unknown>; name?: string; strict?: boolean } };
  /** Abort signal — cancel generation on client disconnect or timeout. */
  signal?: AbortSignal;
}

/** LLM client interface. */
export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
  /** Streaming variant — calls onChunk for each generated token. */
  chatStream?(
    messages: ChatMessage[],
    onChunk: (token: string) => void,
    options?: ChatOptions,
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
  readonly signal?: AbortSignal;
  /** Optional hierarchical-agent role binding (role + task envelope). */
  readonly roleBinding?: import("./system-prompt.js").RoleBinding;

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
  /** Cumulative no-code count across the whole loop (not reset by nudges). */
  totalNoCodeCount: number;
  /** Number of consecutive iterations where the last error was the same. */
  repeatedErrorCount: number;
  /** Number of consecutive iterations producing the same response prefix. */
  repeatedResponseCount: number;
  /** Sub-RLM spawn counter (shared mutable object set in initHandler). */
  spawnStats: { dispatched: number; completed: number };
  /** Whether we've already injected the "stop, decompose now" directive. */
  decompositionNudged: boolean;
  /** Whether this task was determined to require planning/decomposition. */
  requiresPlan: boolean;
  /** How many times we've rejected a premature FINAL() (cap at 1). */
  premateFinalRejections: number;
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
