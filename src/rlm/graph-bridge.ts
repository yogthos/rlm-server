/**
 * Code graph bridge for the RLM sandbox.
 *
 * Host-side: `graphAnalyze()` reads files, builds the call graph via
 * tree-sitter, and runs O(V+E) analyses.
 * Sandbox-side: `GRAPH_IMPL` injectable string wraps `__graphBridge`.
 *
 * Available analyses: summary, callers, callees, reachability,
 * dead-code, cycles, path, impact, facts.
 */

import { runAnalysis } from "./graph/analyses.js";
import type { AnalysisRequest, AnalysisResult } from "./graph/analyses.js";

/**
 * Run a graph analysis on source files. Called from the host side.
 *
 * @param files - Array of absolute file paths to analyze.
 * @param analysis - Analysis type (summary, callers, callees, etc.).
 * @param options - Optional: target, from, to, entryPoints.
 */
export async function graphAnalyze(
  files: string[],
  analysis: string,
  options?: {
    target?: string;
    from?: string;
    to?: string;
    entryPoints?: string[];
  },
): Promise<AnalysisResult> {
  const request: AnalysisRequest = {
    analysis: analysis as AnalysisRequest["analysis"],
    target: options?.target,
    from: options?.from,
    to: options?.to,
    entryPoints: options?.entryPoints,
  };

  return runAnalysis(files, request);
}

/**
 * Injectable string for the sandbox VM.
 * Requires `__graphBridge` async function in the VM context.
 *
 * Usage in sandbox:
 *   const result = await graph(["./src/app.ts", "./src/utils.ts"], "summary")
 *   const result = await graph(files, "callers", { target: "handleRequest" })
 *   const result = await graph(files, "cycles")
 *   const result = await graph(files, "impact", { target: "parseInput" })
 *   const result = await graph(files, "reachability", { from: "main", to: "db_query" })
 *   const result = await graph(files, "dead-code", { entryPoints: ["main"] })
 *   const result = await graph(files, "path", { from: "handler", to: "repository" })
 *   const result = await graph(files, "facts")  // Prolog program for custom queries
 */
export const GRAPH_IMPL = `
async function graph(files, analysis, options) {
  return await __graphBridge(files, analysis, options || {});
}
`;
