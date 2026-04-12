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
import type { LLMConfig, LLMClient, ChatMessage, LLMResponse } from "./types.js";

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

  // Pull off the trailing user message as the new prompt
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
      priorHistory.push({ type: "user", text: msg.content });
    } else if (msg.role === "assistant") {
      priorHistory.push({ type: "model", response: [msg.content] });
    } else if (msg.role === "system") {
      priorHistory.push({ type: "user", text: msg.content });
    }
  }

  return { systemPrompt, priorHistory, lastUserMessage };
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
  const content = await activeSession!.prompt(lastUserMessage, {
    temperature: config.temperature ?? 0.7,
    topP: config.topP ?? 0.9,
    maxTokens: config.maxTokens ?? 4096,
    onTextChunk: () => {
      tokenCount++;
    },
  });

  // Update activeHistory to reflect what was just added
  activeHistory.push({ type: "user", text: lastUserMessage });
  activeHistory.push({ type: "model", response: [content] });

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
