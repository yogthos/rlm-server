# rlm-sandbox

An RLM (Recursive Language Model) system that runs a GGUF model in-process and gives it a JavaScript sandbox with persistent variables, text search, Z3 constraint solving, and Prolog logic programming. Exposes an OpenAI-compatible HTTP API.

Based on the [RLM paper](https://arxiv.org/abs/2512.24601) — improved with a JS sandbox (instead of Python), a descriptive handle system for token savings, and formal reasoning tools.

## Quick Start

```bash
npm install

# Local inference (recommended — model downloads automatically)
RLM_MODEL_PATH="hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M" npm start

# Or point to a local GGUF file
RLM_MODEL_PATH=./models/gemma4.gguf npm start
```

Then query the OpenAI-compatible API:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4","messages":[{"role":"user","content":"Find all primes under 20 and verify with z3"}]}' | jq .choices[0].message.content
```

## Architecture

```
Client (OpenAI format)
  │
  ▼
┌─────────────────────────────────────────────┐
│  RLM Server  (POST /v1/chat/completions)    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  RLM Loop (FSM)                     │    │
│  │                                     │    │
│  │  init → generate → execute → check  │    │
│  │           ▲                  │      │    │
│  │           └──────────────────┘      │    │
│  └──────────┬──────────────────────────┘    │
│             │                               │
│  ┌──────────▼──────────┐  ┌──────────────┐  │
│  │  JS Sandbox (VM)    │  │  llama.cpp   │  │
│  │  • grep, fuzzy      │  │  (in-process │  │
│  │  • z3 (WASM)        │  │   GGUF)      │  │
│  │  • prolog           │  │              │  │
│  │  • llm_query (sub)  │  └──────────────┘  │
│  └─────────────────────┘                    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  Handle Store                       │    │
│  │  $grep_error: Array(1000) [...]     │    │
│  │  $z3_result: Object {status, ...}   │    │
│  │  LLM sees stubs, not full data      │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

The RLM loop iterates: the model generates JavaScript code, the sandbox executes it, results are stored as descriptive handles (stubs only fed back to the model), and the loop continues until the model calls `FINAL(answer)`. This lets the model do arbitrarily complex reasoning across many iterations while keeping its context window small.

## How It Works

1. Client sends a message via the OpenAI chat API
2. The RLM loop loads the message as a `context` variable in a JS sandbox
3. The model writes code in `` ```repl `` blocks to analyze the context
4. Each execution result is stored as a **handle** — the model sees only compact stubs like `$grep_error: Array(1000) ["ERROR: timeout...", ...]` (~97% token savings)
5. The model can use `z3()` for constraint solving, `prolog()` for logic programming, and `llm_query()` for recursive sub-calls
6. When done, the model calls `FINAL(answer)` and the answer is returned to the client

## Tools Available in the Sandbox

| Tool | Description |
|---|---|
| `grep(pattern, flags)` | Regex search with line numbers and capture groups |
| `fuzzy_search(query, limit)` | Bitap fuzzy text matching |
| `locate_line(start, end)` | Extract lines by number |
| `count_tokens(text)` | Token estimation |
| `text_stats()` | Document metadata (length, line count, samples) |
| `llm_query(prompt)` | Recursive sub-RLM call |
| `z3(smtlib)` | Z3 constraint solver (SMT-LIB format, WASM) |
| `prolog(program, goal, opts)` | Tau Prolog logic engine |

## Configuration

All via environment variables:

| Variable | Default | Description |
|---|---|---|
| `RLM_MODEL_PATH` | — | GGUF path or HuggingFace URI (local inference) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Remote LLM endpoint (fallback) |
| `RLM_MODEL` | `gemma4` | Model name for API responses |
| `RLM_PORT` | `3000` | Server port |
| `RLM_MAX_ITERATIONS` | `30` | Max reasoning iterations per request |
| `RLM_TEMPERATURE` | `0.7` | Sampling temperature |
| `RLM_CONTEXT_WINDOW` | `131072` | Context window size (tokens) |
| `RLM_GPU_LAYERS` | auto | GPU layers to offload (-1=all, 0=CPU) |
| `RLM_SANDBOX_TIMEOUT` | `30000` | Sandbox execution timeout (ms) |

## API Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible chat (streaming supported with `"stream": true`)
- `GET /v1/models` — List available models
- `GET /health` — Health check

## Programmatic Usage

```ts
import { runRLMLoop, createLLMClient } from "rlm-sandbox/rlm";

const client = createLLMClient({
  modelPath: "hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
  model: "gemma4",
});

const result = await runRLMLoop({
  prompt: "Analyze this data and find anomalies...",
  llmClient: client,
  maxIterations: 10,
});

console.log(result.answer);
console.log(`Completed in ${result.iterations} iterations`);
```

## License

Apache-2.0
