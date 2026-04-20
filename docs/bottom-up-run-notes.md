# Bottom-up pipeline run notes

Run started: 2026-04-20, against commit `f13f038` (post-bug-review).

## What we're watching for

- [ ] Phase 0-2 (structure) completes cleanly — expect ~3-4 min.
- [ ] Phase 3 (coherence + heal) — does self-heal fire? How many cycles?
- [ ] Phase 4 (leaf-up build) — how many functions per level? Any blocked?
- [ ] Phase 5-7 (paths, integration tests, review) — fast LLM calls.
- [ ] Phase 8 (integration loop) — does the runner fire? Do fixes stick?
- [ ] Does `externalFeedback` fix #1 visibly prevent the pre-test short-circuit?
- [ ] Does the runner timeout fix surface synthetic failures on trouble?
- [ ] Do stack traces resolve to direct attribution (fix #15 structured runner)?
- [ ] Any stagnation-bail fires (fix #13)?

## Observations

### ~281s checkpoint (phase 2 in progress)

- Phase 0 (package.json) + phase 1 (function list, 10 fns) completed. Fn list: startServer, handleRequest, serveHomePage, handleFormSubmission, serveApiEntries, loadEntries, saveEntries, generateHtml, + 2 more TBD.
- Phase 2 at 8/10 specs attached. ~25s per spec. Total phase 2 cost: ~250s.
- No phase 0-2 handoff yet → leaf-up-build not started.
- Deepseek API turnaround is the bottleneck. Each structural LLM call is ~20-30s. 10 fns × 25s = 250s minimum for phase 2.

### Numbers so far
- Functions planned: 10 (same as prior runs — decomposition unchanged).
- Deps per fn: handleFormSubmission=4, handleRequest=3, serveHomePage=2, startServer=1, serveApiEntries=1, loadEntries=0, saveEntries=0, generateHtml=0, parseFormData=0, validateEntry=0.
- L0 cohort (5 leaves): generateHtml, loadEntries, parseFormData, saveEntries, validateEntry.

### ~530s checkpoint (phase 4 leaf-up running)

- ✅ Phase 0-2 done at 340s (right on estimate).
- ✅ Phase 3 coherence: 0 violations. Self-heal skipped (nothing to heal).
- ✅ Phase 4 leaf-up started. Dispatching L0 alphabetically.
- generateHtml: dispatched first (340s), completed ~462s → ~2min.
- loadEntries: green 9/0 on attempt 1, architect REVISE (spec wanted invalid-entry filtering, impl didn't), now attempt 2.

### Key positive signal
- Test runner is FILTERED per function (`filter=^loadEntries\b` in testrun log). Each dispatch runs only that function's tests → fast. Not the full suite.
- Architect review is firing and pushing back on real spec mismatches — not inventing edge cases.

### Open questions
- L0 has 5 leaves. At ~2 min each = ~10 min for L0.
- L1+ may see cascading effects if any leaf stagnates. Watch for #13 stagnation bail vs. productive REVISE cycles.

### ~1370s checkpoint — FOUND A BUG

**LLM default timeout is 120s (`providers/openai.ts:25`).** Complex prompts
to deepseek routinely exceed it:

- generateHtml attempt 1 started 342s, aborted at 462s — exactly 120s.
- saveEntries: same pattern, aborted at 1299s.

Exhaustion log reports `attempts=8` but ACTUAL attempts could be 1 — the
dispatcher's log uses `maxAttempts` as a display constant, not the running
counter. Cosmetic bug but misleading.

**Leaf-up outcomes so far (L0 in progress):**
- generateHtml: EXHAUSTED (abort timeout) at 462s — 1 attempt, ~120s.
- loadEntries: GREEN after 2 attempts at 601s.
- parseFormData: in progress 603s…
- saveEntries: EXHAUSTED (abort timeout) at 1299s, best-attempt body preserved.
- validateEntry: in progress, currently attempt 2 (architect REVISE).

**2/5 L0 leaves exhausted on TIMEOUT, not on stagnation or bad output.**

### Fixes to make after this run
1. **FIX IMMEDIATELY:** bump `RLM_TIMEOUT_MS` env var in `start-deepseek.sh`
   to 600s. Already added to the script — needs server restart.
2. **Exhaustion log reports wrong attempt count** — should say "actual N"
   not `maxAttempts`. One-line fix in `design-dispatch.ts:1310`.
3. **Consider:** when the failure reason is a chat abort (timeout), retry
   the SAME attempt rather than burning the attempt count. The model
   didn't fail to produce — the network transport did.


