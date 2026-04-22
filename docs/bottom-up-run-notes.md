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

---

## Run 3 (post-fixes, commit `60a2a68`)

### ~647s checkpoint (phase 4 leaf-up running)

- ✅ Phase 0-2 done at 298s (42s faster than run 2 — no spec-phase bottleneck).
- ✅ Phase 3 coherence: 0 violations again.
- ✅ Phase 4 leaf-up started.
- **generateHtml green after 1 attempt at 446s** — previously exhausted on 120s abort timeout.
- parseFormData: dispatched 446s.
- readGuestbookEntries: dispatched 580s, attempt 1 in progress (8 unit tests written, body 1183ch).

### Signals
- `abort-retry` events: 0 — the timeout bump alone is sufficient.
- `exhausted`: 0 — clean so far (was 2 at this point in run 2).
- Each L0 dispatch: ~120-160s. 5 leaves × ~140s ≈ 12 min for L0.

### Fn list differences from run 2
Some function name changes (LLM variance):
- loadEntries → readGuestbookEntries
- saveEntries → writeGuestbookEntries
- handleFormSubmission → handleSignPost
Decomposition structure otherwise identical.

### ~1600s checkpoint — big picture

**L0 leaf-up outcomes (5 leaves):**
- generateHtml: ✅ GREEN at 446s, 1 attempt.
- parseFormData: 🟡 STAGNATION BAIL at 580s (2 identical 8/1 results). Fix #13 working as designed. Best-attempt body preserved.
- readGuestbookEntries: 🟡 architect-rejected after 3 review cycles (8/0 passing but architect kept citing spec nuance).
- validateEntry: 🟡 architect-rejected after 3 review cycles (15/0 passing!).
- writeGuestbookEntries: 🟡 architect-rejected after 3 review cycles (7/0 passing).

**Leaf-up called 9/10 functions blocked.** Only generateHtml survived.
All L1/L2 parents (handleSignPost, serveApiEntries, serveHomePage,
handleRequest, startServer, serveApiEntries) dep-blocked and skipped.

**But the bodies ARE stored in the graph** — each architect-rejected
function has its last-green body preserved via the exhaustion path.
Their unit tests pass. They just failed architect pedantry.

### ARCHITECT PEDANTRY PROBLEM

Architect REVISE cycles fired on GREEN code with complaints like:
- "spec says 'overwrites the entire contents' — your use of path.join is fine but not semantically precise"
- "spec edge cases include 'empty name string' — you check !name.trim() but spec wording is slightly different"
- "you check `name.trim() === ''` but spec says 'empty name string'"

**These are not BUGS.** The functions work. Architect is pattern-matching
on spec wording, not on actual correctness.

### Key structural issue

**Leaf-up treats `status: "failed"` as blocked, even when the body is
stored + passes unit tests.** The dispatcher preserves lastGreenBody
and sets status to "architect-rejected", but leaf-up's gate is
`status !== "tests-green"`. Result: cascading block across the tree
for architect pedantry.

**Fix:** in leaf-up, treat "architect-rejected + implementation != null"
as "good enough to build on." Unit tests pass; the parent can exercise
real children. Architect concerns surface separately but don't block.

### Integration loop (unexpected win)

Despite 9 blocked functions in leaf-up, phases 5-7 ran:
- Phase 5: 7 paths enumerated.
- Phase 6: 4 min authoring tests.
- Phase 7: 2.5 min review; 1 test review-exhausted (architect said test
  has a flaw — vacuous assertion).
- Phase 8 integration loop: started at 1540s. Runner produced 13 failures.
  Attribution → "direct match: parseFormData" (R15 structured runner
  working). Fix-dispatch for parseFormData running at 1599s with
  externalFeedback primed.

### Fixes to make next
1. **Leaf-up: don't block on architect-rejected when body preserved.**
2. **Architect review: relax pedantry.** Suggest: APPROVE when tests pass
   AND the violation is about spec wording rather than a real behavior
   gap. Right now review is effectively requiring LLM consensus that
   the implementation is a PERFECT match for spec wording.
3. **Alternatively:** reduce maxReviewCycles from 3 → 1 for bottom-up
   harden. One reviewer pass per function is enough; 3 gives more
   chances to invent nits than to catch real issues.

