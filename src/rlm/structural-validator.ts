/**
 * Thin wrapper over `enforce()` returning a `{ violations, advisories }`
 * split in the `StructuralError` shape expected by `fix-prompts.ts`.
 *
 * `fast` mode skips typecheck/lint/test (subprocess overhead); used for
 * per-turn validation on every code artifact the model emits.
 * `full` mode adds typecheck; used before accepting FINAL at the root.
 */

import { enforce, type LayerName } from "./enforcement.js";
import type { FileSet, TestContract } from "./envelopes.js";
import type { StructuralError } from "./fix-prompts.js";

export interface ValidateOptions {
  artifact: FileSet;
  tests?: TestContract;
  contract?: string;
  mode?: "fast" | "full";
  /**
   * Accumulated project files to merge with `artifact` before validation.
   * When present, orphan / island / unresolved-call rules fire against the
   * full project graph rather than the single file. `artifact` overrides
   * any same-named file in `projectFiles` so the caller always stages
   * the latest version.
   */
  projectFiles?: FileSet;
}

export interface ValidationReport {
  ok: boolean;
  violations: StructuralError[];   // blocking
  advisories: StructuralError[];   // non-blocking
}

const EMPTY_TESTS: TestContract = { framework: "vitest", files: {} };

export async function validateArtifact(opts: ValidateOptions): Promise<ValidationReport> {
  const mode = opts.mode ?? "fast";
  const skipLayers: LayerName[] =
    mode === "fast"
      ? ["typecheck", "lint", "test"]
      : ["lint", "test"];

  const merged: FileSet = opts.projectFiles
    ? { ...opts.projectFiles, ...opts.artifact }
    : opts.artifact;

  const report = await enforce({
    artifact: merged,
    tests: opts.tests ?? EMPTY_TESTS,
    structuralContract: opts.contract,
    skipLayers,
  });

  const violations: StructuralError[] = [];
  const advisories: StructuralError[] = [];

  for (const layer of ["parse", "typecheck", "structural"] as const) {
    for (const e of report.layers[layer].errors) {
      const se: StructuralError = {
        layer,
        message: e.message,
        file: e.file,
        line: e.line,
      };
      if (e.severity === "blocking") violations.push(se);
      else advisories.push(se);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    advisories,
  };
}
