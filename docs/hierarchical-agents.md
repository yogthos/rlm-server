# Hierarchical TDD-Driven Agents — Design Plan

Status: proposal, not yet implemented. Scope intentionally restricted to **TypeScript targets** (the agent produces TS code) so that mechanical enforcement — parse / typecheck / lint / test — is consistent at every level.

## 1. Motivation

Current sandbox: a single uniform RLM loop with sub-RLM spawning (`batch_llm_query`), plan-first gating, and `FINAL()` enforcement. Sub-RLMs inherit the same prompt and toolset. Decomposition is emergent and fragile — small models either refuse to decompose or over-decompose (see `docs/decomposition.md`).

Goal: **get the model to break a coding task into chunks it can reasonably finish, then reassemble them.** Tree-shaped. Each node decides whether its task is small enough to implement directly or needs to split further. Results bubble back up. The dispatcher at each level knows what to do with the child's result because it wrote the contract (tests) the child had to satisfy.

## 2. Sources

- **Sporulator** (`/Users/yogthos/src/mycelium-clj/sporulator`): explicit role specialization (Graph Agent / Cell Agent / Orchestrator), graduated fix prompts (`prompts.clj:110-198`), generic feedback loop (`feedback.clj`), test-contract → lock → implement → verify flow (`orchestrator.clj:637-815`), author-then-audit test review.
- **RLM paper** (arXiv:2512.24601v2): REPL-held state + metadata-only history, `FINAL()` / `FINAL_VAR()` termination, max recursion depth 1 in practice, emergent decomposition from prompting alone (frontier models) or SFT (small models), long-tail 10–100× cost variance as a known failure mode.
- **Current sandbox** (`src/rlm/*`): handle store, pluggable providers, 3-phase decomposition gating (plan-first directive, FINAL gate, error nudges), sub-RLM depth counter (`subRLMDepth`, max 3), AbortSignal cascading.

## 3. Design

### 3.1 Roles (one recursive agent, prompt varies by depth)

Three specialized prompts. Same sandbox and toolset underneath.

| Role | Where | Responsibility | Writes code? |
|---|---|---|---|
| **Architect** | depth 0 only | Produce acceptance tests + high-level decomposition. Author the top-level call graph. | No |
| **Dispatcher** | depth 1..MAX-1 | Decide split vs. implement. If split, author tests for each child. If implement, degrade to Implementer for this turn. | Conditionally |
| **Implementer** | leaves, or forced at MAX_DEPTH | Produce code that passes the tests the parent authored. No sub-dispatch. | Yes |

Role is chosen by depth and by the split-vs-implement decision. Not a separate agent process — just a different system prompt header on the same LLM call.

### 3.2 Envelopes

**Task envelope (flows down):**

```ts
interface TaskEnvelope {
  goal: string;                    // what this node must accomplish
  parentContext: string;           // architectural decisions above this node
  tests: TestContract;             // executable return contract (see 3.3)
  structuralContract?: string;     // extra Prolog rules the artifact must satisfy (see 3.4)
  targetModule: string;            // e.g. "src/guestbook/db.ts"
  targetExports: string[];         // e.g. ["connectDb", "closeDb"]
  depth: number;
  maxDepth: number;
  budgetHint: "minutes" | "hours" | "days";  // soft guidance on task size
  siblingSummaries?: string[];     // short descriptions of sibling tasks (for coherence)
}
```

**Result envelope (flows up):**

```ts
interface ResultEnvelope {
  goal: string;                    // echo, for debugging
  artifact: FileSet;               // Map<path, content>
  testResults: TestReport;         // pass/fail/skip counts + failing test details
  integrationHints: string;        // how parent should stitch with siblings
  status: "complete" | "partial" | "failed";
  subResults?: ResultEnvelope[];   // nested, for tracing
}
```

The `targetModule` / `targetExports` pair is the structural handshake — tests import from `targetModule` referencing `targetExports`, and the Implementer must implement at that path with those exported symbols. Mirrors sporulator's `cell-ns` / `cell-id`.

### 3.3 TDD flow (tests are the return contract)

At every dispatcher turn:

