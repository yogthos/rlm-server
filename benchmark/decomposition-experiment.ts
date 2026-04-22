/**
 * Decomposition-prompt experiment — exercises DeepSeek directly.
 *
 * We observed the architect over-decomposing trivial tasks (e.g.
 * `add(a, b)` → `add + runAddTests`). The phase-1 top-level prompt's
 * "3–7 functions is typical" line biases toward 3. This script tries
 * alternative framings, one task at a time, and tabulates the
 * function counts each variant produces.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... npx tsx benchmark/decomposition-experiment.ts
 *   DEEPSEEK_API_KEY=... npx tsx benchmark/decomposition-experiment.ts --runs 2
 */

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error("DEEPSEEK_API_KEY not set.");
  process.exit(1);
}

const BASE_URL = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat";

const RUNS = Number(process.env.RUNS ?? 1);

interface Task {
  name: string;
  description: string;
  /** Rough LoC estimate for the reference solution — used to sanity-
   *  check whether the model's decomposition count is in the right
   *  ballpark. */
  expectedLoc: number;
  /** Commentary on what a HUMAN programmer would reasonably decompose
   *  this into. Used for scoring / display only — not sent to the model. */
  humanBaseline: string;
}

const TASKS: Task[] = [
  {
    name: "trivial-add",
    description: "Write a TypeScript function `add` that takes two numbers and returns their sum. Include unit tests covering positives, negatives, zero, and mixed signs.",
    expectedLoc: 25,
    humanBaseline: "1 function (add)",
  },
  {
    name: "small-parse-url",
    description: "Write a TypeScript function `parseQueryString(s: string): Record<string, string>` that parses `a=1&b=2` → `{a: \"1\", b: \"2\"}`. Handle: empty string, single pair, multiple pairs, URL-encoded values, duplicate keys (last wins). Include unit tests.",
    expectedLoc: 40,
    humanBaseline: "1 function (parseQueryString), maybe 2 if decodeValue pulled out",
  },
  {
    name: "medium-greet-server",
    description: "Write a minimal Node HTTP server in TypeScript: one GET `/greet?name=X` route that responds with `{\"greeting\": \"Hello, X\"}`. Default `name` to \"world\" when missing. Include integration tests that spin up the server and hit the route.",
    expectedLoc: 100,
    humanBaseline: "2–3 functions (startServer, handleRequest, optional: parseGreetQuery)",
  },
  {
    name: "large-guestbook",
    description: "Build a guestbook web app in TypeScript with these routes: GET `/` returns an HTML page showing a form + all entries; POST `/sign` accepts form-encoded `{name, message}`, stores the entry, redirects to `/`. Persist entries in SQLite via better-sqlite3. Include integration tests that spin up the server and exercise both routes.",
    expectedLoc: 250,
    humanBaseline: "4–6 functions (startServer, handleRequest, renderIndex, parseFormBody, addEntry, listEntries)",
  },
];

interface PromptVariant {
  id: string;
  label: string;
  prompt: (task: string) => string;
}

