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
  /**
   * Preserve the model's chain-of-thought across turns (Qwen 3.x models).
   * When true, past reasoning is kept in the context so the model can
   * reference it — improves agent/tool-calling consistency and KV-cache
   * reuse. Maps to `QwenChatWrapper.keepOnlyLastThought = !preserveThinking`
   * in node-llama-cpp. Default: true.
   */
  preserveThinking?: boolean;
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
  /** Max Architect-review cycles per dispatched function (from config). */
  readonly maxReviewCycles: number;
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
  /** Parsed spec items from the user prompt (M1 spec-checklist). */
  specItems: import("./spec-checklist.js").SpecItem[];
  /** How many times we've rejected a FINAL() for unsatisfied spec items. */
  specRejections: number;
  /** How many times we've rejected an Architect FINAL() before any dispatch. */
  architectDispatchRejections: number;
  /** How many structural-repair cycles the root has run (capped). */
  repairAttempts: number;
  /** Whether we've already nudged the model about FINAL/FINAL_VAR placement. */
  directiveMisplacementNudged: boolean;
  /** Per-template fire counters for response-format checks. */
  formatNudges: Record<string, number>;
  /**
   * When FINAL_VAR resolution falls through to sandbox execution (the
   * variable wasn't a known handle but might be a sandbox global), this
   * flag tells executeHandler to promote the execute result directly to
   * `finalAnswer` instead of just storing a handle and looping.
   */
  pendingFinalVar: boolean;
  /**
   * Set alongside `pendingFinalVar` when the original directive was
   * FINAL_FILES — the execute result should be rendered as a multi-file
   * payload (via renderFileSet) instead of bare JSON.
   */
  pendingFinalFiles: boolean;
  /**
   * How many times we've rejected a FINAL(x) where x was a bare
   * identifier matching a stored handle (common FINAL-vs-FINAL_VAR
   * confusion). Capped at 1 rejection to avoid ping-pong.
   */
  finalLiteralRejections: number;
  /** Append-only action ledger (M2) — one entry per FSM transition. */
  ledger: import("./action-ledger.js").Ledger;
  /**
   * Failure-signature memory (M3) — recurring error → fix hint. Mutable
   * store so the same instance can be shared across the recursive tree;
   * every sub-RLM's recordings are visible to the root on bubble-up,
   * and a sub-RLM sees patterns its siblings already registered.
   */
  failureMemory: import("./failure-memory.js").FailureMemoryStore;
  /** Accumulating code produced across the run (G3). */
  projectGraph: import("./project-graph.js").ProjectGraph;
  /**
   * In-memory canonical DesignGraph for the hierarchical workflow.
   * Architect builds it (modules, signatures, imports, tests); children
   * attach implementations. Shared across the recursion — a single
   * instance serves every depth.
   */
  designGraph: import("./design-graph.js").DesignGraph;
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
  /** Max Architect-review cycles per dispatched function. 0 disables
   *  review. Defaults to 2. */
  maxReviewCycles: number;
}
