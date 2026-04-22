/**
 * Scenario harness — drives minimal RLM scenarios against a running
 * RLM server and reports pass/fail + duration per scenario.
 *
 * Each scenario is a directory under `benchmark/scenarios/<name>/`
 * with `prompt.txt` + `meta.json`. The harness posts prompt.txt to
 * the RLM server's /v1/chat/completions endpoint with `rlm:true`
 * (full pipeline) and captures the response.
 *
 * Usage:
 *   npx tsx benchmark/scenarios/run-scenarios.ts           # all
 *   npx tsx benchmark/scenarios/run-scenarios.ts add-two   # one
 *   RLM_PORT=4000 npx tsx benchmark/scenarios/run-scenarios.ts
 *
 * Response bodies are written to `benchmark/scenarios/<name>/last-response.md`
 * for post-mortem review.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RLM_PORT = process.env.RLM_PORT ?? "3000";
const RLM_URL = `http://localhost:${RLM_PORT}/v1/chat/completions`;
const SCENARIO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = Number(process.env.RLM_SCENARIO_TIMEOUT_MS ?? 1_800_000);

interface ScenarioMeta {
  name: string;
  description?: string;
  stage?: string;
  expectedOutcome?: string;
}

interface ScenarioDir {
  name: string;
  dir: string;
  prompt: string;
  meta: ScenarioMeta;
}

function loadScenarios(filter: string | null): ScenarioDir[] {
  const entries = readdirSync(SCENARIO_ROOT).filter((e) => {
    const full = path.join(SCENARIO_ROOT, e);
    return statSync(full).isDirectory();
  });
  const out: ScenarioDir[] = [];
  for (const name of entries) {
    if (filter && name !== filter) continue;
    const dir = path.join(SCENARIO_ROOT, name);
    const promptPath = path.join(dir, "prompt.txt");
    const metaPath = path.join(dir, "meta.json");
    if (!existsSync(promptPath) || !existsSync(metaPath)) continue;
    out.push({
      name,
      dir,
      prompt: readFileSync(promptPath, "utf8").trim(),
      meta: JSON.parse(readFileSync(metaPath, "utf8")) as ScenarioMeta,
    });
  }
  return out;
}

async function runScenario(s: ScenarioDir): Promise<{ ok: boolean; durationMs: number; summary: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(RLM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "rlm",
        messages: [{ role: "user", content: s.prompt }],
        rlm: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        durationMs: Date.now() - start,
        summary: `HTTP ${res.status}: ${body.slice(0, 400)}`,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    writeFileSync(path.join(s.dir, "last-response.md"), content, "utf8");
    const green = /all tests pass|tests green|phase 8 complete|build: green/i.test(content);
    return {
      ok: green,
      durationMs: Date.now() - start,
      summary: green
        ? "green (content matched success markers)"
        : `unclear (response saved to last-response.md, ${content.length} chars)`,
    };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      summary: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const filter = process.argv[2] ?? null;
  const scenarios = loadScenarios(filter);
  if (scenarios.length === 0) {
    console.error(
      filter
        ? `No scenario named "${filter}" under ${SCENARIO_ROOT}`
        : `No scenarios found under ${SCENARIO_ROOT}`,
    );
    process.exit(1);
  }
  console.log(`Running ${scenarios.length} scenario(s) against ${RLM_URL}`);
  console.log("");
  let green = 0;
  for (const s of scenarios) {
    process.stdout.write(`▶ ${s.name} … `);
    const r = await runScenario(s);
    const seconds = (r.durationMs / 1000).toFixed(1);
    if (r.ok) {
      green++;
      console.log(`✅ ${seconds}s — ${r.summary}`);
    } else {
      console.log(`❌ ${seconds}s — ${r.summary}`);
    }
  }
  console.log("");
  console.log(`${green} / ${scenarios.length} green`);
  process.exit(green === scenarios.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
