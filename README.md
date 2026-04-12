# rlm-sandbox

An OpenAI-compatible LLM server that makes a local GGUF model smarter by giving it tools: a JavaScript sandbox, Z3 constraint solver, Tau Prolog, and tree-sitter code graph analysis. Designed as a drop-in backend for coding tools like opencode, Cursor, or Aider.

Based on the [RLM paper](https://arxiv.org/abs/2512.24601). For tasks that need tool support (computation, constraint solving, large context analysis), the server runs a recursive loop that lets the model iterate through a sandbox. For routine queries it passes straight through to the model with no overhead.

## Quick Start

```bash
npm install

# Local inference — model downloads from HuggingFace automatically on first run
RLM_MODEL_PATH="hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q8_0" npm start

# Or point to an already-downloaded GGUF file
RLM_MODEL_PATH=./models/gemma-4-q8.gguf npm start
```

Query as OpenAI:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Tools:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Read /etc/hosts"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "parameters": {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}
      }
    }]
  }'
# → {"choices":[{"message":{"tool_calls":[{"id":"call_...","function":{"name":"read_file","arguments":"{\"path\":\"/etc/hosts\"}"}}]}, "finish_reason":"tool_calls"}]}
```

## Architecture

```
   ┌──────────────────┐
   │  opencode / IDE  │       OpenAI-compatible API
   └────────┬─────────┘
            │ /v1/chat/completions
            ▼
   ┌──────────────────────────────────────────────┐
   │                  Router                      │
   │  short prompt, no tool keywords → direct     │
   │  verify/z3/prolog/graph, large ctx → RLM     │
   └───┬─────────────────────────────┬────────────┘
       │                             │
    direct                         RLM loop (FSM)
       │                             │
       │                             ▼
       │                   ┌─────────────────────┐
       │                   │  init → generate    │
       │                   │  ↑         ↓        │
       │                   │  check ← execute    │
       │                   └──────┬──────────────┘
       │                          │
       │                          ▼
       │          ┌─────────────────────────────────┐
       │          │  JS Sandbox (VM)                │
       │          │  • grep, fuzzy_search, stats    │
       │          │  • z3 (WASM)                    │
       │          │  • prolog (Tau Prolog)          │
       │          │  • graph (tree-sitter, O(V+E))  │
       │          │  • llm_query (recursive)        │
       │          └─────────────────────────────────┘
       │                          │
       ▼                          ▼
   ┌────────────────────────────────────────────┐
   │  llama.cpp (in-process GGUF)               │
   │  - single persistent context               │
   │  - KV cache reuse across iterations        │
   │  - request queue serializes access         │
   └────────────────────────────────────────────┘