const VARIANTS: PromptVariant[] = [
  {
    id: "A-baseline",
    label: "current prompt (baseline)",
    prompt: (task) =>
      [
        "Your job is to list the top-level functions needed to complete this task:",
        "",
        task,
        "",
        "These are the roots of the project's call tree. Each becomes its own",
        "TypeScript file; an Architect at dispatch time may later decompose any of",
        "them into children if too complex.",
        "",
        "Start with the FEWEST functions that cover the task. Reach for a new",
        "function only when the task implies a meaningfully different concern",
        "(different HTTP route, different data lifecycle, different storage",
        "layer). 3–7 top-level functions is typical for a small app; 8+ is a",
        "smell — most of those are likely helpers that belong inside a function",
        "body, not roots. The Architect can split later if any individual",
        "function turns out to be too large; it can't easily unify scattered",
        "trivia after the fact.",
        "",
        "Return ONLY a fenced JSON block. The value must be an array of objects",
        "with these exact fields:",
        "  - module: string (file path, e.g. `src/server.js`)",
        "  - name: string (function name, camelCase, globally unique)",
        "  - signature: { params: [{name, type}], returnType, isAsync? }",
        "  - description: string",
        "",
        "No prose outside the JSON block.",
      ].join("\n"),
  },
  {
    id: "B-triviality-first",
    label: "triviality gate up front",
    prompt: (task) =>
      [
        "Your job is to list the top-level functions needed to complete this task:",
        "",
        task,
        "",
        "TRIVIALITY CHECK — answer this BEFORE planning:",
        "If the whole task is a single computation or transformation (e.g.",
        "\"add two numbers\", \"parse a string into an object\", \"return a constant\"),",
        "return exactly ONE function. Don't split a one-liner into ceremony.",
        "Don't invent helpers the task doesn't ask for.",
        "",
        "If the task has distinct concerns (multiple HTTP routes, storage +",
        "rendering, setup + handler + teardown), then decompose by concern.",
        "Typical counts:",
        "  - 1 function: single computation / single pure transformation.",
        "  - 2–3 functions: one workflow with a handler + helper, or one HTTP",
        "    route with its response shaper.",
        "  - 4–6 functions: a small app (multiple routes, storage, rendering).",
        "Do NOT add a function whose job is \"run the tests\" — the test framework",
        "does that. Do NOT add a function whose job is \"call another function\".",
        "",
        "Return ONLY a fenced JSON block with objects: {module, name, signature,",
        "description}. signature = {params: [{name, type}], returnType, isAsync?}.",
        "No prose outside the JSON block.",
      ].join("\n"),
  },
  {
    id: "C-concern-counting",
    label: "count concerns first",
    prompt: (task) =>
      [
        "Your job is to list the top-level functions needed to complete this task:",
        "",
        task,
        "",
        "First, silently enumerate the DISTINCT CONCERNS this task involves.",
        "A concern is a meaningfully different responsibility, each ~20–60 lines",
        "of code. Examples:",
        "  - \"parse X\" is a concern.",
        "  - \"HTTP listen + route\" is a concern (the two belong together).",
        "  - \"render HTML page\" is a concern.",
        "  - \"persist entry in DB\" is a concern.",
        "  - \"test that X works\" is NOT a concern — the test framework handles it.",
        "  - \"validate input\" is NOT its own concern unless the validation is substantial.",
        "Your function count = the number of distinct concerns you identified.",
        "Be stingy: most small tasks have 1–3 concerns.",
        "",
        "Return ONLY a fenced JSON block with objects: {module, name, signature,",
        "description}. signature = {params: [{name, type}], returnType, isAsync?}.",
        "No prose outside the JSON block.",
      ].join("\n"),
  },
  {
    id: "D-natural-dev",
    label: "natural-dev judgment",
    prompt: (task) =>
      [
        "Your job is to list the top-level functions needed to complete this task:",
        "",
        task,
        "",
        "Think like the programmer on the other end. Would you REALLY split this",
        "task into multiple TypeScript files on your own? Concrete anchors:",
        "",
        "  \"add two numbers\"            → 1 function. A one-liner doesn't need helpers.",
        "  \"parse a URL query string\"   → 1 function. It's a pure string→object map.",
        "  \"minimal HTTP greet server\"  → 2–3 functions (start, handler, maybe",
        "                                 parse-query as a helper).",
        "  \"guestbook app with SQLite\"  → 4–6 functions (start, handler, render,",
        "                                 parse form, persist, read).",
        "",
        "Do NOT add a function whose purpose is \"run tests\" or \"validate that",
        "the computation works\" — vitest/jest already does that.",
        "Do NOT add a function that wraps another function without doing its",
        "own work — that's indirection for its own sake.",
        "",
        "Return ONLY a fenced JSON block with objects: {module, name, signature,",
        "description}. signature = {params: [{name, type}], returnType, isAsync?}.",
        "No prose outside the JSON block.",
      ].join("\n"),
  },
  {
    id: "E-triviality-ladder-forbidden",
    label: "B+D combined, explicit forbidden names",
    prompt: (task) =>
      [
        "Your job is to list the top-level functions needed to complete this task:",
        "",
        task,
        "",
        "STEP 1 — triviality gate. If the whole task is a single computation or",
        "pure transformation (\"add two numbers\", \"parse a URL query string\",",
        "\"format a date\"), STOP: return exactly ONE function. Skip the rest.",
        "",
        "STEP 2 — for non-trivial tasks, size-bound with these anchors:",
        "",
        "  trivial (pure computation)   → 1 function.",
        "  single workflow (1 route)    → 2–3 functions (entry + one helper).",
        "  small app (2–3 routes + IO)  → 4–6 functions.",
        "  larger                       → decompose by concern, max ~8.",
        "",
        "FORBIDDEN — do NOT include any of these as top-level functions:",
        "  - anything whose name starts with `run`, `test`, `validate`, `verify`,",
        "    `check`, `demo`, or `main`. These are either test-framework concerns",
        "    (already handled by vitest/jest) or scripts we don't need.",
        "  - any function whose description is \"run the tests\", \"entry point\",",
        "    or \"validate the computation\".",
        "  - any function that only forwards its arguments to another function.",
        "",
        "If the task says \"include unit tests\", DO NOT create a function for",
        "those tests. The Implementer emits test files in a later phase —",
        "planning a `run…Tests` function adds noise that downstream phases have",
        "to strip.",
        "",
        "Return ONLY a fenced JSON block with objects: {module, name, signature,",
        "description}. signature = {params: [{name, type}], returnType, isAsync?}.",
        "No prose outside the JSON block.",
      ].join("\n"),
  },
];

