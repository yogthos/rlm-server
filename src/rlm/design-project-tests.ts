/**
 * Phase 6: project-level integration tests. The Architect (or a
 * dedicated pass) asks the LLM for end-to-end tests that exercise
 * the shipped app as a whole, not individual functions. These live
 * on the graph via `addProjectTest` / `listProjectTests` and are
 * rendered into a single integration spec at finalize time.
 *
 * Resume: if projectTests already exist on the graph, skip the LLM
 * call entirely. Project tests are authored once per plan; regen
 * happens only when the graph is empty.
 */

import type { DesignGraph, TestSpec } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { debug } from "./debug.js";

export interface DesignProjectTestsOptions {
  chat: (prompt: string) => Promise<string>;
  /** Parse/shape retries before giving up. Default 1. */
  maxRetries?: number;
}

export interface ProjectTestsReport {
  ok: boolean;
  error?: string;
}

export function parseProjectTestList(raw: unknown): TestSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("project test list must be a JSON array");
  }
  if (raw.length === 0) {
    throw new Error("project test list must contain at least one test");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`test ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") {
      throw new Error(`test ${i} missing "name"`);
    }
    if (typeof r.code !== "string") {
      throw new Error(`test ${i} missing "code"`);
    }
    return { name: r.name, code: r.code };
  });
}

function buildPrompt(graph: DesignGraph, task: string): string {
  const fns = graph.listFunctions();
  const fnLines = fns.map((f) => {
    const params = f.signature.params
      .map((p) => `${p.name}: ${p.type}`)
      .join(", ");
    return `  - ${f.name}(${params}) -> ${f.signature.returnType}`;
  });
  return [
    "You are writing PROJECT-LEVEL integration tests for a proc-ts app.",
    "These tests exercise the app end-to-end (HTTP round-trips, file I/O,",
    "full workflows) — not individual functions in isolation.",
    "",
    `User task: ${task}`,
    "",
    "Functions available in the design graph:",
    ...(fnLines.length > 0 ? fnLines : ["  (none yet)"]),
    "",
    "Return ONLY a fenced JSON array. Each entry must have shape:",
    '  {"name": "<human-readable test name>", "code": "<test body>"}',
    "",
    "Example:",
    "```json",
    '[{"name": "POST /sign adds an entry", "code": "const res = await fetch(\'/sign\', ...);"}]',
    "```",
  ].join("\n");
}

export async function designProjectTests(
  graph: DesignGraph,
  task: string,
  options: DesignProjectTestsOptions,
): Promise<ProjectTestsReport> {
  if (graph.listProjectTests().length > 0) {
    debug(
      "project-tests",
      `resume: ${graph.listProjectTests().length} existing tests, skipping LLM`,
    );
    return { ok: true };
  }
  const maxRetries = options.maxRetries ?? 1;
  const basePrompt = buildPrompt(graph, task);
  let prompt = basePrompt;
  let lastError = "(no attempt made)";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debug(
      "project-tests",
      `attempt ${attempt + 1}/${maxRetries + 1}`,
    );
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      debug("project-tests", `chat error: ${lastError}`);
      break;
    }
    const parsed = extractJson(response);
    if (parsed === null) {
      lastError = "response did not contain valid JSON";
      prompt = `${basePrompt}\n\nYour previous response was not valid JSON. Return ONLY a fenced JSON block this time.`;
      continue;
    }
    try {
      const tests = parseProjectTestList(parsed);
      for (const t of tests) graph.addProjectTest(t);
      return { ok: true };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      prompt = `${basePrompt}\n\nYour previous response had a schema error: ${lastError}. Fix the shape and return ONLY a fenced JSON block.`;
    }
  }
  return { ok: false, error: lastError };
}