1. Receive `TaskEnvelope` with parent-authored `tests`.
2. Decide split vs. implement.
3. **If split:**
   1. Author integration tests covering the assembled subtree.
   2. Decompose into N subtasks (N ≤ 5).
   3. For each subtask, author unit tests — these become the child's `TaskEnvelope.tests`.
   4. **Self-review tests** (author-then-audit, one pass; port of sporulator's `ALL TESTS VERIFIED` check at `orchestrator.clj:157-170`).
   5. Lock tests. Dispatch children via `batch_llm_query`.
   6. Collect child artifacts, assemble, run integration tests against combined artifacts.
   7. Return `ResultEnvelope` upward.
4. **If implement:**
   1. Tests already arrived with the task.
   2. Write implementation at `targetModule`.
   3. Run full enforcement stack (see 3.4) against tests.
   4. Graduated retry on failure (see 3.5).
   5. Return `ResultEnvelope` upward.

**Test hierarchy by level:**
- Root (Architect): acceptance tests — user-facing behavior over the full system.
- Internal dispatchers: integration tests over combined child artifacts.
- Leaves: unit tests against one module's exported symbols.

**Strict mode (default):** tests are locked once dispatched. Implementer must satisfy them. Future escalation: allow `status: "tests-invalid"` with a reason, one round of renegotiation. Start strict; only loosen if benchmarks show bad-test dead-ends.

### 3.4 Mechanical enforcement stack (TypeScript + Prolog)

Five layers, cheapest first, each gating the next. Ported from sporulator's pipeline (`eval.clj` + `manifest_validate.clj` + test runner) but specialized for TS and extended with a tree-sitter + Prolog structural layer modeled on Chiasmus's `chiasmus_graph` analysis.

| Layer | Tool | Catches | Artifact when it fails |
|---|---|---|---|
| **Parse** | `tree-sitter-typescript` (already a dep) | Syntax errors, malformed literals | Line + caret |
| **Typecheck** | `tsc --noEmit` on a temp tsconfig scoped to the assembled artifact | Type errors, missing imports, bad signatures | TS diagnostics with file/line |
| **Structural** | `tree-sitter-typescript` + `tau-prolog` (both already deps) with canned rule library | Dead code, cyclomatic complexity, nesting depth, import cycles, unused exports, layer violations, custom invariants | Failing Prolog query + offending symbols + source locations |
| **Lint** | `biome check` (zero-config, new dep) or `eslint` | Style, dead imports — **advisory, non-blocking by default** | Lint report |
| **Test** | `vitest run` (already a dep) against the assembled files | Behavior errors, contract violations | Failing test names, expected vs. actual |

Each layer runs in a temp workspace scoped to the current node's artifact. Output is parsed into a structured error object that feeds the next retry prompt.

**Why parse is separate from typecheck:** `tsc` on syntactically malformed code produces cascades of confusing errors. Tree-sitter gives a clean "line X column Y unexpected token" the model can act on directly.

**Lint is non-blocking** because lint failures usually aren't bugs — forcing a retry on an unused-import warning wastes iterations.

#### Structural layer: tree-sitter → Prolog facts → canned queries

Approach mirrors Chiasmus: walk the tree-sitter AST over the current artifact's files, emit a fact base, run a library of canned Prolog rules against it, surface whatever fails.

**Extractor emits facts like:**

```prolog
module("src/guestbook/db.ts").
function(connectDb, "src/guestbook/db.ts", 12).   % name, file, line
exported(connectDb, "src/guestbook/db.ts").
imports("src/guestbook/routes.ts", "src/guestbook/db.ts").
calls(routesHandler, connectDb).
body_lines(connectDb, 14).
cyclomatic(connectDb, 3).
nesting(connectDb, 2).
entry_point(connectDb).       % asserted for exported symbols and test-referenced symbols
```

**Canned rule library (`src/rlm/structural-rules.pl`):**

```prolog
% Reachability
reachable(F) :- entry_point(F).
reachable(F) :- calls(G, F), reachable(G).
dead_code(F) :- function(F, _, _), \+ reachable(F).

% Complexity thresholds (defaults; overridable per-envelope)
complexity_violation(F, C) :- cyclomatic(F, C), C > 10.
length_violation(F, L)     :- body_lines(F, L), L > 100.
nesting_violation(F, D)    :- nesting(F, D), D > 5.

% Structural hygiene
calls_trans(A, B) :- calls(A, B).
calls_trans(A, B) :- calls(A, X), calls_trans(X, B).
call_cycle(F)     :- calls_trans(F, F).

import_trans(A, B) :- imports(A, B).
import_trans(A, B) :- imports(A, X), import_trans(X, B).
import_cycle(M)    :- import_trans(M, M).

unused_export(F)   :- exported(F, _), \+ tested(F), \+ calls(_, F).
```

The enforcement pass runs a fixed set of queries and collects all ground solutions. Each violation produces a retry prompt chunk with location info. Blocking by default: `import_cycle/1`, `call_cycle/1`, `complexity_violation(_, C)` with `C > 15`. Advisory: `dead_code/1`, `length_violation/2`, `nesting_violation/2`, `unused_export/1`.

**Per-envelope structural contracts.** A Dispatcher can attach extra Prolog rules to a child's `structuralContract` to encode architectural constraints:

```prolog
% "The db module may not import from routes"
forbidden :- imports("src/guestbook/db.ts", "src/guestbook/routes.ts").

% "Every exported handler must call validateInput first"
forbidden :- exported(H, "src/guestbook/routes.ts"),
             calls(H, _),
             \+ calls_first(H, validateInput).
```

The enforcement pass appends these to the canned rule set before querying. A non-empty answer to `forbidden.` blocks the child's result. This is the structural analogue of sporulator's `cell-schema` (malli contracts on I/O) — generalized to whole-artifact invariants.

**Reuse what's already there:** the existing `graph()` sandbox builtin already uses tree-sitter for call-graph analysis (see `src/rlm/system-prompt.ts` code-graph section). Extract its analyzer into `src/rlm/structural-facts.ts` and reuse; no new dependency needed.

**Extensibility:** new structural rules = new Prolog clauses in the library. No TypeScript code changes. Canned queries like "top-5 hub functions" or "layer violations for MVC" are just Prolog one-liners (Chiasmus's `communities`, `bridges`, `layer-violation` analyses all map to a handful of rules each).

### 3.5 Graduated retry (direct port of sporulator's three-tier fix prompt)

Matches `prompts.clj:110-198`. Per failing layer:

- **Attempt 1 — Standard:** full context. Cell contract (tests), current impl, error output, specific failing assertion. "Fix and return complete file."
- **Attempt 2 — Narrowed:** only the *first* failing test. Step-by-step trace guidance: "What input does this test provide? What does your code do with it? Where does actual diverge from expected?"
- **Attempt 3 — Fresh:** "Discard your previous approach entirely. Here are the tests. Here is the most recent failure. Design a clean implementation. Pay attention to: types, edge cases, rounding."

Retry budget per leaf: 3 attempts. If all fail, the Implementer returns `status: "failed"` with full trace. Parent dispatcher decides whether to redesign tests, re-split, or propagate failure upward.

### 3.6 Depth and budget control

- **MAX_DEPTH = 3** (matches current sandbox default). At MAX_DEPTH, Dispatcher auto-degrades to Implementer; decomposition is disallowed.
- **Token budget halves per level** (root full, depth 1 halves, depth 2 quarter). Prevents the paper's long-tail 100× cost failure mode.
- **Sibling cap: N ≤ 5 per dispatcher turn.** Paper's Qwen3-Coder spawned thousands of per-line sub-calls; cap prevents this class of failure.
- **Wall-clock budget per node:** configurable; default 10 min per Implementer, 20 min per Dispatcher (including its children). Abort cascades via existing `AbortSignal` propagation.

### 3.7 Split-vs-implement decision prompt — experiment matrix

This is the primary variable to ablate. Five variants, same benchmark suite:

| Variant | Prompt question | Hypothesis |
|---|---|---|
| **V1 Binary** | "Implementable in <200 LOC one block? Yes → implement. No → list 2–5 subtasks." | Simple, works for frontier models, small models over/under-split. |
| **V2 Budget** | "Given budgetHint, can one engineer finish in that window? Yes → implement." | Grounds decision in human-effort metaphor. |
| **V3 Interface-first** | "Write the types/interfaces this task defines. Count distinct responsibilities. >3 → decompose." | Forces structural thinking before code. |
| **V4 Skeleton-ladder** | "Sketch 3–5 steps. If each step is one function, do them all. If each step is a subsystem, decompose." | Mirrors Skeleton-of-Thought. |
| **V5 Test-writability** | "Try to write the tests. If you can write them in under ~30 lines, it's small enough to implement. Otherwise decompose and give each sub-piece its own tests." | Uses the TDD constraint as a size proxy. Expected winner. |

V5 is expected best because test size is a reasonable proxy for scope, and we're authoring tests regardless.

## 4. Implementation sketch

Files to touch or create. Ordered roughly by dependency.

| # | File | Change |
|---|---|---|
| 1 | `src/rlm/envelopes.ts` (new) | Task/Result envelope types; encode/decode to JSON; schema validation. |
| 2 | `src/rlm/roles.ts` (new) | `Role` enum, `buildRolePrompt(role, envelope)` — per-role system prompt header. |
| 3 | `src/rlm/system-prompt.ts:18` | Add `role` param to `buildSystemPrompt()`; compose role header + shared tool body. |
| 4 | `src/rlm/enforcement.ts` (new) | `enforce(files, tests, structuralContract?) → EnforceReport` — runs parse → typecheck → structural → lint → test pipeline in a temp workspace. |
| 5 | `src/rlm/structural-facts.ts` (new) | Tree-sitter AST → Prolog fact stream (`function/3`, `calls/2`, `imports/2`, `cyclomatic/2`, etc.). Extracted from the existing `graph()` builtin. |
| 6 | `src/rlm/structural-rules.pl` (new) | Canned Prolog rule library: reachability, dead code, cycles, complexity thresholds, unused exports. Loaded alongside per-envelope `structuralContract` for each query. |
| 7 | `src/rlm/feedback.ts` (new) | Port of sporulator's `feedback.clj`: generic `feedbackLoop({ extract, validate, errorMsg, maxAttempts })`. Reused by Implementer retry and Dispatcher test-author retry. |
| 8 | `src/rlm/fix-prompts.ts` (new) | Three-tier fix prompt builder (standard / narrowed / fresh). Direct port of `prompts.clj:110-198`. |
| 9 | `src/rlm/loop.ts:58` | Thread `role`, `envelope` through `RLMContext`. Root call = Architect; internal calls = Dispatcher; leaves = Implementer. |
| 10 | `src/rlm/loop.ts:76` | `llmQueryBridge` now takes `TaskEnvelope`; builds child RLM with depth-appropriate role. |
| 11 | `src/rlm/routing.ts:46` | Route root requests to Architect when prompt is a coding task; keep existing single-role path behind a `hierarchical: false` flag. |
| 12 | `src/builtins/llm-bridge.ts` | Expose `dispatch_subtask(envelope)` in sandbox — wraps existing sub-RLM spawn with envelope plumbing. |
| 13 | `bench.ts` | Add tiered coding benchmarks (see §5). |

Dependencies to add: `@biomejs/biome` (optional, lint). `vitest` and `typescript` already present.

Keep it small. Most infrastructure exists — sub-RLM spawning, handle store, `FINAL()` parsing, depth counter, AbortSignal cascading. The new work is:

1. Envelope plumbing (#1, #7, #8, #10).
2. Role-specialized prompts (#2, #3).
3. Mechanical enforcement stack (#4).
4. Reusable feedback loop + fix prompts (#5, #6).

## 5. Benchmark plan

Four tiers. Each task: run across all five decision-prompt variants. Compare decomposition shape to a human-drawn oracle tree.

| Tier | Task | Expected behavior |
|---|---|---|
| **Should-not-decompose** | "Add a `fibonacci(n: number): bigint` export to `src/utils.ts`" | 1 root call. No decomposition. Implementer writes + tests in one pass. |
| **Small (2–3 subtasks)** | "Build a CLI that reads a JSON config and prints one field" | Dispatcher splits into: arg parsing, config loader, printer. |
| **Medium tree** | "Build the guestbook app" (already in `benchmark/guestbook-rlm/`) | Multi-level: routes / db / views / server. |
| **Deep tree** | "Port sporulator's feedback-loop + review-gate to TS" | 3+ levels: envelope design / feedback primitive / review gate primitive / integration. |

Metrics per run:

- Decomposition correctness: did it over/under-split vs. oracle? (Tree-edit-distance to oracle tree.)
- Artifact correctness: do the root-level acceptance tests pass?
- Typecheck clean: does `tsc --noEmit` pass on final artifact?
- Structural health: count of blocking and advisory Prolog-rule violations in final artifact. Per-function max cyclomatic / max nesting. Import-cycle count (target: zero).
- Total tokens (root + all subtrees).
- Wall time.
- Retry count distribution per enforcement layer (where does retry budget get spent?).

## 6. Known risks / failure modes to watch

Drawn from the paper's failure section and sporulator's pain points:

1. **Bad tests lock in bad design.** Parent writes tests that encode a wrong interface; child can't fix it in strict mode. Mitigation: start strict, add one-round escalation only if empirically needed.
2. **Over-verification loops** (paper ex:op_3). Model re-verifies its answer repeatedly, eventually returns the plan instead of the result. Mitigation: hard-cap on verification turns per Dispatcher; tests make the answer unambiguous anyway.
3. **Long-tail cost variance** (paper's 10–100× failure). Sibling cap + per-level budget halving addresses this.
4. **Small models refuse to decompose** (current sandbox finding, `docs/decomposition.md`). Plan-first directive + FINAL gating helps; SFT on trajectories from a larger model is the known fix if prompting isn't enough.
5. **`FINAL()` / `FINAL_VAR()` parse fragility** (paper: 16% of training data had wrong syntax). Consider a structured JSON output format for envelopes instead of in-prose markers.
6. **Test author writes tests against phantom APIs.** Test imports `connectDb` but Implementer exports `initDb`. Mitigation: `targetExports` in envelope is checked by a static "does the implementation export these names" gate before running tests.
7. **Structural rules fire on noise.** Over-strict complexity thresholds cause Implementer to refactor cosmetically instead of fixing real issues. Mitigation: keep defaults generous (cyclomatic ≤ 10, body ≤ 100 lines, nesting ≤ 5), tune down only if benchmark shows under-decomposition. Advisory by default for most structural rules; only cycles and extreme complexity are blocking.
8. **Parent over-constrains via `structuralContract`.** Dispatcher writes a Prolog rule that's unsatisfiable given the task. Mitigation: Dispatcher must run its own contract against a trivial stub before dispatching (sanity check — the contract must not be `forbidden :- true.`).

## 7. Open questions

1. **Architect as separate call or recursive root?** Separate non-recursive planning pass (cleaner, slower) vs. same recursive machinery at depth 0 with role=Architect (simpler, reuses infra). Leaning toward recursive root with Architect prompt.
2. **Envelope serialization across sub-RLM boundary.** Current `batch_llm_query` takes prompt strings. Either (a) stringify envelope to JSON inside the prompt, or (b) extend the sub-RLM bridge to pass structured envelopes. (b) is cleaner, (a) is less invasive.
3. **Lint blocking or advisory?** Default advisory. Revisit if benchmark shows lint-ignorable errors masking real bugs.
4. **Keep single-role path behind a flag?** Yes — needed for A/B comparison on benchmarks. Gate new path behind `hierarchical: true` request param; default off until benchmarks justify the switch.
5. **Test runner choice.** `vitest` is already installed and fast. Default vitest. Could swap to `node --test` if we want zero deps.
6. **Structural thresholds.** Start with cyclomatic ≤ 10, body ≤ 100 lines, nesting ≤ 5 (common industry defaults). Adjust from benchmark data. Question: should Dispatchers be allowed to *relax* thresholds in `structuralContract` (e.g. "this parser is intrinsically branchy — raise the limit to 20")?
7. **Custom rule provenance.** When a parent's `structuralContract` fires against a child, the retry prompt needs to cite the Prolog rule in readable English, not raw Prolog. Need a convention (inline comments? a companion `explanations` map keyed by rule name?) so the child sees "`db.ts` may not import `routes.ts`" rather than a goal trace.

## 8. Suggested experiment sequencing

Three phases. Each phase's exit is gated on the previous phase's benchmark results.

- **Phase A — plumbing.** Files #1–6 and #10–11 from §4. No new behavior yet — the hierarchical path returns the same output as the current single-role path. Validates envelopes round-trip, enforcement stack works, feedback loop is reusable.
- **Phase B — role prompts + decision variants.** Files #2, #3, #7–9. Run the five decision-prompt variants on the four benchmark tiers. Pick the winner.
- **Phase C — tune + harden.** Adjust sibling cap, depth, budget based on Phase B. Add escalation for test renegotiation if strict mode causes dead-ends. Publish results to `docs/hierarchical-agents-results.md`.

## 9. What we're explicitly NOT doing (yet)

- **Other target languages.** TypeScript only. Language-specific enforcement toolchains get expensive to maintain; validate the approach on TS first, generalize later.
- **Training / SFT.** Behavior-elicitation via prompting only. If benchmarks show small models can't decompose with any variant, revisit (paper's recipe: ~1000 filtered trajectories from a larger model, SFT on root turns only).
- **Async sub-call execution.** Paper flags this as a 10× speedup opportunity; current sandbox is sequential. Ship sequential first, parallelize later.
- **Parent-child test renegotiation.** Strict mode only. Add only if benchmarks show bad-test dead-ends.
- **Persistent state across runs** (sporulator-style SQLite store). In-memory envelopes only; add persistence only if we need run replay or debugging support.
