/**
 * Phase F — architect reviews each project integration test.
 *
 * For every test in `graph.listProjectTests()`, the architect asks:
 * does this test actually exercise its declared path / scenario, or
 * is it vacuous / off-topic / wrong? Verdicts:
 *
 *   - APPROVE — test stands as-is.
 *   - REVISE  — architect supplies feedback; a second LLM call
 *               rewrites the test with that feedback in hand.
 *
 * Bounded per test by `maxReviewCycles`. Exhaustion returns ok=false
 * with the last architect feedback as the error.
 *
 * Revised tests replace the old entry (not append) via
 * `graph.replaceProjectTests` — matches the Round 6 rule that test
 * regenerations overwrite, never accumulate.
 */

import type { DesignGraph, TestSpec } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { debug } from "./debug.js";

export interface IntegrationReviewOptions {
  chat: (prompt: string) => Promise<string>;
  /** Per-test review cycles before giving up. Default 2. */
  maxReviewCycles?: number;
}

export interface IntegrationReviewReport {
  ok: boolean;
  /** How many tests went through review (including repeats on REVISE). */
  reviewed: number;
  /** How many tests were rewritten at least once. */
  revised: number;
  /** Last error on exhaustion — null when ok. */
  error: string | null;
}

interface ReviewVerdict {
  verdict: "APPROVE" | "REVISE";
  feedback: string;
}

function buildReviewPrompt(test: TestSpec, task: string): string {
  return [
    "You are reviewing a PROJECT-LEVEL integration test for a proc-ts app.",
    "",
    `User task: ${task}`,
    "",
    `Test name: ${test.name}`,
    "",
    "Test body:",
    "```",
    test.code,
    "```",
    "",
    "Your job: decide if this test actually exercises the scenario its",
    "name claims to cover. Check: does it make the real HTTP call / file",
    "write / function invocation? Does the assertion verify something",
    "meaningful? Is it vacuous (always passes) or tautological?",
    "",
    "Return ONLY a fenced JSON block:",
    "```json",
    '{"verdict": "APPROVE" | "REVISE", "feedback": "<why, specific>"}',
    "```",
    "",
    "Use APPROVE when the test is genuinely useful. Use REVISE ONLY",
    "when there is a concrete, testable problem (missing assertion,",
    "wrong endpoint, mocked when it should be real, etc.).",
  ].join("\n");
}

function buildRewritePrompt(
  test: TestSpec,
  task: string,
  feedback: string,
): string {
  return [
    "Rewrite this integration test to address the architect's feedback.",
    "",
    `User task: ${task}`,
    "",
    `Original test name: ${test.name}`,
    "",
    "Original body:",
    "```",
    test.code,
    "```",
    "",
    `Architect feedback: ${feedback}`,
    "",
    "Return ONLY a fenced JSON object (SINGLE test, not an array):",
    "```json",
    '{"name": "<revised or same name>", "code": "<rewritten test body>"}',
    "```",
  ].join("\n");
}

function parseVerdict(raw: unknown): ReviewVerdict | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const v = r.verdict;
  if (v !== "APPROVE" && v !== "REVISE") return null;
  const feedback = typeof r.feedback === "string" ? r.feedback : "";
  return { verdict: v, feedback };
}

function parseRewrite(raw: unknown): TestSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  if (typeof r.code !== "string") return null;
  return { name: r.name, code: r.code };
}

export async function reviewIntegrationTests(
  graph: DesignGraph,
  task: string,
  options: IntegrationReviewOptions,
): Promise<IntegrationReviewReport> {
  const tests = graph.listProjectTests();
  if (tests.length === 0) {
    return { ok: true, reviewed: 0, revised: 0, error: null };
  }
  const maxCycles = options.maxReviewCycles ?? 2;
  let reviewed = 0;
  let revised = 0;
  const final: TestSpec[] = [];
  for (const initial of tests) {
    let current = initial;
    let approved = false;
    let lastFeedback = "";
    for (let cycle = 0; cycle < maxCycles; cycle++) {
      reviewed++;
      debug(
        "integration-review",
        `"${current.name}" cycle ${cycle + 1}/${maxCycles}`,
      );
      let response: string;
      try {
        response = await options.chat(buildReviewPrompt(current, task));
      } catch (e) {
        lastFeedback = e instanceof Error ? e.message : String(e);
        continue;
      }
      const parsed = extractJson(response);
      const verdict = parseVerdict(parsed);
      if (!verdict) {
        // Treat garbage as REVISE so we keep trying. Record a generic
        // feedback note — the rewrite prompt surfaces this so the LLM
        // knows to re-answer cleanly.
        lastFeedback = "architect returned an unparseable verdict; retry";
        continue;
      }
      if (verdict.verdict === "APPROVE") {
        approved = true;
        break;
      }
      // REVISE — ask for a rewrite, store the new test, re-review.
      lastFeedback = verdict.feedback;
      let rewriteResponse: string;
      try {
        rewriteResponse = await options.chat(
          buildRewritePrompt(current, task, verdict.feedback),
        );
      } catch (e) {
        lastFeedback = e instanceof Error ? e.message : String(e);
        continue;
      }
      const rewriteParsed = extractJson(rewriteResponse);
      const next = parseRewrite(rewriteParsed);
      if (!next) {
        lastFeedback = "rewrite response unparseable";
        continue;
      }
      revised++;
      current = next;
    }
    if (!approved) {
      // Bail on first unapproved test. Preserve best-attempt body for
      // the current test AND leave every still-unprocessed test alone.
      // Index discipline: `final.length` is the count of already-done
      // tests, so `tests[final.length]` is the current one and
      // `tests.slice(final.length + 1)` is everything after it.
      final.push(current);
      const trailing = tests.slice(final.length);
      graph.replaceProjectTests([...final, ...trailing]);
      return {
        ok: false,
        reviewed,
        revised,
        error: `review exhausted for "${current.name}" after ${maxCycles} cycle(s): ${lastFeedback}`,
      };
    }
    final.push(current);
  }
  graph.replaceProjectTests(final);
  return { ok: true, reviewed, revised, error: null };
}
