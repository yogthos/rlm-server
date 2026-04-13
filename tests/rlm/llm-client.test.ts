import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createLLMClient } from "../../src/rlm/llm-client.js";

// Simple mock HTTP server that simulates Ollama responses.
let server: http.Server;
let port: number;

function createMockServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/api/chat") {
          const data = JSON.parse(body);
          const lastMsg =
            data.messages[data.messages.length - 1]?.content ?? "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              message: { content: `Echo: ${lastMsg}` },
              prompt_eval_count: 10,
              eval_count: 5,
            }),
          );
        } else if (req.url === "/api/tags") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              models: [
                { name: "gemma4:26b" },
                { name: "llama3:8b" },
              ],
            }),
          );
        } else if (req.url === "/api/chat-error") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        } else {
          res.writeHead(404);
          res.end("Not found");
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
  const mock = await createMockServer();
  server = mock.server;
  port = mock.port;
});

afterAll(() => {
  server?.close();
});

describe("createLLMClient (Ollama remote)", () => {
  it("sends chat messages and parses response", async () => {
    const client = createLLMClient({
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "gemma4:26b",
    });

    const response = await client.chat([
      { role: "user", content: "Hello world" },
    ]);

    expect(response.content).toBe("Echo: Hello world");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toBeDefined();
    expect(response.usage!.promptTokens).toBe(10);
    expect(response.usage!.completionTokens).toBe(5);
  });

  it("lists models", async () => {
    const client = createLLMClient({
      provider: "ollama",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "gemma4:26b",
    });

    const models = await client.listModels();
    expect(models).toContain("gemma4:26b");
    expect(models).toContain("llama3:8b");
  });

  it("handles connection errors gracefully in listModels", async () => {
    const client = createLLMClient({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeoutMs: 2000,
    });

    const models = await client.listModels();
    expect(models).toEqual([]);
  });
});
