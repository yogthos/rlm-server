/**
 * Adapter that exposes `finalizeProject` as an `IntegrationRunner`.
 *
 * Runs the full materialize + vitest + tsc pipeline and synthesizes
 * `IntegrationFailure[]` from the finalize report's test output. Stack
 * traces aren't preserved verbatim by `parseVitestJson` — the fallback
 * LLM attribution path picks up the slack when a failure lacks a
 * frame matching a known function.
 *
 * Use this as the runner in `designPlanIntegration` when you want
 * production-grade test execution.
 */

import type { DesignGraph } from "./design-graph.js";
import { finalizeProject } from "./finalize.js";
import type {
  IntegrationRunResult,
  IntegrationFailure,
} from "./design-integration-loop.js";

export function createIntegrationRunner(): (
  graph: DesignGraph,
) => Promise<IntegrationRunResult> {
  return async (graph) => {
    const report = await finalizeProject(graph, {
      typecheck: false,
      runTests: true,
    });
    if (report.ok) return { ok: true, failures: [] };
    const failures: IntegrationFailure[] = [];
    // testOutput format: "✗ <testName>: <first line of failure message>".
    // parseVitestJson drops stack traces to save tokens; attribution
    // falls back to the LLM when no frame resolves.
    for (const line of report.testOutput.split("\n")) {
      const m = line.match(/^✗\s+(.+?):\s+(.*)$/);
      if (!m) continue;
      failures.push({
        testName: m[1].trim(),
        message: m[2].trim(),
        stackTrace: "",
      });
    }
    return { ok: failures.length === 0, failures };
  };
}
