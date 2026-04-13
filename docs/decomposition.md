# Decomposition Findings: Q8 + RLM on Code Analysis

How well does a small local model use the recursive RLM mechanism for non-trivial code analysis tasks? We tested with Gemma 4 26B-A4B (Q8_0) on Apple M1 Max.

## The Test Task

Given 7 TypeScript files, return the top 5 functions ranked by transitive callers (impact).

Ground truth (verified via tree-sitter call graph):
1. `get` — 18 callers
2. `resolve` — 12 callers
3. `enqueue` — 7 callers
4. `chat` — 5 callers
5. `set` — 3 callers

This task is hard for a single LLM pass: it requires iterating over many functions and ranking them. The RLM pattern's promise is that the model decomposes — root plans, sub-RLMs each compute one function's impact, root aggregates.

## Findings

### Without infrastructure scaffolding: model fails

Initial attempts had the model:
- Stay at the root level, accumulating handles and history linearly
- Generate progressively longer responses (up to 24KB code blocks)
- Make ReferenceErrors then loop on the same broken approach
- Produce garbled tautologies as "answers"
- Sometimes never terminate (server stuck for hours)

### With scaffolding: model can succeed, but inconsistently

After implementing infrastructure based on small-LLM decomposition research (ReWOO, Skeleton-of-Thought, Plan-and-Solve), we ran the same task three times. Same model, same prompt:

| Run | Sub-RLMs | Time | Answer |
|---|---|---|---|
| 1 | 18 | 891s | **All 5 exactly correct** ✅ |
| 2 | 5 | (curl gave up) | Correct via partial result |
| 3 | 3 | 220s | Filename guesses, wrong |

**Stochastic behavior dominates.** The model sometimes follows the plan-first directive enthusiastically (run 1), sometimes does minimal decomposition (run 3). Same code, same prompt.

This matches the RLM paper's own observation that Qwen3-8B requires fine-tuning to be reliable — pure prompting hits a capability ceiling for sub-30B models.

## Infrastructure Built (all confirmed working)

| Component | What it does |
|---|---|
| **Plan-first directive** | Detects "complex" tasks (file paths, "top N", "rank", code keywords) and injects planning instruction in first user message |
| **Decomposition nudge** | Fires at iter 3+ on errors OR iter 5+ on bloat (>20KB) if no sub-RLMs spawned |
| **FINAL gating** | Rejects premature `FINAL()` on tasks marked `requiresPlan` if 0 sub-RLMs dispatched |
| **History compaction** | LLM-summarizes middle turns when history exceeds 20 messages or 48KB |
| **AbortSignal propagation** | Sub-RLMs receive parent's signal — abort cascades through entire tree |
| **Internal abort on completion** | Each `runRLMLoop` aborts its own signal in `finally` — kills orphan unawaited work |
| **Repeated-response detector** | Force-terminate if model produces same 200-char prefix twice in a row |
| **Total no-code limit** | Force-terminate after 6 cumulative no-code iterations |
| **Tree logging** | `DEBUG=tree` shows ROOT iter sizes, SPAWN/RETURN events, dispatched/completed counts per context |

## Bug Fixes Along the Way

Real bugs found by the tracing infrastructure:

1. **Premature abort** — `req.on('close')` fires when the request body finishes streaming, not on disconnect. Every request was aborting at start. Fixed by listening only to `res.on('close')` + checking `writableEnded`.

2. **Orphan sub-RLMs** — model wrote `batch_llm_query()` without await. Root returned, sub-RLMs kept running for hours. Fixed by:
   - Each `runRLMLoop` creates internal AbortController
   - Always aborts in `finally` block
   - Signal propagates to all spawned sub-RLMs via `ctx.signal`

3. **Degenerate response loop** — model stuck producing identical 11269-char responses for 6+ iterations. None of the existing safeguards caught it (no errors, no missing code per-streak). Fixed with response-fingerprint detection and total no-code counter.

4. **Compaction overhead** — original threshold (10 msgs / 24KB) fired every 3-5 iterations, costing 7-30s per compaction. Raised to 20 msgs / 48KB.

5. **`max_tokens=8192` runaway** — model generated 24KB single code blocks in 3 minutes. Lowered default to 2048.

## What's the Verdict?

**The infrastructure is correct.** All the failure modes we encountered are now bounded and recoverable. Tests pass (238 across 20 files).

**The model is the bottleneck.** Q8 quantization of a 26B model with MoE active (4B effective) is right at the edge for reliable multi-step tool orchestration. We see capability spikes (run 1) and capability drops (run 3) on identical inputs.

For production reliability with this kind of recursive decomposition, options are:
- **Bigger / less-quantized model** locally
- **Remote provider** (DeepSeek, Claude, GPT-4) for the root model — these handle decomposition more consistently
- **Fine-tuning** a planner role (the RLM paper's recipe) — requires training infrastructure
