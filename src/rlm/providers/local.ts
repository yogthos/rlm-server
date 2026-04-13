/**
 * Local LLM provider using node-llama-cpp.
 *
 * Runs a GGUF model in-process via llama.cpp — no HTTP overhead,
 * model stays loaded between requests.
 *
 * KV cache reuse: a persistent LlamaChatSession is kept. When incoming
 * messages are a prefix-extension of the session's current history
 * (common case: RLM loop iterations appending to history), we just call
 * prompt() with the new user message — KV cache is preserved across
 * iterations. When messages don't match (new conversation), we reset.
 *
 * All calls serialized through a queue since we have a single sequence.
 */

import {
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type LlamaContextSequence,
} from "node-llama-cpp";
import type {
  LLMConfig,
  LLMClient,
  ChatMessage,
  LLMResponse,
  ChatOptions,
} from "../types.js";
import {
  convertToolsToFunctions,
  convertToolCallToOpenAI,
  type CapturedCall,
} from "../tool-calls.js";
import { debug } from "../debug.js";

// ─── Singleton model state ────────────────────────────────────────────

let llamaInstance: Llama | null = null;
let loadedModel: LlamaModel | null = null;
let modelContext: LlamaContext | null = null;
let modelSequence: LlamaContextSequence | null = null;
let loadedModelPath: string | null = null;

// Persistent chat session + its history for cache reuse detection
let activeSession: LlamaChatSession | null = null;
let activeSystemPrompt: string = "";
let activeHistory: ChatHistoryItem[] = [];

async function ensureModel(config: LLMConfig): Promise<{
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
}> {
  const modelPath = config.modelPath!;

  if (loadedModel && modelContext && modelSequence && loadedModelPath === modelPath) {
    return { model: loadedModel, context: modelContext, sequence: modelSequence };
  }

  if (activeSession) { activeSession = null; activeSystemPrompt = ""; activeHistory = []; }
  if (modelSequence) { modelSequence.dispose(); modelSequence = null; }
  if (modelContext) { await modelContext.dispose(); modelContext = null; }
  if (loadedModel) { await loadedModel.dispose(); loadedModel = null; }

  if (!llamaInstance) {
    llamaInstance = await getLlama("lastBuild");
  }

  console.log(`Loading model: ${modelPath}...`);
  loadedModel = await llamaInstance.loadModel({ modelPath });

  const contextSize = config.contextWindow
    ? { min: 8192, max: config.contextWindow }
    : { min: 8192 };

  modelContext = await loadedModel.createContext({
    contextSize,
    flashAttention: true,
  });
  modelSequence = modelContext.getSequence();
  loadedModelPath = modelPath;

  console.log(`Model loaded. Context size: ${modelContext.contextSize} tokens`);

  return { model: loadedModel, context: modelContext, sequence: modelSequence };
}

// ─── Request queue ────────────────────────────────────────────────────

interface QueuedRequest {
  messages: ChatMessage[];
  config: LLMConfig;
  onChunk?: (token: string) => void;
  options?: ChatOptions;
  resolve: (response: LLMResponse) => void;
  reject: (error: Error) => void;
}