interface Result {
  taskName: string;
  variantId: string;
  run: number;
  ok: boolean;
  functionCount: number;
  functionNames: string[];
  error?: string;
  durationMs: number;
}

async function callDeepSeek(prompt: string): Promise<{ content: string; ms: number }> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, ms: Date.now() - start };
}

function extractFunctionList(response: string): Array<{ name: string }> {
  // Find the first JSON-array fence.
  const m =
    response.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/) ??
    response.match(/(\[[\s\S]*\])/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object" && typeof x.name === "string")
      .map((x) => ({ name: x.name }));
  } catch {
    return [];
  }
}

async function runOne(
  task: Task,
  variant: PromptVariant,
  run: number,
): Promise<Result> {
  const prompt = variant.prompt(task.description);
  try {
    const { content, ms } = await callDeepSeek(prompt);
    const fns = extractFunctionList(content);
    return {
      taskName: task.name,
      variantId: variant.id,
      run,
      ok: fns.length > 0,
      functionCount: fns.length,
      functionNames: fns.map((f) => f.name),
      durationMs: ms,
    };
  } catch (e) {
    return {
      taskName: task.name,
      variantId: variant.id,
      run,
      ok: false,
      functionCount: 0,
      functionNames: [],
      error: e instanceof Error ? e.message : String(e),
      durationMs: 0,
    };
  }
}

function fmtRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join(" │ ");
}

async function main(): Promise<void> {
  const results: Result[] = [];
  for (const task of TASKS) {
    console.log(`\n▶ ${task.name}  (human baseline: ${task.humanBaseline})`);
    for (const v of VARIANTS) {
      for (let i = 0; i < RUNS; i++) {
        process.stdout.write(`  ${v.id} run ${i + 1}/${RUNS} … `);
        const r = await runOne(task, v, i);
        results.push(r);
        if (r.error) {
          console.log(`ERROR: ${r.error}`);
        } else {
          console.log(
            `${r.functionCount} fn — [${r.functionNames.join(", ")}]  (${(r.durationMs / 1000).toFixed(1)}s)`,
          );
        }
      }
    }
  }

  // Summary table.
  console.log("\n\n=== SUMMARY ===\n");
  const widths = [22, 22, 10, 50];
  console.log(
    fmtRow(["task", "variant", "count", "names"], widths),
  );
  console.log("─".repeat(widths.reduce((a, b) => a + b + 3, 0)));
  for (const task of TASKS) {
    for (const v of VARIANTS) {
      const runs = results.filter(
        (r) => r.taskName === task.name && r.variantId === v.id,
      );
      if (runs.length === 0) continue;
      const avg =
        runs.reduce((a, b) => a + b.functionCount, 0) / runs.length;
      const allNames = runs.flatMap((r) => r.functionNames);
      const unique = Array.from(new Set(allNames));
      console.log(
        fmtRow(
          [
            task.name,
            v.id,
            avg.toFixed(1),
            unique.slice(0, 6).join(", ") + (unique.length > 6 ? ", …" : ""),
          ],
          widths,
        ),
      );
    }
    console.log("─".repeat(widths.reduce((a, b) => a + b + 3, 0)));
  }
  console.log(`\nRaw results: ${results.length} (${RUNS} runs per cell)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
