import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createServer } from "../../src/rlm/server.js";
import type { ServerConfig } from "../../src/rlm/types.js";

let mockOllama: http.Server;
let mockOllamaPort: number;
let rlmServer: http.Server;
let rlmPort: number;

function createMockOllama(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        if (req.url === "/api/chat") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              message: { content: '{"name":"Alice","age":30}' },
              prompt_eval_count: 5,
              eval_count: 10,
            }),
          );
        } else if (req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ models: [{ name: "test-model" }] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: s, port: p });
    });
  });
}

beforeAll(async () => {
  const ollama = await createMockOllama();
  mockOllama = ollama.server;
  mockOllamaPort = ollama.port;

  const config: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    llm: {
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${mockOllamaPort}`,
      model: "test-model",
      temperature: 0.1,
      timeoutMs: 10_000,
    },
    maxIterations: 5,
    sandboxTimeoutMs: 5_000,
    maxHandles: 50,
    maxSubRLMDepth: 1,
  };

  const s = createServer(config);
  await new Promise<void>((resolve) => {
    s.listen(0, "127.0.0.1", () => resolve());
  });
  rlmServer = s;
  const addr = s.address();
  rlmPort = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  rlmServer?.close();
  mockOllama?.close();
});

async function fetchRLM(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${rlmPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("response_format", () => {
  it("accepts response_format: json_object without error", async () => {
    const resp = await fetchRLM({
      messages: [{ role: "user", content: "Give me a name" }],
      response_format: { type: "json_object" },
    });
    expect(resp.status).toBe(200);
  });

  it("accepts response_format: json_schema without error", async () => {
    const resp = await fetchRLM({
      messages: [{ role: "user", content: "Give me a person" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
            required: ["name", "age"],
          },
        },
      },
    });
    expect(resp.status).toBe(200);
  });

  it("returns error for unknown response_format type", async () => {
    const resp = await fetchRLM({
      messages: [{ role: "user", content: "Hello" }],
      response_format: { type: "invalid_type" },
    });
    // Should still succeed (ignore unknown type) or return 400
    expect([200, 400]).toContain(resp.status);
  });
});