---

## Run 4 (post pure-TDD, commit `d658543`)

### ~687s checkpoint (phase 4 leaf-up in progress)

- ✅ Phase 0-2 done at 300s (normal cadence).
- ✅ Phase 4 leaf-up started immediately.
- **generateHtml at attempt 3/8, 687s elapsed (6 min).**
  - attempt 1 @ 300s: 5/3 passing/failing
  - attempt 2 @ 495s: 6/2 (improved by 1)
  - attempt 3 @ 687s: in progress
- **Counts so far:**
  - green after: 0
  - exhausted: 0
  - architect REVISE: **0** ← pure-TDD working, architect silent
  - stagnation bail: 0

### Observations

- Architect is OUT of pass 2 as intended. ✓
- Pure-TDD iteration is progressive (5/3 → 6/2 — model is getting closer).
- But ~3 min per iteration × 8 attempts worst-case = **24 min per function**.
  With 10 functions = ~240 min (4 hours) worst case. Deepseek API is the
  dominant cost.
- Prompt size grew 5850ch → 21279ch after feedback accumulation (body +
  test output fed back in). Normal.

### Remaining risk
- Each leaf-up dispatch can eat 20+ min if iteration is slow. Integration
  phase can't start until leaves finish (or exhaust).
- Consider: parallel dispatch within a level (same-level functions don't
  depend on each other). Would cut L0 wall time 5×.
- Consider: lower maxAttempts for leaf-up (e.g., 4 instead of 8) since
  pure-TDD shouldn't need 8 attempts to converge.

---

## Run 5 (post split-on-stagnation, commit `47855c5`)

### Decomposition recovery FIRED and WORKED

At **678s**, `parseFormData` stagnated (9 passing / 1 failing, same 1 test
failing across attempts 1-2). Decompose-on-stagnation kicked in:

1. Dispatcher returned `status: "stagnated"`.
2. `designLeafUpBuild` cleared the function's failed body + tests.
3. Called `decompose(graph, "parseFormData")` → designPlan with parent.
4. Phase 1 produced **4 children** (768s):
   - `readRequestBody` — collect raw HTTP body
   - `extractFormFields` — split into key=value pairs
   - `decodeFormValues` — URL-decode
   - `parseUrlEncodedData` — orchestrate
5. All 4 children dispatched in leaf-up order, **each went GREEN on 1 attempt**:
   - decodeFormValues: 808s
   - extractFormFields: 838s
   - parseUrlEncodedData: 884s
   - readRequestBody: 933s

The architect's split was semantically meaningful — it factored parseFormData
into clearly-separable sub-steps the Implementer could handle.

### ~933s counts
- green: 6 (generateHtml, loadEntries + 4 parseFormData children)
- stagnation→decomposed: 1 (parseFormData)
- exhausted: 0
- blocked: 0
- saveEntries: in progress

### Remaining
- saveEntries, validateEntry (L0 leaves)
- parseFormData RE-DISPATCH (L1 after its children) — composition step
- handleSignPost, serveApiEntries, serveHomePage (L1)
- handleRequest (L2)
- startServer (L3)
- Integration phase

### ~2117s checkpoint (35 min in)

**parseFormData RE-DISPATCHED as composition at 1179s**:
- Used its 4 children via ctx.fns.
- Went 8/1 on attempt 1.
- Attempt 2 still 8/1 → STAGNATION BAIL #2 at 1268s.
- `decomposedOnce` guard fired → **BLOCKED** (no infinite loop, correct).
- Cascade: handleSignPost, handleRequest, startServer all block.

**serveApiEntries**: green after 1 attempt at 1322s.

**serveHomePage stagnated** at 1437s → decomposed into 5 children (renderGuestbookForm, formatEntryHtml, sendHtmlResponse, renderEntriesList, buildGuestbookPage). All 5 GREEN in 1 attempt each.

**serveHomePage RE-DISPATCHING as composition** starting at 1811s:
- Currently attempt 5/8, **5 body-analyzer rejections in a row**.
- Different failure mode: analyzer catches structural issues (top-level imports, undeclared ctx.fns calls).
- Not stagnation-detected (stagnation is test-based). Will exhaust at 8.
- If exhausted: returns "failed" (not "stagnated") → blocked, no further decompose.