let queue: QueuedRequest[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const req = queue.shift()!;
    debug("queue", `processing request, ${queue.length} more queued`);
    const start = Date.now();
    try {
      const response = await runInference(
        req.messages,
        req.config,
        req.onChunk,
        req.options,
      );
      const ms = Date.now() - start;
      debug(
        "queue",
        `completed in ${ms}ms, ${response.usage?.completionTokens ?? 0} tokens`,
      );
      req.resolve(response);
    } catch (err) {
      const ms = Date.now() - start;
      debug("queue", `failed after ${ms}ms:`, err);
      req.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  processing = false;
}

function enqueue(
  messages: ChatMessage[],
  config: LLMConfig,
  onChunk?: (token: string) => void,
  options?: ChatOptions,
): Promise<LLMResponse> {
  return new Promise<LLMResponse>((resolve, reject) => {
    debug(
      "queue",
      `enqueue ${messages.length} messages, queue depth now ${queue.length + 1}`,
    );
    queue.push({ messages, config, onChunk, options, resolve, reject });
    processQueue();
  });
}

// ─── History conversion and matching ──────────────────────────────────

type ChatHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | { type: "model"; response: string[] };

function convertHistory(messages: ChatMessage[]): {
  systemPrompt: string;
  priorHistory: ChatHistoryItem[];
  lastUserMessage: string;
} {
  let systemPrompt = "";
  const priorHistory: ChatHistoryItem[] = [];

  const firstSystem = messages.find((m) => m.role === "system");
  if (firstSystem) {
    systemPrompt = firstSystem.content;
  }

  const nonSystem = messages.filter((m) => m !== firstSystem);

  // Format tool messages as text the model can understand. OpenAI's
  // "role: tool" messages carry function results we need to inject
  // back into the conversation so the model can reason over them.
  const formatTool = (m: ChatMessage): string => {
    const id = m.tool_call_id ? ` (id: ${m.tool_call_id})` : "";
    return `Tool result${id}:\n${m.content}`;
  };

  // Build the history + identify the "prompt" (the last thing that
  // needs a response). This is either a user message or a tool result.
  let lastPrompt = "";
  const historyMessages = [...nonSystem];

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const m = historyMessages[i];
    if (m.role === "user") {
      lastPrompt = m.content;
      historyMessages.splice(i, 1);
      break;
    }
    if (m.role === "tool") {
      lastPrompt = formatTool(m);
      historyMessages.splice(i, 1);
      break;
    }
  }

  for (const msg of historyMessages) {
    if (msg.role === "user") {
      priorHistory.push({ type: "user", text: msg.content });
    } else if (msg.role === "assistant") {
      // For assistants that called a tool, synthesize the tool call
      // back into text form so the model sees what it "said" before.
      let text = msg.content ?? "";
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const callsStr = msg.tool_calls
          .map(
            (tc) =>
              `[called ${tc.function.name} with ${tc.function.arguments}]`,
          )
          .join("\n");
        text = text ? `${text}\n${callsStr}` : callsStr;
      }
      priorHistory.push({ type: "model", response: [text] });
    } else if (msg.role === "tool") {
      priorHistory.push({ type: "user", text: formatTool(msg) });
    } else if (msg.role === "system") {
      priorHistory.push({ type: "user", text: msg.content });
    }
  }

  return { systemPrompt, priorHistory, lastUserMessage: lastPrompt };
}

/**
 * Check if `priorHistory` extends `activeHistory` — i.e. the active
 * session already has these messages cached. Requires same system
 * prompt and priorHistory strictly extending activeHistory.
 */
function canReuseSession(
  systemPrompt: string,
  priorHistory: ChatHistoryItem[],
): boolean {
  if (!activeSession) return false;
  if (systemPrompt !== activeSystemPrompt) return false;
  if (priorHistory.length < activeHistory.length) return false;

  for (let i = 0; i < activeHistory.length; i++) {
    const a = activeHistory[i];
    const b = priorHistory[i];
    if (a.type !== b.type) return false;
    if (a.type === "user" && b.type === "user") {
      if (a.text !== b.text) return false;
    } else if (a.type === "model" && b.type === "model") {
      if (a.response.join("") !== b.response.join("")) return false;
    } else if (a.type === "system" && b.type === "system") {
      if (a.text !== b.text) return false;
    } else {
      return false;
    }
  }
  return true;
}

// ─── Inference ────────────────────────────────────────────────────────

