/**
 * Shared types for the dispatch layer. Extracted from the legacy
 * single-shot dispatcher so consumers (leaf-up-build, integration
 * loop, cleanup, build) don't depend on the old implementation file.
 * The agent dispatcher (`design-dispatch-agent.ts`) now owns the
 * per-function implementation loop; these types describe its result
 * and the chat/test backends it wires to.
 */

import type { DesignGraph, FunctionStatus } from "./design-graph.js";
import type { TestRunResult } from "./test-runner.js";
import { debug } from "./debug.js";

export interface DispatchResult {
  module: string;
  name: string;
  /** "stagnated" = turn budget exhausted or the Implementer gave up.
   *  Signals the orchestrator to decompose (if it has that capability)
   *  rather than spending more attempts. Distinct from "failed" which
   *  covers other error paths (chat errors, etc.). */
  status: FunctionStatus | "failed" | "stagnated";
  implementation: string | null;
  attempts: number;
  /** Last test output — present whether we finished green or red. */
  testOutput: string;
  /** When dispatch failed to produce a passing implementation. */
  error?: string;
}

export type ChatFn = (prompt: string) => Promise<string>;

export type TestFn = (
  graph: DesignGraph,
  candidate: { module: string; name: string; body: string },
  options?: { projectDir?: string },
) => Promise<TestRunResult>;

/** Host-provided callback that plans children for a function and
 *  dispatches them before this function's own body is written. Called
 *  when a function is chosen to DECOMPOSE rather than IMPLEMENT
 *  directly. Returns true on success, false when the sub-plan failed. */
export type DecomposeFn = (
  graph: DesignGraph,
  parentName: string,
) => Promise<boolean>;

/**
 * Wrap a ChatFn with abort-retry: on abort-like errors (HTTP signal
 * fired even though the model might have produced a response), retry
 * the same prompt up to 2 times before giving up. Non-abort errors
 * propagate on first occurrence.
 */
const MAX_ABORT_RETRIES = 2;
export function withAbortRetry(chat: ChatFn): ChatFn {
  return async (prompt: string): Promise<string> => {
    let lastAbort: unknown = null;
    for (let i = 0; i <= MAX_ABORT_RETRIES; i++) {
      try {
        return await chat(prompt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isAbort = /abort|AbortError/i.test(msg);
        if (!isAbort || i === MAX_ABORT_RETRIES) throw e;
        lastAbort = e;
        debug(
          "dispatch",
          `chat aborted — abort-retry ${i + 1}/${MAX_ABORT_RETRIES}`,
        );
      }
    }
    throw lastAbort ?? new Error("unreachable");
  };
}
