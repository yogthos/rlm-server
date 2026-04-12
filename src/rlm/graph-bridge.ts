/**
 * Code graph bridge for the RLM sandbox.
 *
 * Host-side: `graphAnalyze()` reads files, builds the call graph via
 * tree-sitter, and runs O(V+E) analyses.
 * Sandbox-side: `GRAPH_IMPL` injectable string wraps `__graphBridge`.
 *
 * Security: file paths are validated against an allowed root directory
 * to prevent the LLM from reading arbitrary files on disk.
 */

import { resolve, normalize } from "node:path";
import { runAnalysis } from "./graph/analyses.js";
import type { AnalysisRequest, AnalysisResult } from "./graph/analyses.js";

/**
 * Create a graph analysis function scoped to an allowed directory.
 * Paths outside `allowedRoot` are rejected.
 */
export function createGraphBridge(allowedRoot: string) {
  const root = resolve(allowedRoot);

  return async function graphAnalyze(
    files: string[],
    analysis: string,
    options?: {
      target?: string;
      from?: string;
      to?: string;
      entryPoints?: string[];
    },
  ): Promise<AnalysisResult> {
    // Validate every path is under the allowed root
    const safePaths: string[] = [];
    for (const f of files) {
      const abs = resolve(f);
      const normalized = normalize(abs);
      if (!normalized.startsWith(root)) {
        return {
          analysis: analysis as AnalysisRequest["analysis"],
          result: { error: `Path outside allowed directory: ${f}` },
        };
      }
      safePaths.push(abs);
    }

    const request: AnalysisRequest = {
      analysis: analysis as AnalysisRequest["analysis"],
      target: options?.target,
      from: options?.from,
      to: options?.to,
      entryPoints: options?.entryPoints,
    };

    return runAnalysis(safePaths, request);
  };
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
