/**
 * Shared decomposition rules — injected wherever the model is asked
 * to decide whether/how to split a task into functions.
 *
 * Four decision points reuse these rules:
 *   1. Phase-1 top-level plan (initial split of the user task).
 *   2. Phase-1 parent decomposition (stagnation-triggered child plan).
 *   3. IMPLEMENT-vs-DECOMPOSE gate (pre-dispatch).
 *   4. Reflect step decompose choice (post-stagnation meta decision).
 *
 * Keeping the rules in one place guarantees the model sees the same
 * triviality gate, size-anchor ladder, and forbidden-name list every
 * time it's asked about structure — on the initial pass and on every
 * subsequent split.
 */

/**
 * The full rules block — triviality gate + size anchors + forbidden
 * list + test-planning guardrail. Returns a string array the caller
 * can spread into its own prompt lines.
 */
export function renderDecompositionRules(): string[] {
  return [
    "STEP 1 — triviality gate. If the whole task is a single computation",
    "or pure transformation (\"add two numbers\", \"parse a URL query",
    "string\", \"format a date\"), STOP: propose exactly ONE function.",
    "A one-liner doesn't need ceremony.",
    "",
    "STEP 2 — non-trivial sizing. Use these anchors:",
    "  trivial (pure computation)   → 1 function.",
    "  single workflow (1 route)    → 2–3 functions (entry + one helper).",
    "  small app (2–3 routes + IO)  → 4–6 functions.",
    "  larger                       → decompose by concern, max ~8.",
    "",
    "FORBIDDEN — do NOT propose any function whose name starts with",
    "  `run`, `test`, `validate`, `verify`, `check`, `demo`, or `main`.",
    "These are either test-framework concerns (already handled by the",
    "test runner) or entry-point scripts we don't need. Also forbidden:",
    "any function whose description is \"run the tests\", \"entry point\",",
    "or \"validate the computation\"; any function that only forwards",
    "its arguments to another function.",
    "",
    "If the task mentions tests, DO NOT create a function for those tests.",
    "The Implementer emits test files in a later phase — planning a",
    "`run…Tests` function adds noise that downstream phases have to strip.",
  ];
}

/**
 * Short form — for prompts where the full ladder is too verbose but
 * the forbidden list and triviality bias still matter (e.g. the
 * IMPLEMENT-vs-DECOMPOSE gate answers YES/NO, not a function list).
 */
export function renderDecompositionHints(): string[] {
  return [
    "Triviality bias: if the task is a single computation or pure",
    "transformation, default to IMPLEMENT — one function is enough.",
    "Don't split a one-liner into ceremony.",
    "",
    "Do NOT decompose into children named `run*`, `test*`, `validate*`,",
    "`verify*`, `check*`, `demo*`, or `main` — those are test-framework",
    "concerns or phantom entry points, not real functions.",
  ];
}