### Key signal
- The `decomposedOnce` guard is PREVENTING the pathological case of
  "split → parent stagnates → split again (no-op) → loop". Works as
  designed.
- But: parseFormData's inability to COMPOSE its children suggests the
  composition step itself may need another TDD-like iteration cycle —
  or a different recovery path (ask architect to revise composition).

### Bodies stored regardless
Even blocked functions (parseFormData, maybe serveHomePage) have bodies
in the graph from stagnation-bail preservation. Integration phase may
still be able to exercise them end-to-end.

---

## Run 6 (post cleanup + auto-repair, commit `4ff6529`)

### ~961s checkpoint (16 min, still in leaf-up)

- green: 2 (addHtmlDoctype, buildEntryItem)
- stagnation events: 3, all decomposed
- blocked / exhausted: 0
- cleanup findings: 0 (hasn't run yet — leaf-up still active)

**Nested decomposition IS happening and leaves ARE converging:**
- generateHtml (depth 0) → stagnated → 5 children at depth 1
- assembleHtmlPage (depth 1) → stagnated → 4 children at depth 2
- buildFormSection (depth 2) → stagnating → decomposing to depth 3 (in progress)

Decomposition depth limit is 4. We have headroom but the recursion is
expensive — each level adds ~5-7 min (stagnation + 2 attempts × 2 min
each, architect decomposition LLM call, then each new child dispatches
at another ~2 min each).

**Observation:** stagnation bails at attempt 2 (identical failing-test
set). This is aggressive but necessary — the model clearly isn't
converging, and burning 8 attempts on the same failure wouldn't help.
The split-on-stagnation recovery turns that wasted time into a
productive restructure.

**Slow but making progress.** Each leaf at depth 3 will likely go
green in 1 attempt because the spec is now simple enough for the
model. If even the depth-3 children stagnate, we hit the depth cap.

### ~1334s checkpoint (22 min)

- green: 4 (addHtmlDoctype, buildEntryItem, buildFormClosingTag, buildFormOpeningTag)
- stagnation → decomposed: 5
- max depth reached: 4 (buildFormElement's children)
- 0 decompose refusals

Depth-4 leaves went green (buildFormClosing/Opening). Confirms
nested decomposition eventually produces tractable leaves.

Decomposition chain so far:
- generateHtml (d0) → assembleHtmlPage (d1) → buildFormSection (d2) →
  buildFormElement (d3) → [buildFormClosingTag ✓, buildFormOpeningTag ✓, ...] (d4)
- assembleHtmlPage (d1) → buildHtmlHead (d2 or d3) → being decomposed

**Cost observation:** ~22 min for 4 greens + 5 decompositions with
mostly depth-3+ work. Heavy recursion is expensive but productive.
Post-run, could revisit whether phase 1 prompt can favor simpler
initial decomposition to reduce the need for stagnation-split cycles.

### ~1637s checkpoint (27 min)

- green: 6 (addHtmlDoctype, buildEntryItem, buildFormClosingTag,
  buildFormOpeningTag, assembleHeadTags, buildEmbeddedStyles)
- stagnation → decomposed: 6
- blocked/exhausted/refused: 0/0/0
- leaf-up still running

Decomposition chain now 4 deep:
  generateHtml → assembleHtmlPage → buildHtmlHead →
  assembleHeadContent → [4 children at depth 4, which is THIS run's
  hardcoded limit]

If any depth-4 function stagnates, decompose would refuse (this run
doesn't have the env-var override yet; next run will have depth 8).

**Post-refactor landed (commit 4dcd4ab):** concurrent dispatch within
a level. Takes effect on next server restart. For a 20-function graph
this should shrink leaf-up from ~30 min to ~8 min at concurrency=4.

---

## Run 7 (concurrency + depth=8, commit `a9e391d`)

### ~387s checkpoint (6.5 min)

- green: 3 (validateEntry, readGuestbookEntries, generateHtml)
- stagnation → decomposed: 1 (parseFormData, in progress)
- depth refusals: 0
- batches observed: 1 (L0 leaves: generateHtml, parseFormData, readGuestbookEntries, validateEntry)

### Concurrency speedup CONFIRMED

Batch of 4 L0 leaves started at 232s. Completion times:
- validateEntry: 258s (+26s)
- readGuestbookEntries: 281s (+49s)
- parseFormData stagnation: 338s (+106s)
- generateHtml green: 361s (+129s, slowest)

**Total batch wall time: ~129s (bound by slowest).**

Compare to run 6 sequential equivalent: each L0 took ~120s, so 5 leaves
= ~10 min serially. Run 7 hit the same milestone in ~2 min. **~4-5×
speedup.**

Only 4 of 5 L0 leaves in the first batch because saveEntries came 5th
alphabetically and maxConcurrent=4. Next batch picks up saveEntries
plus anything newly-ready.

### ~510s checkpoint (8.5 min)

- green: 6 (validateEntry, readGuestbookEntries, generateHtml,
  normalizeFormFields, readRequestBody, decodeUrlEncodedData)
- batches fired: 2
- stagnation → decomposed: 1 (parseFormData)

Batch 2 timing (started ~429s):
- normalizeFormFields @ 464s (+35s)
- readRequestBody @ 473s (+44s)
- decodeUrlEncodedData @ 510s (+81s)
- writeGuestbookEntries: in flight

### Run 6 vs Run 7 at same wall-time

- Run 6 @ ~510s: **2 greens** (first one at 736s!)
- Run 7 @ ~510s: **6 greens**

Concurrency + TMPDIR clean paths producing ~3× actual speedup.

TMPDIR fix working — clean `/tmp/rlm-test-XXX` paths in logs.

### ~930s checkpoint — LEAF-UP COMPLETE, INTEGRATION STARTED

Pipeline state:
- Phase 4 leaf-up: ✅ done
- Phase 4b cleanup: 0 findings (nothing to auto-repair)
- Phase 5 path enumeration: 10 paths
- Phase 6 integration tests authoring: in progress at 930s

Leaf-up outcomes:
- green: 9 (validateEntry, readGuestbookEntries, generateHtml,
  normalizeFormFields, readRequestBody, decodeUrlEncodedData,
  writeGuestbookEntries, serveApiEntries, serveHomePage)
- blocked: 4 (parseFormData + cascading: handleSignPost, startServer,
  handleRequest)
- stagnation events: 2 (parseFormData first → decomposed OK;
  re-dispatch at 930s stagnated again → decomposedOnce guard blocked)

Batch activity:
- 3 batches fired (4 + 4 + 3 concurrent)
- Wall time from phase-4-start to phase-5-start: ~640s (10.7 min)

### Comparison at 930s wall-time

| Metric | Run 6 | Run 7 |
|---|---|---|
| Phase | mid-leaf-up | integration starting |
| Greens | 2 | 9 |
| Wall time to same milestone | still counting | 15.5 min |

**Concurrency + depth=8 + clean tmpdir = real-world pipeline speedup
from ~60+ min/partial → 15 min/full-leaf-up.**

### ~1629s checkpoint — integration phase engaged

Timeline:
- Phase 6 integration tests authoring: 930s → ~1200s (~4.5 min)
- Phase 7 review: ~1200s → 1286s (~1.4 min)
- Phase 8 integration loop:
  - Iteration 1 @ 1286s: 1 failure → attributed → dispatched fix.
  - Iteration 2 @ 1506s: 2 failures.
  - **Mid-loop test augmentation fired at 1516s** (R16): added
    "parseFormData duplicate fields" recurrence witness.
  - parseFormData fix-dispatch: attempt 2, 10/2 passing/failing.

**Multiple feature flags proven in real run:**
- R15 structured runner: attribution working (vitest JSON → failing
  test names → fix target).
- R16 mid-loop test augmentation: fired on recurrent failure.
- R19 external-feedback: fix-dispatch sees integration failure text.

**Not yet green at 1629s** but actively converging. parseFormData
was blocked at leaf-up (stagnated twice); integration loop is now
the truth-teller patching it up with end-to-end context.

### Final verdict — run 7 ended phase=integration (exhausted)

At ~2350s (39 min total), integration loop hit iteration 5/5 without
converging on parseFormData (stuck at 10/2 across 4 consecutive
iterations). Run returned `phase: "integration"` to the sandbox.

Timeline breakdown:
- phase 0-3 (structure + coherence): ~230s (4 min)
- phase 4 leaf-up build: ~700s (12 min) — 9 green, 4 blocked
- phase 5 paths + 6 integration test authoring: ~250s (4 min)
- phase 7 integration test review: ~125s (2 min)
- phase 8 integration loop: 5 iterations × ~220s = ~1100s (18 min)
- **Total**: ~39 min

**Compared to run 5** (pre-concurrency, pre-depth=8, pre-TMPDIR):
- run 5 stopped mid-leaf-up at 47 min with 14 green, 5 blocked.
- run 7 reached end-of-pipeline in 39 min with 9 green, 4 blocked.

### Unresolved: parseFormData edge case

The core issue across runs 5/6/7 is the same function: parseFormData's
handling of duplicate form fields (a specific semantic edge case).
The model:
- Stagnates at 10/1 or 10/2 (handles 10 cases, fails 1-2).
- Decomposition produces 4 children that all go green, but when
  parseFormData re-dispatches as composition, the edge case persists.
- Integration loop's external feedback + test augmentation still can't
  crack it.

**Hypothesis**: the spec/tests for parseFormData's edge case may have
an internal contradiction (similar to the run 3-era test-merge bug
we fixed). Worth inspecting the actual test assertions.

**Signals working as designed:**
- ✅ R15 structured runner: direct attribution.
- ✅ R16 mid-loop augmentation: fired at iteration 2.
- ✅ R18 leaf-up pure-TDD with decompose recovery.
- ✅ R21-R23 stagnation detection + split.
- ✅ Concurrency speedup confirmed (leaf-up 2x faster than run 5/6).
- ✅ No depth refusals (limit now 8).

**The remaining work isn't pipeline bugs — it's spec/test authoring.**
The pipeline did everything it can; the model just can't solve this
specific edge case as currently specified.

---

## parseFormData solo (commit `92a3639`, diagnostic logging)

Isolating parseFormData as a solo task to see if the model can solve
it outside of full-app-scope distractions.

### ~474s checkpoint (8 min)

- Architect split the task into 4 functions in phase 1:
  parseFormData, collectRequestBody, parseUrlEncodedString,
  safeDecodeURIComponent.
- Leaves (collectRequestBody, safeDecodeURIComponent) went green
  in 1 and 3 attempts respectively.
- parseUrlEncodedString stagnated → architect split into 4 more:
  splitKeyValuePairs, extractKeyAndValue, buildResultObject,
  processKeyValuePair.
- Of those: 3 green in 1-2 attempts. processKeyValuePair on attempt
  2 at 9/1 (one failing test: "decodes plus signs as spaces").

### Diagnostic logging validated

New log line now shows the specific failing test:
```
test <key> FAILING: processKeyValuePair decodes plus signs as spaces
  | first: ✗ ... AssertionError: expected { Object (key, value) } to deeply equal { Object (key, value) }
```

vitest's message still collapses object diffs to "{ Object (key, value) }"
— not informative. Full failure message (with stacks) is now in
TestRunResult.fullFailureMessages and surfaceable via the new
`stack-trace` request-info channel if the Implementer asks.

### Signal vs. full-app run

Same function, isolated: converging MUCH faster. Full-app run had
parseFormData blocked across both leaf-up and integration phase.
Solo run has it on track to green (pending depth-1 children).

The full-app stall likely came from spec/test authoring being muddled
by sibling context + 6 edge cases in one spec, not from the function
being inherently hard.

### ~1262s checkpoint — cleanup + auto-repair validated end-to-end

Leaf-up outcomes (7 green / 2 blocked):
- blocked: parseUrlEncodedString, parseFormData
- green: collectRequestBody, safeDecodeURIComponent, extractKeyAndValue,
  buildResultObject, splitKeyValuePairs, processKeyValuePair, plus
  decompose children of parseUrlEncodedString

Cleanup pass found **1 finding** (wasn't zero like prior runs):
```
cleanup: 1 finding(s) — unused-dep:parseUrlEncodedString(safeDecodeURIComponent)
```

Auto-repair **successfully repaired parseUrlEncodedString**:
```
cleanup auto-repair: repaired=[parseUrlEncodedString] failed=[]
```

This is the first run where cleanup + auto-repair delivered a real
unblock. parseUrlEncodedString had stagnated-decomposed-stagnated
during leaf-up; the cleanup-feedback ("spec lists
safeDecodeURIComponent but body doesn't call it") was exactly the
nudge the Implementer needed.

Phase 5 enumerated 5 paths (down from 10-14 in full-app runs —
smaller graph). Phase 6 authored integration tests; phase 7 review
in progress at checkpoint.

Run is still active; solo parseFormData is on track to complete in
a single pipeline pass. Compares favorably to full-app runs where
parseFormData was blocked through to integration-loop exhaustion.

---

## Run 8 — full guestbook with all features (commit `b6c4845`)

Features active:
- RLM_MAX_DECOMPOSE_DEPTH=8
- concurrency 4 (leaf-up)
- TMPDIR=/tmp
- cleanup + auto-repair
- request-info channel (MCP-style)
- project-test-file repair

### ~961s checkpoint (16 min)

- green: **8** (saveEntries, loadEntries, generateHtml, parseFormData,
  validateEntry, serveHomePage, serveApiEntries, handleFormSubmission)
- stagnations: **0** (parseFormData converged on 3rd attempt!)
- batches fired: 4 concurrent leaf-up batches (4, 3, 1, 1)
- request-info rounds: **1** (parseFormData asked spec:parseFormData
  before committing → converged)
- cleanup findings: n/a (leaf-up still running)
- project-test repairs: n/a (not reached integration)

Currently: handleRequest on attempt 5/8 — final L-top function.

### Key validation: parseFormData CONVERGED

In runs 5-7, parseFormData stagnated every time (leaf-up bailed,
sometimes after decomposition). In run 8, parseFormData asked
spec:parseFormData via the new request-info channel, saw its own
full spec with all edge cases, and wrote a passing implementation
in 3 attempts. The MCP-style context-request is paying off.

### Comparison to prior runs

| Metric | Run 6 @ 961s | Run 7 @ 961s | Run 8 @ 961s |
|---|---|---|---|
| Greens | 2 | 9 | 8 (still rising) |
| Stagnations | 6 | 2 | **0** |
| Decompositions | 5 | 2 | 0 |

Run 8 avoided decomposition entirely so far because parseFormData
(the usual stagnation trigger) converged on its own with a
request-info assist.

### ~1623s checkpoint (27 min) — still in leaf-up

- green: **13** (vs run 7's 9 by this point)
- stagnations: **2** (startServer, createServerInstance — both high-level L-top
  functions, both decomposed successfully)
- decompositions: 2, produced 8 new children (4 each)
- request-info rounds: 1 (parseFormData spec:self, same as earlier)
- cleanup findings: n/a (leaf-up ongoing)

Greens (13):
- L0 originals: saveEntries, loadEntries, generateHtml, parseFormData,
  validateEntry, serveHomePage, serveApiEntries, handleFormSubmission
- L-top: handleRequest
- startServer children (from decomp): logServerStart
- createServerInstance children (from decomp): setupServerListeners,
  configureServerTimeout, startListening

Currently: setupErrorHandling (createServerInstance's 4th child) on
attempt 3/8.

### 🎉 Run 8 FINAL verdict — closest to done so far (commit `b6c4845`)

Pipeline ran end-to-end. Phase outcomes:

| Phase | Result |
|---|---|
| 0-2 structure | ✓ |
| 3 coherence + heal | ✓ |
| 4 leaf-up | 18 green, 0 blocked |
| 4b cleanup | 0 findings |
| 5 paths | ✓ |
| 6 integration tests | ✓ |
| 7 review | ✓ |
| 8 integration loop | converged |
| **finalize** | **vitest 140/140 ✓, tsc exit=2 ✗** |

Report: `ok: false, phase: "finalize"`.

**140 tests all passed.** The code WORKS at runtime. TypeScript
rejected it with exit code 2 — type errors in the materialized
project. Possible causes: tests imported with wrong types, bodies
use `any` in ways tsc is strict about, emit format mismatch.

### One step from done

Every pipeline phase succeeded except the final TypeScript check.
No stagnation loops, no blocked functions, no integration-loop
exhaustion. Runtime correctness demonstrated.

### Outer agent behavior after report

Outer RLM agent saw `ok: false, phase: "finalize"`. It re-invoked
designPlan (resume mode; most phases skipped) and tried again.
Subsequent calls hit a "cycle detected" in phase 3 because the
integration-loop had added mutual-dep wiring during fix dispatches.
Agent iterated a few times until context compaction.

### Bottom line

Run 8 validates the **entire pipeline end-to-end** on a 10-function
spec that recursively decomposed to 18 implemented functions.
140 unit + integration tests passing. Only the typecheck gate
blocked the phase=done label. Addressing that is a separate,
smaller problem (prompt hints for stricter typing; or relaxing the
typecheck gate).

---

## Run 9 — tsc-in-integration (commit `90c773a`)

tsc now surfaces errors as IntegrationFailure entries in the
integration loop; type errors get fix-dispatched through the same
channel as test failures.

### ~1553s checkpoint (26 min)

- green: 10 (slightly behind run 8's 13 at this point)
- stagnations: 6 (higher than run 8's 2)
- decompositions: 4 (normalizeFormFields, ensureFileExists,
  getGuestbookFilePath, prepareJsonData each split into 4 children)
- request-info rounds: 1
- still in leaf-up (tsc not yet run)

### Observations

- More stagnation in run 9 than run 8 — LLM variance. Each stagnation
  successfully decomposed; no blocks so far.
- Different functions are stagnating this time (lower-level ones like
  normalizeFormFields) vs run 8's higher-level startServer etc.
- The new tsc signal hasn't fired yet — integration phase hasn't started.
  We'll see how it behaves once the run reaches phase 8.

### ~2450s checkpoint (41 min) — STILL in leaf-up

- green: 19
- stagnations: 8 (4× more than run 8 at same point)
- still in phase 4, no integration/tsc yet
- currently: resolveProjectRootPath attempt 4/8

**LLM variance is the dominant runtime factor.** Run 8 had 2
stagnation-splits (adding ~8 child functions); run 9 has 8 (adding
~32 children). That's 4× the leaf-up work, roughly matching the
wall-time ratio.

No blocks, no depth refusals. Pipeline flowing; just a deeper
decomposition tree this time.

### parseFormData convergence persists

Unlike runs 5-7 where parseFormData was the perpetual blocker, run 8
has it green. The stagnation-then-decomposition pattern that used
to fire on parseFormData is now firing on the HIGHER-LEVEL
functions (startServer, createServerInstance) — which makes sense,
those are the composition layers with more moving parts.

### ~2750s checkpoint — integration phase fixing blocked functions

**Leaf-up ended at 2372s** — 14 green, 5 blocked.
Blocked: parseFormData, handleSignPost, handleRequest, startServer, serveHomePage.

**serveHomePage exhausted** at 8/8 attempts — kept getting body-analyzer rejected
(composition body had structural issues). Distinct from stagnation; no decompose.

**Phase 5-7 worked smoothly:**
- 14 paths enumerated.
- Integration tests authored in ~141s.
- 1 review-exhausted with legitimate feedback (flawed assertion logic).

**Phase 8 integration loop engaged:**
- Iteration 1: 22 failures (expected with 5 blocked functions in chain).
- Attribution → parseFormData (direct stack match — R15 structured runner
  working).
- fix-dispatch on parseFormData: attempt 2 showing **10/1 passing/failing**
  (better than the 8/1 stagnation in leaf-up!). External feedback from
  integration test failures is giving the Implementer enough context to
  converge where pure-TDD stagnated.

### Validation of the full flow
- Pass 1 decompose ✓
- Pass 2 leaf-up with decompose-on-stagnation recovery ✓
- Pass 2 second-stagnation → blocked (decomposedOnce guard) ✓
- Pass 3 integration tests authored, reviewed ✓
- Pass 3 fix loop attributing failures + re-dispatching blocked functions
  with external feedback, making progress past stagnation ✓ (in progress)

The pipeline is working as intended. Integration loop is exactly the "fix
in workflow context" step — pure-TDD stagnation on edge cases gets
resolved once the Implementer sees how the function is actually being
used.

### Validation of the workflow
This is exactly the user's intended flow:
1. Pass 1 decomposes. ✓
2. Pass 2 implements leaf-up (pure TDD). ✓
3. Pass 2 failure triggers MORE decomposition. ✓
4. Children implement, parent re-dispatches as composition. (pending)
5. Integration phase tests end-to-end. (pending)

### ~1874s checkpoint — full picture (server running PRE-revert code)

**L0 outcomes (complete at 1617s / 27 min):**
- generateHtml: STAGNATION BAIL (7/1) after 4 attempts. Bodies preserved.
- loadEntries: STAGNATION BAIL (6/2) after several attempts.
- parseFormData: GREEN (1 attempt) @ 1527s. Fastest.
- saveEntries: GREEN (1 attempt) @ 1590s.
- validateEntry: GREEN (1 attempt) @ 1616s.

Fastest leaf: 1 attempt, 75s. Slowest: 4 attempts stagnation-bail, ~740s.

**L1 outcomes (in progress):**
- handleSignPost: GREEN (1 attempt) despite bail'd loadEntries dep.
- serveApiEntries: GREEN (1 attempt) despite bail'd loadEntries dep.
- serveHomePage: attempt 3/8 at 1874s, test 4/1 (progressing). Deps on
  both generateHtml (bail) and loadEntries (bail).

**Counts: 5 green, 2 stagnation bail, 0 exhausted, 0 architect REVISE.**

### Key finding: pre-revert logic empirically wins

The SERVER is running pre-revert code (started before commit c237ea0).
Empirical result: parents DO proceed on bail'd (partial-pass) children
and produce WORKING assemblies for their own unit tests.

Why it works:
- Bail'd child has body in graph, available via ctx.fns.
- Parent's unit tests stub siblings where necessary (per implementer
  prompt guidance).
- When parent calls real child, happy-path inputs don't trip the
  edge cases the child couldn't handle.
- Integration phase 3 will catch the child's edge cases in full-
  assembly context.

This contradicts the post-revert strict rule. The revert would have
blocked both handleSignPost and serveApiEntries (both depend on the
bail'd loadEntries), halting 2/5 L1 dispatches.

**Decision needed**: un-revert (accept progressive iteration) vs
keep-revert (strict pure-TDD with fewer completions). Current run
will continue with the optimistic pre-revert logic.





## Run 9 — tsc-in-integration + project-test repair (in progress)

First designPlan call: finished at ~3035s with `ok:false, phase:"consistency"`
(24 unhealed coherence warnings from phase 3). Integration phase 8 NOT
reached, so the new tsc-in-integration channel and project-test repair
channel were NOT exercised this run.

Outer agent re-invoked design_plan on the in-memory graph. Hit a NEW bug:

    execution error: duplicate function name: validateEntry —
    already declared in src/server.js; names must be globally unique
    under the proc-ts layout

Phase 1 re-proposes a function list and tries to add names that already
exist in the graph. Not a pipeline crash (runs in the RLM sandbox, so
error is returned as feedback), but the outer agent had to hand-roll a
workaround via `design_query` to figure out what existed.

On re-run, phase 3 consistency check passed (ok=true, 0 violations, 33
advisories) and leaf-up resumed. Still running at 3950s in outer-loop
dispatch. Run will likely time out on 7200s curl before reaching
integration.

**New bug identified (not yet fixed):** phase 1 on re-entry should
either (a) skip functions already in the graph, or (b) be idempotent
on duplicate-add. Making re-invocation non-fatal is higher value than
anything else, since the outer agent will keep re-invoking when phase
3 flags coherence issues.

**Outstanding:** no test run yet has reached phase 8, so tsc integration
remains unvalidated on a real run. Isolated unit tests for
`parseTscErrors`, `isProjectTestFailure`, and `repairProjectTests`
all pass, so the mechanism is at least internally consistent.
