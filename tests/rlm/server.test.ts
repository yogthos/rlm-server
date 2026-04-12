import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createServer } from "../../src/rlm/server.js";
import type { ServerConfig } from "../../src/rlm/types.js";

// We need a mock Ollama server to avoid real LLM calls.
let mockOllama: http.Server;
let mockOllamaPort: number;
let rlmServer: http.Server;
let rlmPort: number;

function createMockOllama(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    let callCount = 0;

    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/api/chat") {
          callCount++;
          // First call: the LLM returns code. Second call: returns FINAL.
          const content =
            callCount === 1
              ? '```repl\nconst x = 1 + 1;\nconsole.log("computed:", x);\n```'
              : "I computed the value.\n\nFINAL(The answer is 2)";

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              message: { content },
              prompt_eval_count: 10,
              eval_count: 20,
            }),
          );
        } else if (req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              models: [{ name: "test-model" }],
            }),
          );
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

function startRLMServer(
  config: ServerConfig,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const s = createServer(config);
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

  const rlm = await startRLMServer(config);
  rlmServer = rlm.server;
  rlmPort = rlm.port;
});

afterAll(() => {
  rlmServer?.close();
  mockOllama?.close();
});

async function fetchRLM(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${rlmPort}${path}`, options);
}

describe("RLM Server", () => {
  it("responds to health check", async () => {
    const resp = await fetchRLM("/health");
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  it("lists models", async () => {
    const resp = await fetchRLM("/v1/models");
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(data.object).toBe("list");
    expect(data.data[0].id).toBe("test-model");
  });

  it("handles chat completions", async () => {
    const resp = await fetchRLM("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "What is 1+1?" }],
      }),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      id: string;
      object: string;
      choices: Array<{
        message: { role: string; content: string };
        finish_reason: string;
      }>;
    };

    expect(data.object).toBe("chat.completion");
    expect(data.id).toMatch(/^chatcmpl-/);
    expect(data.choices[0].message.role).toBe("assistant");
    expect(data.choices[0].message.content).toBeTruthy();
    expect(data.choices[0].finish_reason).toBe("stop");
  });

  it("returns 400 for missing messages", async () => {
    const resp = await fetchRLM("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test" }),
    });

    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: { message: string } };
    expect(data.error.message).toContain("messages");
  });

  it("returns 400 for empty messages", async () => {
    const resp = await fetchRLM("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const resp = await fetchRLM("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(resp.status).toBe(400);
  });

  it("returns 404 for unknown routes", async () => {
    const resp = await fetchRLM("/unknown");
    expect(resp.status).toBe(404);
  });

  it("handles CORS preflight", async () => {
    const resp = await fetchRLM("/v1/chat/completions", {
      method: "OPTIONS",
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