async function runInference(
  messages: ChatMessage[],
  config: LLMConfig,
  onChunk?: (token: string) => void,
  options?: ChatOptions,
): Promise<LLMResponse> {
  const { context, sequence } = await ensureModel(config);
  const { systemPrompt, priorHistory, lastUserMessage } =
    convertHistory(messages);

  const reuse = canReuseSession(systemPrompt, priorHistory);

  if (!reuse) {
    // Fresh session: clear KV cache and rebuild
    sequence.eraseContextTokenRanges([{
      start: 0,
      end: context.contextSize,
    }]);

    activeSession = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt: systemPrompt || undefined,
    });
    activeSystemPrompt = systemPrompt;

    const fullHistory: ChatHistoryItem[] = [
      ...(systemPrompt
        ? [{ type: "system" as const, text: systemPrompt }]
        : []),
      ...priorHistory,
    ];
    if (fullHistory.length > 0) {
      activeSession.setChatHistory(fullHistory);
    }
    activeHistory = [...priorHistory];
  } else {
    // Reuse: priorHistory may have new messages beyond activeHistory.
    // Apply the delta so the session's state matches.
    if (priorHistory.length > activeHistory.length) {
      const fullHistory: ChatHistoryItem[] = [
        ...(systemPrompt
          ? [{ type: "system" as const, text: systemPrompt }]
          : []),
        ...priorHistory,
      ];
      activeSession!.setChatHistory(fullHistory);
      activeHistory = [...priorHistory];
    }
  }

  let tokenCount = 0;

  // Build functions map from tools (if any) and capture calls
  const captures: CapturedCall[] = [];
  const functions = options?.tools && options.tools.length > 0
    ? convertToolsToFunctions(options.tools, captures)
    : undefined;

  // If response_format is set, build a JSON grammar to constrain output.
  // tools + grammar are mutually exclusive in node-llama-cpp — tools
  // already use grammar-guided output internally.
  let grammar: import("node-llama-cpp").LlamaGrammar | undefined;
  if (options?.responseFormat && !functions) {
    const rf = options.responseFormat;
    const llama = llamaInstance!;
    if (rf.type === "json_schema") {
      grammar = await llama.createGrammarForJsonSchema(rf.json_schema.schema as any);
    } else if (rf.type === "json_object") {
      // Generic JSON object grammar — any valid JSON
      grammar = await llama.getGrammarFor("json");
    }
  }

  const promptOptions: Record<string, unknown> = {
    temperature: config.temperature ?? 0.7,
    topP: config.topP ?? 0.9,
    maxTokens: config.maxTokens ?? 2048,
    onTextChunk: (chunk: string) => {
      tokenCount++;
      onChunk?.(chunk);
    },
  };
  if (options?.signal) {
    promptOptions.signal = options.signal;
    promptOptions.stopOnAbortSignal = true;
  }
  if (functions) {
    promptOptions.functions = functions;
  } else if (grammar) {
    promptOptions.grammar = grammar;
  }

  const session = activeSession!;
  const content = await session.prompt(
    lastUserMessage,
    promptOptions as Parameters<typeof session.prompt>[1],
  );

  // Update activeHistory to reflect what was just added
  activeHistory.push({ type: "user", text: lastUserMessage });
  activeHistory.push({ type: "model", response: [content] });

  // If any tool calls were captured, convert to OpenAI format
  const toolCalls = captures.length > 0
    ? captures.map(convertToolCallToOpenAI)
    : undefined;

  return {
    content,
    finishReason: toolCalls ? "tool_calls" : "stop",
    toolCalls,
    usage: {
      promptTokens: 0,
      completionTokens: tokenCount,
      totalTokens: tokenCount,
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────

export function createLocalProvider(config: LLMConfig): LLMClient {
  return {
    chat(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): Promise<LLMResponse> {
      return enqueue(messages, config, undefined, options);
    },

    chatStream(
      messages: ChatMessage[],
      onChunk: (token: string) => void,
      options?: ChatOptions,
    ): Promise<LLMResponse> {
      return enqueue(messages, config, onChunk, options);
    },

    async listModels(): Promise<string[]> {
      return [config.model];
    },
  };
}

/** Exposed for tests — converts OpenAI messages to node-llama-cpp history. */
export function convertMessagesForTesting(messages: ChatMessage[]) {
  return convertHistory(messages);
}

/** Dispose the loaded model and free resources. */
export function disposeLocalProvider(): void {
  activeSession = null;
  activeSystemPrompt = "";
  activeHistory = [];
  if (modelSequence) { modelSequence.dispose(); modelSequence = null; }
  if (modelContext) { modelContext.dispose(); modelContext = null; }
  if (loadedModel) { loadedModel.dispose(); loadedModel = null; }
  loadedModelPath = null;
  queue = [];
  processing = false;
}
