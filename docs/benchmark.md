# Benchmark: Raw Local Model vs RLM

Comparing direct inference against the same model running through the RLM loop (JS sandbox, Z3, Prolog, tree-sitter graph tools).

Model: Qwen3.6-35B-A3B (Q8_0 GGUF, MoE, 3B active) via `node-llama-cpp`.
Hardware: Apple M1 Max, 64GB unified memory.

## Headline result — unsatisfiable constraint puzzle

Prompt: a logic puzzle about 5 friends / drinks / desserts whose 8 constraints admit **no solution** (Amy can't be assigned any dessert without contradicting clue 1, 2, 5, or 8). The honest answer is to declare UNSAT and prove it.

| Mode | Time | `max_tokens` | `finish_reason` | Result |
|---|---|---|---|---|
| Direct | 89.2s | 6144 | stop | Empty content |
| Direct | 54.2s | 16384 | stop | Empty content |
| **RLM** | **470.4s** | 6144 | stop | **Correct UNSAT + valid proof** |

The RLM proof:
- Cake+coffee must be Cal (Amy excluded by clue 1; Bob by clue 3; Dee by clue 4; Eve by clue 7).
- Tea+cookie has no candidate: Amy excluded by clue 1, Bob by clue 3, Cal now on coffee, Dee has pie, Eve has ice cream.
- Therefore no assignment exists.

Direct mode returned no content in either run — `finish_reason=stop` with zero characters. Qwen's chat template wraps assistant output with `<think>…</think>` then the final answer; on this puzzle the model appears to consume its token budget inside `<think>` and emit `<|im_end|>` without ever producing a user-visible answer. Raising the budget from 6k → 16k didn't help.

This is the cleanest demonstration so far of the RLM loop's value: on a task where the raw model literally cannot produce an answer, the tool-assisted loop arrives at the correct result with a rigorous justification.

## Earlier smoke tests

Two warm-up tasks where both modes reached the same correct answer — worth noting mostly as cost data:

| Task | Direct | RLM |
|---|---|---|
| H(20) = Σ 1/k, k=1..20 as reduced fraction | `55835135/15519504` (58.6s) | `55835135/15519504` (167.7s) |
| IPv4 regex + 10 test strings | regex + all 10 correct (10.4s) | regex + all 10 correct (289.4s) |

RLM is ~3–28× slower on tasks the raw model can already solve. The earlier ungated server runs for these two tasks were against DeepSeek (config misfire); numbers above are rerunnable against the local Qwen but the qualitative outcome — both modes correct — was the same.

## When RLM helps

1. **Unsatisfiability / incompleteness detection.** Raw LLMs pattern-match "logic puzzle" → "produce grid" and fabricate assignments. A tool-using loop can brute-force or encode as SAT/Z3 and report UNSAT honestly.
2. **Precise arithmetic over many steps.** Large-number sums, carries, modular arithmetic. Sandbox computes exactly; the model just drives.
3. **Constraint verification.** Z3 guarantees SAT/UNSAT; the model's reasoning chain does not.
4. **Concise answers from verbose reasoning.** Reasoning-mode models (Qwen3.x, DeepSeek-R1 family) often burn budget in `<think>` blocks and emit empty final content. Offloading computation to tools short-circuits that failure mode.
5. **Code execution and testing.** Regex, FSM traces, algorithm correctness — running the code beats simulating it mentally.

## When RLM doesn't help

Overhead (multiple iterations, sandbox setup, serialized inference queue) adds latency without improving correctness when:

- Algorithm design problems with small search spaces (greedy / DP / graph).
- Code review and bug identification on short snippets.
- Pattern classification and well-structured deduction the model handles in one forward pass.

## Reproducing

Server:

```bash
RLM_MODEL_PATH=models/Qwen3.6-35B-A3B-Q8_0.gguf RLM_PORT=3001 npm start
```

Query (toggle `rlm`):

```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-model","messages":[{"role":"user","content":"..."}],"rlm":true,"max_tokens":6144}'
```
