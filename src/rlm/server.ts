/**
 * OpenAI-compatible HTTP API server.
 *
 * Endpoints:
 *   POST /v1/chat/completions  — Run RLM loop, return OpenAI-format response
 *   GET  /v1/models            — List available models
 *   GET  /health               — Health check
 *
 * Supports both streaming (SSE) and non-streaming responses.
 */

import http from "node:http";
import crypto from "node:crypto";
import type { ServerConfig, ChatMessage, ChatOptions } from "./types.js";
import { createLLMClient } from "./llm-client.js";
import { runRLMLoop } from "./loop.js";
import { routeRequest } from "./routing.js";
import type { OpenAITool } from "./tool-calls.js";
import { debug } from "./debug.js";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(json);
}

function errorResponse(
  res: http.ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
): void {
  jsonResponse(res, status, {
    error: { message, type, code: status.toString() },
  });
}

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Generate an OpenAI-format model record. */
function modelInfo(id: string, config: ServerConfig): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "local",
    // Non-standard but commonly expected extension fields
    context_length: config.llm.contextWindow ?? 131072,
    max_output_tokens: config.llm.maxTokens ?? 4096,
  };
}

export function createServer(config: ServerConfig): http.Server {
  const llmClient = createLLMClient(config.llm);

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const url = req.url ?? "/";

    try {
      // ── Health Check ──
      if (url === "/health" && req.method === "GET") {
        jsonResponse(res, 200, { status: "ok" });
        return;
      }

      // ── List Models ──
      if (url === "/v1/models" && req.method === "GET") {
        const models = await llmClient.listModels();
        jsonResponse(res, 200, {
          object: "list",
          data: models.map((id) => modelInfo(id, config)),
        });
        return;
      }

      // ── Retrieve Model ──
      const modelMatch = url.match(/^\/v1\/models\/(.+)$/);
      if (modelMatch && req.method === "GET") {
        const modelId = decodeURIComponent(modelMatch[1]);
        const models = await llmClient.listModels();
        if (!models.includes(modelId)) {
          errorResponse(res, 404, `Model not found: ${modelId}`);
          return;
        }
        jsonResponse(res, 200, modelInfo(modelId, config));
        return;
      }

      // ── Chat Completions ──
      if (url === "/v1/chat/completions" && req.method === "POST") {
        // Abort when the client disconnects so we don't burn GPU cycles
        // on a response no one will read.
        const abortController = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) {
            debug("server", "client disconnected, aborting generation");
            abortController.abort();
          }
        };
        req.on("close", onClose);
        res.on("close", onClose);

        const body = await readBody(req);
        let request: {
          model?: string;
          messages?: ChatMessage[];
          stream?: boolean;
          max_iterations?: number;
          rlm?: boolean;
          tools?: OpenAITool[];
          tool_choice?: ChatOptions["toolChoice"];
          response_format?: ChatOptions["responseFormat"];
        };

        try {
          request = JSON.parse(body);
        } catch {
          errorResponse(res, 400, "Invalid JSON body");
          return;
        }

        if (
          !request.messages ||
          !Array.isArray(request.messages) ||
          request.messages.length === 0
        ) {
          errorResponse(res, 400, "messages array is required and must not be empty");
          return;
        }

        // Extract the last user message as the prompt
        const lastUserMsg = [...request.messages]
          .reverse()
          .find((m) => m.role === "user");

        if (!lastUserMsg) {
          errorResponse(res, 400, "At least one user message is required");
          return;
        }

        const prompt = lastUserMsg.content;
        const chatId = `chatcmpl-${crypto.randomUUID()}`;
        const model = request.model ?? config.llm.model;
        const maxIterations = Math.min(
          request.max_iterations ?? config.maxIterations,
          config.maxIterations,
        );
        const stream = request.stream ?? false;

        if (stream) {
          // ── Streaming SSE ──
          const streamMode = routeRequest(
            request.messages as ChatMessage[],
            request.rlm,
          );

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          const emitChunk = (delta: Record<string, unknown>, finish: string | null = null) => {
            res.write(
              sseChunk({
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta, finish_reason: finish }],
              }),
            );
          };

          // Initial role chunk
          emitChunk({ role: "assistant" });

          const streamHasClientTools =
            (request.tools && request.tools.length > 0) ||
            request.response_format !== undefined;
          const streamChatOptions: ChatOptions = {
            signal: abortController.signal,
            ...(streamHasClientTools
              ? {
                  tools: request.tools,
                  toolChoice: request.tool_choice,
                  responseFormat: request.response_format,
                }
              : {}),
          };
          // If tools/response_format are present, force direct mode
          const resolvedStreamMode = streamHasClientTools ? "direct" : streamMode;

          try {
            if (resolvedStreamMode === "direct") {
              // Stream tokens directly from the model
              let finalResp;
              if (llmClient.chatStream) {
                finalResp = await llmClient.chatStream(
                  request.messages as ChatMessage[],
                  (token) => emitChunk({ content: token }),
                  streamChatOptions,
                );
              } else {
                // Fallback: non-streaming client
                finalResp = await llmClient.chat(
                  request.messages as ChatMessage[],
                  streamChatOptions,
                );
                emitChunk({ content: finalResp.content });
              }

              // If the model made tool calls, emit them as a delta before finishing
              if (finalResp.toolCalls && finalResp.toolCalls.length > 0) {
                emitChunk(
                  { tool_calls: finalResp.toolCalls },
                  "tool_calls",
                );
              } else {
                emitChunk({}, "stop");
              }
            } else {
              // RLM: emit iteration progress as content chunks
              const result = await runRLMLoop({
                prompt,
                llmClient,
                maxIterations,
                sandboxTimeoutMs: config.sandboxTimeoutMs,
                maxSubRLMDepth: config.maxSubRLMDepth,
                onIteration: (iteration, state) => {
                  emitChunk({
                    content: `[iteration ${iteration}: ${state}]\n`,
                  });
                },
              });
              emitChunk({ content: result.answer }, "stop");
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            emitChunk({ content: `Error: ${msg}` }, "stop");
          }

          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // ── Non-streaming ──
        const mode = routeRequest(
          request.messages as ChatMessage[],
          request.rlm,
        );
        debug(
          "server",
          `chat id=${chatId.slice(-8)} mode=${mode} msgs=${request.messages!.length} prompt=${prompt.length}ch tools=${request.tools?.length ?? 0}`,
        );

        // Tools or response_format → always direct mode
        // (RLM loop has its own sandbox tools and free-form output)
        const hasClientTools =
          (request.tools && request.tools.length > 0) ||
          request.response_format !== undefined;
        const effectiveMode = hasClientTools ? "direct" : mode;

        const chatOptions: ChatOptions = {
          signal: abortController.signal,
          ...(hasClientTools
            ? {
                tools: request.tools,
                toolChoice: request.tool_choice,
                responseFormat: request.response_format,
              }
            : {}),
        };

        const reqStart = Date.now();
        // RLM mode can run for minutes; HTTP clients like undici have a
        // bodyTimeout (default 300s) that drops the connection if no bytes
        // arrive. For non-streaming RLM, start sending a whitespace
        // keepalive every 20s — JSON allows leading whitespace, so the
        // final parsed response is unaffected.
        let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
        const startKeepalive = () => {
          if (keepaliveTimer) return;
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          keepaliveTimer = setInterval(() => {
            res.write(" ");
          }, 20_000);
        };
        const stopKeepalive = () => {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = undefined;
          }
        };

        try {
          let answer: string;
          let toolCalls: ChatMessage["tool_calls"] | undefined;
          let finishReason = "stop";

          if (effectiveMode === "direct") {
            const resp = await llmClient.chat(
              request.messages as ChatMessage[],
              chatOptions,
            );
            answer = resp.content;
            toolCalls = resp.toolCalls;
            if (toolCalls && toolCalls.length > 0) {
              finishReason = "tool_calls";
            }
          } else {
            // Open the response and start the keepalive heartbeat
            startKeepalive();
            const result = await runRLMLoop({
              prompt,
              llmClient,
              maxIterations,
              sandboxTimeoutMs: config.sandboxTimeoutMs,
              maxSubRLMDepth: config.maxSubRLMDepth,
            });
            answer = result.answer;
          }

          const message: ChatMessage = {
            role: "assistant",
            content: answer,
          };
          if (toolCalls) {
            message.tool_calls = toolCalls;
          }

          const totalMs = Date.now() - reqStart;
          debug(
            "server",
            `chat completed id=${chatId.slice(-8)} mode=${effectiveMode} ${totalMs}ms answer=${answer.length}ch finish=${finishReason}`,
          );

          const payload = {
            id: chatId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message,
                finish_reason: finishReason,
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          };

          stopKeepalive();
          if (keepaliveTimer === undefined && !res.headersSent) {
            // Happens when direct mode took no keepalive: normal json response
            jsonResponse(res, 200, payload);
          } else {
            // Headers already sent with keepalive; write the final JSON body
            res.write(JSON.stringify(payload));
            res.end();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const totalMs = Date.now() - reqStart;
          debug("server", `chat failed id=${chatId.slice(-8)} ${totalMs}ms error=${msg}`);
          stopKeepalive();
          if (!res.headersSent) {
            errorResponse(res, 500, `RLM loop failed: ${msg}`, "server_error");
          } else {
            // Can't change status; write an error payload body and end
            res.write(
              JSON.stringify({
                error: {
                  message: `RLM loop failed: ${msg}`,
                  type: "server_error",
                  code: "500",
                },
              }),
            );
            res.end();
          }
        }

        return;
      }

      // ── 404 ──
      errorResponse(res, 404, `Not found: ${req.method} ${url}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorResponse(res, 500, msg, "server_error");
    }
  });

  return server;
}

export function startServer(config: ServerConfig): http.Server {
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    console.log(`RLM server listening on http://${config.host}:${config.port}`);
    if (config.llm.modelPath) {
      console.log(`Inference: local (in-process via node-llama-cpp)`);
      console.log(`Model: ${config.llm.modelPath}`);
    } else {
      console.log(`Inference: remote (${config.llm.baseUrl})`);
      console.log(`Model: ${config.llm.model}`);
    }
    console.log(`Max iterations: ${config.maxIterations}`);
    console.log();
    console.log("Endpoints:");
    console.log(`  POST http://${config.host}:${config.port}/v1/chat/completions`);
    console.log(`  GET  http://${config.host}:${config.port}/v1/models`);
    console.log(`  GET  http://${config.host}:${config.port}/health`);
  });

  return server;
}
