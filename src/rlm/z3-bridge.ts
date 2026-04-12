/**
 * Z3 solver bridge for the RLM sandbox.
 *
 * Host-side: `z3Solve()` lazily loads z3-solver WASM and runs SMT-LIB checks.
 * Sandbox-side: `Z3_IMPL` injectable string wraps the host global `__z3Bridge`.
 *
 * Adapted from chiasmus/src/solvers/z3-solver.ts.
 */

import { init } from "z3-solver";
import type { Z3Result } from "./types.js";

// Cache Z3 WASM initialization — loads ~30MB, should only happen once.
let z3Promise: ReturnType<typeof init> | null = null;

function getZ3() {
  if (!z3Promise) {
    z3Promise = init();
  }
  return z3Promise;
}

const DEFAULT_Z3_TIMEOUT_MS = 30_000;

/** Strip commands we handle ourselves to avoid conflicts. */
function sanitizeSmtlib(input: string): string {
  return input
    .replace(
      /\(\s*(?:check-sat|get-model|get-unsat-core|exit|set-option\s+:produce-unsat-cores\s+\w+)\s*\)/g,
      "",
    )
    .trim();
}

/** Sanitize and inject a default timeout if the caller did not provide one. */
export function prepareSmtlib(input: string): string {
  const sanitized = sanitizeSmtlib(input);
  if (!sanitized) return sanitized;
  if (/\(\s*set-option\s+:timeout\s+\d+\s*\)/.test(sanitized)) {
    return sanitized;
  }
  return `(set-option :timeout ${DEFAULT_Z3_TIMEOUT_MS})\n${sanitized}`;
}

/**
 * Solve an SMT-LIB problem. Lazily initializes Z3 WASM on first call.
 *
 * @param smtlib - SMT-LIB format string (declarations + assertions).
 * @param timeoutMs - Per-check timeout (default: 30s).
 */
export async function z3Solve(
  smtlib: string,
  timeoutMs?: number,
): Promise<Z3Result> {
  try {
    const z3 = await getZ3();
    const ctx = z3.Context("main");

    const prepared = prepareSmtlib(smtlib);
    if (!prepared) {
      return { status: "sat", model: {} };
    }

    // Override timeout if provided
    const withTimeout = timeoutMs
      ? prepared.replace(
          /\(set-option :timeout \d+\)/,
          `(set-option :timeout ${timeoutMs})`,
        )
      : prepared;

    const solver = new ctx.Solver();
    try {
      solver.fromString(
        `(set-option :produce-unsat-cores true)\n${withTimeout}`,
      );
    } catch (e: unknown) {
      solver.release();
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    let checkResult: string;
    try {
      checkResult = await solver.check();
    } catch (e: unknown) {
      solver.release();
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    if (checkResult === "unsat") {
      try {
        const coreVector = solver.unsatCore();
        const unsatCore: string[] = [];
        for (let i = 0; i < coreVector.length(); i++) {
          unsatCore.push(coreVector.get(i).sexpr());
        }
        solver.release();
        return { status: "unsat", unsatCore };
      } catch {
        solver.release();
        return { status: "unsat", unsatCore: [] };
      }
    }

    if (checkResult !== "sat") {
      solver.release();
      return { status: "unknown" };
    }

    try {
      const model = solver.model();
      const assignments: Record<string, string> = {};
      for (const decl of model.decls()) {
        assignments[decl.name()] = model.eval(decl.call()).toString();
      }
      solver.release();
      return { status: "sat", model: assignments };
    } catch (e: unknown) {
      solver.release();
      return {
        status: "error",
        error: `Model extraction failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } catch (e: unknown) {
    return {
      status: "error",
      error: `Z3 initialization failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Injectable string for the sandbox VM.
 * Requires `__z3Bridge` async function in the VM context.
 */
export const Z3_IMPL = `
async function z3(smtlib, options) {
  var timeout = (options && options.timeout) || undefined;
  return await __z3Bridge(smtlib, timeout);
}
`;