```

## Dual Routing

Not every request benefits from the RLM loop. The router decides per-request:

- **Direct mode**: short instruction prompts go straight to the model with token-level streaming. No overhead.
- **RLM mode**: prompts with tool keywords (`verify`, `z3`, `prolog`, `call graph`, `impact`, etc.) or large attached context (> 2KB) run through the full loop where the model writes code, executes it, and iterates.

Override via the `rlm` request parameter: `"rlm": true` forces RLM, `"rlm": false` forces direct.

Requests with `tools` or `response_format` are always direct (the client is handling tool calling itself).

## RLM Loop Tools

When the loop activates, the model has access to these tools inside the sandbox:

| Tool | Use for |
|---|---|
| `grep(pattern, flags)` | Regex search with line numbers and capture groups |
| `fuzzy_search(query, limit)` | Fuzzy text matching |
| `locate_line(start, end)` | Extract lines by number |
| `count_tokens(text)` | Token estimation |
| `text_stats()` | Context metadata |
| `z3(smtlib, opts)` | Z3 constraint solver (WASM) |
| `prolog(program, goal, opts)` | Tau Prolog logic engine |
| `graph(files, analysis, opts)` | Tree-sitter code analysis: callers, callees, cycles, dead-code, impact, reachability, path |
| `llm_query(prompt)` | Recursive sub-RLM call |

Execution results are stored server-side as **handles**. The model sees stubs like `$grep_error: Array(1000) ["ERROR: timeout...", ...]` instead of full data (~97% token savings).

The model finishes with `FINAL(answer)` or `FINAL_VAR(variableName)`.

## API

OpenAI-compatible surface. Tested with opencode. The server accepts all standard OpenAI fields plus a few extensions:

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | Chat completion (non-streaming + SSE streaming) |
| `GET /v1/models` | List available models |
| `GET /v1/models/{id}` | Retrieve a specific model |
| `GET /health` | Health check |

Supported request fields:
- `messages` — OpenAI chat messages (supports `role: "tool"` for function results)
- `stream` — SSE streaming with OpenAI `chat.completion.chunk` deltas
- `tools`, `tool_choice` — function calling
- `response_format` — `{"type": "json_object"}` or `{"type": "json_schema", "json_schema": {"schema": ...}}`
- `temperature`, `max_tokens`, `top_p`
- `rlm` — extension flag for explicit direct/RLM routing
- `max_iterations` — extension (clamped to server ceiling)

Tool calling returns OpenAI-format `tool_calls` with `finish_reason: "tool_calls"`.

## Configuration

All via environment variables:

| Variable | Default | Description |
|---|---|---|
| `RLM_MODEL_PATH` | — | GGUF path or HuggingFace URI (local inference) |
| `OLLAMA_BASE_URL` | — | Remote LLM endpoint (fallback if no local model path) |
| `RLM_MODEL` | `gemma4` | Model name reported to clients |
| `RLM_PORT` | `3000` | Server port |
| `RLM_HOST` | `0.0.0.0` | Bind host |
| `RLM_MAX_ITERATIONS` | `30` | Max RLM iterations per request |
| `RLM_TEMPERATURE` | `0.7` | Default sampling temperature |
| `RLM_MAX_TOKENS` | `4096` | Default max generation tokens |
| `RLM_CONTEXT_WINDOW` | `131072` | Context window size (tokens) |
| `RLM_GPU_LAYERS` | auto | GPU layers to offload (-1=all, 0=CPU) |
| `RLM_SANDBOX_TIMEOUT` | `30000` | Sandbox execution timeout (ms) |
| `RLM_MAX_HANDLES` | `200` | Max handles before LRU eviction |
| `RLM_MAX_SUB_DEPTH` | `3` | Max sub-RLM recursion depth |

## Programmatic Usage

```ts
import { runRLMLoop, createLLMClient } from "rlm-sandbox/rlm";

const client = createLLMClient({
  modelPath: "hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q8_0",
  model: "gemma4",
});

const result = await runRLMLoop({
  prompt: "Analyze these 100k log lines and find anomalies...",
  llmClient: client,
  maxIterations: 10,
});

console.log(result.answer);
console.log(`Completed in ${result.iterations} iterations`);
```

## Paper

Implements and extends the RLM paradigm:

> **Scaling Inference-Time Search with Recursive Language Models**
> Sehoon Kim, Shobhit Gupta, Amir Gholami, Kurt Keutzer
> [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)

Key differences from the paper:
- JavaScript sandbox instead of Python REPL
- Descriptive handle system for ~97% token savings (from [Matryoshka](https://github.com/yogthos/Matryoshka))
- Z3 constraint solver and Tau Prolog as sandbox tools (from [Chiasmus](https://github.com/yogthos/chiasmus))
- Tree-sitter code graph analysis with O(V+E) native algorithms
- In-process GGUF inference via node-llama-cpp (no separate inference server)
- Dual routing so simple queries don't pay RLM overhead
- OpenAI-compatible API with full tool calling + structured output

See [docs/benchmark.md](docs/benchmark.md) for comparison results.

## License

Apache-2.0
