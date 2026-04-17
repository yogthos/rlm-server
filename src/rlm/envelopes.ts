/**
 * Task/Result envelopes for hierarchical agents.
 * See docs/hierarchical-agents.md §3.2.
 */

export type BudgetHint = "minutes" | "hours" | "days";
export type ResultStatus = "complete" | "partial" | "failed";

export interface TestContract {
  framework: "vitest" | "node";
  files: Record<string, string>;
}

export interface TestFailure {
  name: string;
  message: string;
  file?: string;
  line?: number;
}

export interface TestReport {
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
}

export type FileSet = Record<string, string>;

export interface TaskEnvelope {
  goal: string;
  parentContext: string;
  tests: TestContract;
  structuralContract?: string;
  targetModule: string;
  targetExports: string[];
  depth: number;
  maxDepth: number;
  budgetHint: BudgetHint;
  siblingSummaries?: string[];
}

export interface ResultEnvelope {
  goal: string;
  artifact: FileSet;
  testResults: TestReport;
  integrationHints: string;
  status: ResultStatus;
  subResults?: ResultEnvelope[];
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const BUDGET_HINTS: readonly BudgetHint[] = ["minutes", "hours", "days"];
const RESULT_STATUSES: readonly ResultStatus[] = ["complete", "partial", "failed"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function validateTestContract(t: unknown, errors: string[], path: string): void {
  if (!isRecord(t)) {
    errors.push(`${path}: must be object`);
    return;
  }
  if (t.framework !== "vitest" && t.framework !== "node") {
    errors.push(`${path}.framework: must be "vitest" or "node"`);
  }
  if (!isRecord(t.files)) {
    errors.push(`${path}.files: must be object`);
  } else {
    for (const [k, v] of Object.entries(t.files)) {
      if (typeof v !== "string") errors.push(`${path}.files[${k}]: must be string`);
    }
  }
}

function validateTestReport(r: unknown, errors: string[], path: string): void {
  if (!isRecord(r)) {
    errors.push(`${path}: must be object`);
    return;
  }
  for (const k of ["passed", "failed", "skipped"] as const) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      errors.push(`${path}.${k}: must be non-negative integer`);
    }
  }
  if (!Array.isArray(r.failures)) {
    errors.push(`${path}.failures: must be array`);
  }
}

export function validateTaskEnvelope(e: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(e)) return { ok: false, errors: ["envelope must be object"] };

  if (typeof e.goal !== "string" || e.goal.length === 0) errors.push("goal: must be non-empty string");
  if (typeof e.parentContext !== "string") errors.push("parentContext: must be string");
  validateTestContract(e.tests, errors, "tests");
  if (e.structuralContract !== undefined && typeof e.structuralContract !== "string") {
    errors.push("structuralContract: must be string when present");
  }
  if (typeof e.targetModule !== "string" || e.targetModule.length === 0) {
    errors.push("targetModule: must be non-empty string");
  }
  if (!Array.isArray(e.targetExports) || e.targetExports.length === 0) {
    errors.push("targetExports: must be non-empty array");
  } else if (!e.targetExports.every((x) => typeof x === "string")) {
    errors.push("targetExports: must be array of strings");
  }
  if (typeof e.depth !== "number" || !Number.isInteger(e.depth) || e.depth < 0) {
    errors.push("depth: must be non-negative integer");
  }
  if (typeof e.maxDepth !== "number" || !Number.isInteger(e.maxDepth) || e.maxDepth < 0) {
    errors.push("maxDepth: must be non-negative integer");
  }
  if (
    typeof e.depth === "number" &&
    typeof e.maxDepth === "number" &&
    e.depth > e.maxDepth
  ) {
    errors.push("depth must be <= maxDepth");
  }
  if (typeof e.budgetHint !== "string" || !BUDGET_HINTS.includes(e.budgetHint as BudgetHint)) {
    errors.push(`budgetHint: must be one of ${BUDGET_HINTS.join(", ")}`);
  }
  if (e.siblingSummaries !== undefined) {
    if (!Array.isArray(e.siblingSummaries) || !e.siblingSummaries.every((x) => typeof x === "string")) {
      errors.push("siblingSummaries: must be array of strings when present");
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateResultEnvelope(e: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(e)) return { ok: false, errors: ["envelope must be object"] };

  if (typeof e.goal !== "string") errors.push("goal: must be string");
  if (!isRecord(e.artifact)) {
    errors.push("artifact: must be object");
  } else {
    for (const [k, v] of Object.entries(e.artifact)) {
      if (typeof v !== "string") errors.push(`artifact[${k}]: must be string`);
    }
  }
  validateTestReport(e.testResults, errors, "testResults");
  if (typeof e.integrationHints !== "string") errors.push("integrationHints: must be string");
  if (typeof e.status !== "string" || !RESULT_STATUSES.includes(e.status as ResultStatus)) {
    errors.push(`status: must be one of ${RESULT_STATUSES.join(", ")}`);
  }
  if (e.subResults !== undefined) {
    if (!Array.isArray(e.subResults)) {
      errors.push("subResults: must be array when present");
    } else {
      e.subResults.forEach((sub, i) => {
        const r = validateResultEnvelope(sub);
        if (!r.ok) errors.push(...r.errors.map((x) => `subResults[${i}].${x}`));
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function encodeTaskEnvelope(e: TaskEnvelope): string {
  return JSON.stringify(e);
}

export function decodeTaskEnvelope(json: string): TaskEnvelope {
  const parsed = JSON.parse(json);
  const r = validateTaskEnvelope(parsed);
  if (!r.ok) throw new Error(`invalid TaskEnvelope: ${r.errors.join("; ")}`);
  return parsed as TaskEnvelope;
}

export function encodeResultEnvelope(e: ResultEnvelope): string {
  return JSON.stringify(e);
}

export function decodeResultEnvelope(json: string): ResultEnvelope {
  const parsed = JSON.parse(json);
  const r = validateResultEnvelope(parsed);
  if (!r.ok) throw new Error(`invalid ResultEnvelope: ${r.errors.join("; ")}`);
  return parsed as ResultEnvelope;
}
