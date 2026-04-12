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
import type { ServerConfig, ChatMessage } from "./types.js";
import { createLLMClient } from "./llm-client.js";
import { runRLMLoop } from "./loop.js";

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
          data: models.map((id) => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "local",
          })),
        });
        return;
      }

      // ── Chat Completions ──
      if (url === "/v1/chat/completions" && req.method === "POST") {
        const body = await readBody(req);
        let request: {
          model?: string;
          messages?: Array<{ role: string; content: string }>;
          stream?: boolean;
          max_iterations?: number;
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
        const maxIterations = request.max_iterations ?? config.maxIterations;
        const stream = request.stream ?? false;

        if (stream) {
          // ── Streaming SSE ──
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          // Initial role chunk
          res.write(
            sseChunk({
              id: chatId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                { index: 0, delta: { role: "assistant" }, finish_reason: null },
              ],
            }),
          );

          try {
            const result = await runRLMLoop({
              prompt,
              llmClient,
              maxIterations,
              sandboxTimeoutMs: config.sandboxTimeoutMs,
              maxSubRLMDepth: config.maxSubRLMDepth,
              onIteration: (iteration, state) => {
                // Emit progress as content chunks
                res.write(
                  sseChunk({
                    id: chatId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: `[iteration ${iteration}: ${state}]\n`,
                        },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
              },
            });

            // Final content chunk
            res.write(
              sseChunk({
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: result.answer },
                    finish_reason: "stop",
                  },
                ],
              }),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.write(
              sseChunk({
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: `Error: ${msg}` },
                    finish_reason: "stop",
                  },
                ],
              }),
            );
          }

          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // ── Non-streaming ──
        try {
          const result = await runRLMLoop({
            prompt,
            llmClient,
            maxIterations,
            sandboxTimeoutMs: config.sandboxTimeoutMs,
            maxSubRLMDepth: config.maxSubRLMDepth,
          });

          jsonResponse(res, 200, {
            id: chatId,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.answer,
                } as ChatMessage,
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errorResponse(res, 500, `RLM loop failed: ${msg}`, "server_error");
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
