/**
 * Local LLM provider using node-llama-cpp.
 *
 * Runs a GGUF model in-process via llama.cpp — no HTTP overhead,
 * model stays loaded between requests.
 *
 * All LLM calls go through a serial queue since we have a single
 * model/context/sequence. Each caller gets a Promise that resolves
 * when the model finishes their request. This correctly handles
 * concurrent RLM iterations, sub-RLM llm_query() calls, and
 * multiple API requests.
 */

import {
  getLlama,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type LlamaContextSequence,
} from "node-llama-cpp";
import type { LLMConfig, LLMClient, ChatMessage, LLMResponse } from "./types.js";

// ─── Singleton model state ────────────────────────────────────────────

let llamaInstance: Llama | null = null;
let loadedModel: LlamaModel | null = null;
let modelContext: LlamaContext | null = null;
let modelSequence: LlamaContextSequence | null = null;
let loadedModelPath: string | null = null;

async function ensureModel(config: LLMConfig): Promise<{
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
}> {
  const modelPath = config.modelPath!;

  if (loadedModel && modelContext && modelSequence && loadedModelPath === modelPath) {
    return { model: loadedModel, context: modelContext, sequence: modelSequence };
  }

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
  resolve: (response: LLMResponse) => void;
  reject: (error: Error) => void;
}

let queue: QueuedRequest[] = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return; // another loop is already draining
  processing = true;

  while (queue.length > 0) {
    const req = queue.shift()!;
    try {
      const response = await runInference(req.messages, req.config);
      req.resolve(response);
    } catch (err) {
      req.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  processing = false;
}

function enqueue(messages: ChatMessage[], config: LLMConfig): Promise<LLMResponse> {
  return new Promise<LLMResponse>((resolve, reject) => {
    queue.push({ messages, config, resolve, reject });
    // Kick the queue — if already processing, this is a no-op
    processQueue();
  });
}

// ─── Inference ────────────────────────────────────────────────────────

type ChatHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | { type: "model"; response: string[] };

function convertHistory(messages: ChatMessage[]): {
  systemPrompt: string;
  history: ChatHistoryItem[];
  lastUserMessage: string;
} {
  let systemPrompt = "";
  const history: ChatHistoryItem[] = [];

  const firstSystem = messages.find((m) => m.role === "system");
  if (firstSystem) {
    systemPrompt = firstSystem.content;
  }

  const nonSystem = messages.filter(
    (m) => m.role !== "system" || m !== firstSystem,
  );

  let lastUserMessage = "";
  const historyMessages = [...nonSystem];

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    if (historyMessages[i].role === "user") {
      lastUserMessage = historyMessages[i].content;
      historyMessages.splice(i, 1);
      break;
    }
  }

  for (const msg of historyMessages) {
    if (msg.role === "user") {
      history.push({ type: "user", text: msg.content });
    } else if (msg.role === "assistant") {
      history.push({ type: "model", response: [msg.content] });
    } else if (msg.role === "system" && msg !== firstSystem) {
      history.push({ type: "user", text: msg.content });
    }
  }

  return { systemPrompt, history, lastUserMessage };
}

async function runInference(
  messages: ChatMessage[],
  config: LLMConfig,
): Promise<LLMResponse> {
  const { sequence } = await ensureModel(config);
  const { systemPrompt, history, lastUserMessage } = convertHistory(messages);

  // Create a fresh session on the persistent sequence.
  // LlamaChatSession resets the sequence state internally when
  // constructed, so no manual KV cache clearing needed.
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: systemPrompt || undefined,
  });

  // Set the full conversation history so the model sees prior turns.
  const fullHistory: ChatHistoryItem[] = [
    ...(systemPrompt
      ? [{ type: "system" as const, text: systemPrompt }]
      : []),
    ...history,
  ];
  if (fullHistory.length > 0) {
    session.setChatHistory(fullHistory);
  }

  let tokenCount = 0;
  const content = await session.prompt(lastUserMessage, {
    temperature: config.temperature ?? 0.7,
    topP: config.topP ?? 0.9,
    maxTokens: config.maxTokens ?? 4096,
    onTextChunk: () => {
      tokenCount++;
    },
  });

  return {
    content,
    finishReason: "stop",
    usage: {
      promptTokens: 0,
      completionTokens: tokenCount,
      totalTokens: tokenCount,
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Create a local LLM client that runs the model in-process.
 *
 * All chat() calls are serialized through a queue — the single model
 * processes one request at a time. Callers get a Promise that resolves
 * when it's their turn. This handles RLM iterations, sub-RLM calls
 * via llm_query(), and concurrent API requests correctly.
 */
export function createLocalLLMClient(config: LLMConfig): LLMClient {
  return {
    chat(messages: ChatMessage[]): Promise<LLMResponse> {
      return enqueue(messages, config);
    },

    async listModels(): Promise<string[]> {
      return [config.model];
    },
  };
}

/** Dispose the loaded model and free resources. */
export function disposeLocalLLM(): void {
  if (modelSequence) { modelSequence.dispose(); modelSequence = null; }
  if (modelContext) { modelContext.dispose(); modelContext = null; }
  if (loadedModel) { loadedModel.dispose(); loadedModel = null; }
  loadedModelPath = null;
  queue = [];
  processing = false;
}
