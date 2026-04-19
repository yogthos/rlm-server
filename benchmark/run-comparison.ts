/**
 * Benchmark: compare direct mode vs RLM mode on the same server.
 *
 * Both hit the RLM server; the `rlm` request flag toggles between
 * straight-through inference (rlm:false) and the full RLM loop
 * (rlm:true). This avoids loading the model twice.
 *
 * Usage (server must be running; defaults to :3000):
 *   npx tsx benchmark/run-comparison.ts
 *   RLM_PORT=4000 npx tsx benchmark/run-comparison.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

const RLM_PORT = process.env.RLM_PORT ?? "3000";
const RLM_URL = `http://localhost:${RLM_PORT}/v1/chat/completions`;

interface TaskSpec {
  name: string;
  category: "code" | "longdoc" | "computation";
  prompt: string;
  /** If provided, embedded content is loaded from this file */
  attachFile?: string;
}

const TASKS: TaskSpec[] = [
  // ─── Code analysis ───
  {
    name: "Code: most-impacted function",
    category: "code",
    prompt: `Analyze these TypeScript source files and tell me which function, if changed, would have the largest transitive impact (most transitive callers). Files:
/Users/yogthos/src/rlm-sandbox/src/rlm/local-llm.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/loop.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/server.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/handles.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/code-extractor.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/metadata.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/routing.ts

Give: (1) the function name, (2) the number of transitive callers, (3) reasoning.`,
  },
  {
    name: "Code: find dead code",
    category: "code",
    prompt: `Analyze these TypeScript files and find functions defined but never called from within this set (excluding exports):
/Users/yogthos/src/rlm-sandbox/src/rlm/local-llm.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/loop.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/server.ts
/Users/yogthos/src/rlm-sandbox/src/rlm/handles.ts

List the dead functions.`,
  },

  // ─── Long document comprehension ───
  {
    name: "Paper: count benchmarks",
    category: "longdoc",
    prompt: `Here is the results section of an academic paper. How many distinct benchmarks does it evaluate? List each benchmark name with a 1-line description.

---PAPER CONTENT---
{{CONTENT}}`,
    attachFile: "arXiv-2512.24601v2/sections/sec4-results.tex",
  },
  {
    name: "Paper: find exact numbers",
    category: "longdoc",
    prompt: `Here is a paper's results section. What specific accuracy numbers are reported for OOLONG across all methods tested? Give exact values.

---PAPER CONTENT---
{{CONTENT}}`,
    attachFile: "arXiv-2512.24601v2/sections/sec4-results.tex",
  },

  // ─── Computation ───
  {
    name: "Compute: exact factorial",
    category: "computation",
    prompt: `Calculate 30! (30 factorial) as an exact integer. Do not approximate. Show the full integer value.`,
  },
  {
    name: "Compute: verify primality",
    category: "computation",
    prompt: `Is 982451653 prime? If yes, say "prime". If no, give one non-trivial prime factor. Be precise.`,
  },
];

async function query(
  prompt: string,
  rlm: boolean,
  maxTokens = 2048,
): Promise<{ answer: string; timeSec: number; error?: string }> {
  const body = {
    messages: [{ role: "user", content: prompt }],
    rlm,
    max_tokens: maxTokens,
  };

  const start = Date.now();
  try {
    const resp = await fetch(RLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    const data = (await resp.json()) as any;
    const timeSec = (Date.now() - start) / 1000;
    if (data.error) {
      return { answer: "", timeSec, error: data.error.message };
    }
    const answer = data.choices?.[0]?.message?.content ?? "(empty)";
    return { answer, timeSec };
  } catch (e) {
    return {
      answer: "",
      timeSec: (Date.now() - start) / 1000,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function resolvePrompt(task: TaskSpec): string {
  if (!task.attachFile) return task.prompt;
  const content = readFileSync(task.attachFile, "utf-8");
  return task.prompt.replace("{{CONTENT}}", content);
}

async function main() {
  const results: Array<{
    task: string;
    category: string;
    promptChars: number;
    direct: { time: number; answer: string; error?: string };
    rlm: { time: number; answer: string; error?: string };
  }> = [];

  for (const task of TASKS) {
    const resolvedPrompt = resolvePrompt(task);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`Prompt: ${resolvedPrompt.length} chars`);
    console.log("=".repeat(72));

    console.log("\n[direct mode]");
    const direct = await query(resolvedPrompt, false);
    console.log(`Time: ${direct.timeSec.toFixed(1)}s`);
    if (direct.error) console.log(`ERROR: ${direct.error}`);
    console.log(`Answer: ${direct.answer.slice(0, 500)}${direct.answer.length > 500 ? "..." : ""}`);

    console.log("\n[rlm mode]");
    const rlm = await query(resolvedPrompt, true);
    console.log(`Time: ${rlm.timeSec.toFixed(1)}s`);
    if (rlm.error) console.log(`ERROR: ${rlm.error}`);
    console.log(`Answer: ${rlm.answer.slice(0, 500)}${rlm.answer.length > 500 ? "..." : ""}`);

    results.push({
      task: task.name,
      category: task.category,
      promptChars: resolvedPrompt.length,
      direct: { time: direct.timeSec, answer: direct.answer, error: direct.error },
      rlm: { time: rlm.timeSec, answer: rlm.answer, error: rlm.error },
    });
  }

  // ─── Summary ───
  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY");
  console.log("=".repeat(72));
  for (const r of results) {
    console.log(
      `${r.task.padEnd(40)} direct=${r.direct.time.toFixed(1).padStart(5)}s  rlm=${r.rlm.time.toFixed(1).padStart(5)}s`,
    );
  }

  writeFileSync(
    "benchmark/results.json",
    JSON.stringify(results, null, 2),
  );
  console.log("\nFull results saved to benchmark/results.json");
}

main().catch(console.error);
