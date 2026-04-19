# Guestbook Benchmark — Run Log

Tracking how the RLM handles `benchmark/guestbook-sqlite/prompt.txt`
(Build a Node.js guestbook with SQLite, 6 top-level spec items / 13 parsed
sub-items). Each run captures what changed, what worked, what drifted.

## Run 1 — baseline, pre-M1/M2/M3

**Code:** Phase A primitives only, no spec checklist / ledger / failure
memory. Content-type routing bug present.

**Result:** HTTP 200 in 270s. 2897-char `server.js` single-shot.

**Spec coverage:**
- ✅ `better-sqlite3`, exact schema, CREATE TABLE IF NOT EXISTS,
  embedded HTML+CSS, form, newest-first, prepared statements,
  303 redirect after POST
- ❌ `POST /sign` (written as `POST /`)
- ❌ `GET /api/entries` (returned 404)
- ❌ `400` on empty input (silent discard)
- ❌ ISO timestamp (used `toLocaleString()`)
- ❌ HTML-escape user input (XSS)

Five spec misses — classic context-compression drift on a long single-shot
task.

## Run 2 — M1 + M2 + M3 + content-type fix

**Code changes vs Run 1:**
- M1 spec-checklist parser/renderer, FINAL rejection gate, re-injection
  into every `execute` feedback message.
- M2 action ledger appended per transition, last 10 entries re-injected.
- M3 failure memory: normalize error signatures, inject hints on 2nd+
  occurrence.
- `guessContentType` no longer misclassifies "Build X …" as source code.

**Result:** HTTP 200 in **201s** (3.3× faster than the broken prior run).
5 iterations, then FINAL at 3782 chars. Response truncated at line 114
mid-`db.prepare(...)` — `max_output_tokens=2048` ran out.

**Spec coverage for the portion that was emitted:**
- ✅ better-sqlite3, exact schema, CREATE TABLE IF NOT EXISTS
- ✅ `POST /sign` (correct path)
- ✅ `GET /api/entries` (JSON response)
- ✅ `400` on empty handle/message
- ✅ ISO timestamp (`toISOString()`)
- ✅ Embedded HTML+CSS
- ❌ *(nothing missing in intent — truncation cut off the INSERT body,
     303 redirect, 404 handler, `server.listen(3001)` call)*

M1 working directly: at iter 4 the model's own stdout printed a
"Requirement checks: ✅ better-sqlite3 ✅ guestbook.db ✅ POST /sign …"
self-audit that matches our spec. The checklist framing reached the
model even though the REMAINING block itself didn't appear visibly in
the 400-char `io` previews.

**Only gap:** output-token ceiling, not spec misses.

## Run 3 — 4096 tokens, Architect role, generic TS axes

**Code changes vs Run 2:**
- `max_output_tokens` default 2048 → 4096.
- `server.ts`: auto-enable Architect roleBinding when
  `detectCodingTask(prompt)` is true (new `architect-auto.ts` helper,
  gated by optional `hierarchical: boolean` in the request).
- `roles.ts`: Architect prompt rewritten for generic TS decomposition by
  task-type axis (types/contracts, pure logic, I/O boundaries,
  wiring/entrypoint, tests). Adaptive: only the axes this task needs.

**Result (in-progress at time of notes):** 7 iterations at 630s+,
history 34.5KB, handles=5, `spawnStats.dispatched=0`. The model has NOT
called `batch_llm_query` once. Bloat nudge fired at iter 5 (>20KB root)
but the model didn't comply — it kept generating large code blocks as
string variables in the sandbox (`acceptanceTestCode = \`...\``,
`specItems = [...]` self-review, etc.).

**Failure mode: "accumulate, don't dispatch."** The Architect role
prompt says "Dispatch children" but does not name the concrete tool
(`batch_llm_query`) nor the shape of a sub-task prompt. The model's
default behavior without a mechanical forcing function is to keep
expanding the current context rather than hand work off.

**Visible wins:**
- M1 REMAINING SPEC ITEMS appeared in feedback — only `[3] Schema…` was
  open by iter 4; the other 12 items had been pattern-matched against
  the Architect's planning output.
- M2 RECENT ACTIONS ledger visible and carrying the right events.
- Architect prompt was received and followed to the extent of producing
  acceptance tests and a decomposition outline (iter 3 stdout: "Acceptance
  tests and decomposition ready").

**Caveat on M1 aggressiveness:** marking 12/13 items done from the
Architect's PLANNING output — not from actual implementation — risks
rubber-stamping unfinished work. The distinctive-token heuristic fires on
`POST /sign` appearing in a plan, not only in working code. Needs a
follow-up pass that discounts mentions inside comments / quoted strings
that aren't in the produced artifact.

## Open problem after Run 3

The Architect needs a **feedback loop that boxes it into dispatching**,
not just planning. Options under consideration:

1. Shape-of-output gate — Architect cannot return FINAL until
   `spawnStats.dispatched > 0`. Reject FINAL with an instructive nudge.
2. Per-iteration dispatch check — after N iterations without a
   `batch_llm_query` call, inject a concrete code-template nudge that
   shows the exact syntax.
3. Tool-name fix in the Architect prompt — currently says "dispatch
   children"; should say 'call `batch_llm_query([...])` with a list of
   sub-task prompts, each one a self-contained Implementer brief'.
4. Temporary: gate the current `batch_llm_query` bloat nudge so it does
   NOT fire when the Architect prompt is active — avoid the "two nudges
   pulling in different directions" state we saw at iter 5–7.

TBD.
