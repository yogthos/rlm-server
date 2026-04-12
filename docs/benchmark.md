# Benchmark: Raw Gemma 4 vs RLM

Comparing Gemma 4 26B-A4B (Q4_K_M) direct inference against the same model running through the RLM loop with JS sandbox, Z3, and Prolog tools.

Hardware: Apple M1 Max, 64GB unified memory.

## Round 1 — Algorithmic Reasoning

Straightforward algorithmic problems. Both approaches get these right.

| Task | Raw Gemma 4 | RLM |
|---|---|---|
| Primes 1-20 | 2,3,5,7,11,13,17,19 | 2,3,5,7,11,13,17,19 |
| Pythagorean triple (x+y+z=60) | Correct derivation via Euclid's formula, truncated before answer | x=15, y=20, z=25 (via Z3) |
| Transitive management query | Dave, Eve, Frank (2.0s) | Dave, Eve, Frank (via Prolog) |
| Task scheduling (4 tasks, 8hr window) | Correct reasoning, truncated | A:0, B:2, C:0, D:5 (via Z3) |
| Logic puzzle (3 houses) | Correct step-by-step, truncated | House1:Red/Cat, House2:Blue/Fish, House3:Green/Dog (via Z3) |

**Observation**: Raw Gemma 4 reasons correctly but is verbose — often exceeds token limits before reaching the final answer. The RLM approach returns concise, verified answers because the tools do the computation.

## Round 2 — Complex Optimization & Constraints

Harder constraint satisfaction, optimization, and code verification.

| Task | Raw Gemma 4 | Correct? |
|---|---|---|
| Integer linear programming (max 5x+4y) | x=4, y=0, max=20 | Yes |
| SEND+MORE=MONEY cryptarithmetic | S=9,E=5,N=6,D=7,M=1,O=0,R=8,Y=2 | Yes |
| 5-person task assignment (find ALL solutions) | 4 solutions found | Yes |
| Verify LIS code correctness | Correctly identified code as correct, traced dp array | Yes |
| Resource allocation with conflicts | Value=48 (P3,P5,P2,P4,P6) | Yes |

**Observation**: Gemma 4 handles well-structured optimization problems correctly even without tools. The model uses systematic enumeration and value/weight ratio analysis effectively.

## Round 3 — Execution-Dependent Problems

Problems where mental arithmetic fails and execution is needed for verification.

| Task | Raw Gemma 4 | Correct? |
|---|---|---|
| IPv4 regex + test 10 strings | Correct regex, all 10 test results right | Yes |
| Race condition bug identification | Correctly identified TOCTOU bug, balance=-60 | Yes |
| Constraint puzzle (5 friends) | Correctly identified puzzle as impossible | Yes |
| Turnstile FSM trace | Correct implementation and trace | Yes |
| **H(20) exact fraction** | **169505405/46558512 (WRONG)** | **No** |

### The Failure: Harmonic Series H(20)

The task: compute `1/1 + 1/2 + 1/3 + ... + 1/20` as an exact fraction in lowest terms.

Raw Gemma 4's approach was correct:
- Correctly computed LCD = LCM(1..20) = 232,792,560
- Correctly identified all 20 terms as LCD/n
- **Made arithmetic errors summing 20 large numbers** (each 6-9 digits)
- Reported 169505405/46558512 ≈ 3.641

The correct answer is **55835135/15519504 ≈ 3.598**.

## RLM Solves What Raw Inference Cannot

The same problem through the RLM server:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4","messages":[{"role":"user","content":"Compute 1/1+1/2+...+1/20 as exact fraction p/q in lowest terms. Use JavaScript BigInt arithmetic in the REPL."}]}'
```

**Result: `55835135/15519504`** — exactly correct.

The model wrote code to compute it with BigInt rational arithmetic in the sandbox instead of attempting mental arithmetic on large numbers.

| | Raw Gemma 4 | RLM + Sandbox |
|---|---|---|
| Approach | Manual LCD + sum 20 large numbers | BigInt rational arithmetic in JS |
| Answer | 169505405/46558512 | **55835135/15519504** |
| Decimal | 3.641 (wrong) | **3.598 (correct)** |
| Failure mode | Arithmetic errors accumulate | N/A — exact computation |

## When RLM Helps

The RLM approach provides the most value when:

1. **Precise arithmetic over many steps** — LLMs make errors summing large numbers, computing modular arithmetic, or tracking carries across many operations. The sandbox computes exactly.

2. **Constraint verification** — Z3 guarantees SAT/UNSAT rather than hoping the model's reasoning has no gaps. The logic puzzle and scheduling results are *verified*, not just *believed*.

3. **Concise answers from verbose reasoning** — Raw Gemma 4 often generates correct reasoning chains that exceed token limits before reaching the answer. The RLM loop offloads computation to tools and returns only the result.

4. **Code execution and testing** — The model can write code, run it, observe results, and iterate. Regex generation + testing, state machine traces, and algorithm verification all benefit from actual execution.

## When RLM Doesn't Help

For problems where the model's reasoning is already reliable and concise, the RLM overhead (multiple iterations, sandbox setup) adds latency without improving correctness:

- Well-structured algorithm design (greedy, DP, graph algorithms)
- Code review and bug identification
- Logical deduction with small state spaces
- Pattern recognition and classification
