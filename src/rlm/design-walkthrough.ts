/**
 * Top-down walkthrough — a planning pass that checks whether the
 * function graph produced by phase 1+2 actually covers all use cases
 * implied by the task. The architect enumerates use cases, maps each
 * to the functions that would handle it, and flags gaps.
 *
 * Runs BETWEEN phase 2 (specs) and phase 3 (coherence). The only
 * output is new STUBS — signatures + descriptions — added to the
 * graph. Phase 2's spec-fill loop runs again after walkthrough to
 * attach specs to the new stubs. No implementation yet.
 *
 * Scope:
 *   - Gap-filling ONLY. Walkthrough never removes functions (too
 *     destructive; the outer planner owns the graph shape).
 *   - Silent-skip duplicates — phase 1 idempotency rules apply.
 *   - Fail-open: on unparseable / chat error, return empty addedNames
 *     with an error marker. The outer pipeline proceeds with whatever
 *     it had.
 */

import type { DesignGraph, Signature } from "./design-graph.js";
import { extractJson } from "./design-plan.js";
import { debug } from "./debug.js";

export interface WalkthroughMissingFn {
  module: string;
  name: string;
  signature: Signature;
  description: string;
  reason: string;
}

export interface WalkthroughResult {
  coverage: Array<{ useCase: string; handledBy: string[] }>;
  missing: WalkthroughMissingFn[];
}

export interface WalkthroughReport {
  addedNames: string[];
  error: string | null;
}

export type ChatFn = (prompt: string) => Promise<string>;

/** Safety cap on how many stubs a single walkthrough pass may add.
 *  If the LLM proposes more, we take the first N and drop the rest —
 *  prevents a prompt-injected or confused response from exploding the
 *  graph. Tune up if a real task legitimately hits this. */
const MAX_WALKTHROUGH_MISSING = 5;

function parseSignature(v: unknown): Signature | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.params)) return null;
  const params: Array<{ name: string; type: string }> = [];
  for (const p of r.params) {
    if (!p || typeof p !== "object") return null;
    const pr = p as Record<string, unknown>;
    if (typeof pr.name !== "string" || typeof pr.type !== "string") return null;
    params.push({ name: pr.name, type: pr.type });
  }
  if (typeof r.returnType !== "string") return null;
  const sig: Signature = { params, returnType: r.returnType };
  if (typeof r.isAsync === "boolean") sig.isAsync = r.isAsync;
  return sig;
}

/**
 * Pure parser so callers can feed canned responses in tests without
 * standing up a chat. Returns null on any shape violation.
 */
export function parseWalkthroughResult(
  response: string,
): WalkthroughResult | null {
  const parsed = extractJson(response);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;
  const coverageRaw = Array.isArray(r.coverage) ? r.coverage : [];
  const coverage: WalkthroughResult["coverage"] = [];
  for (const c of coverageRaw) {
    if (!c || typeof c !== "object") return null;
    const cr = c as Record<string, unknown>;
    if (typeof cr.useCase !== "string") return null;
    if (!Array.isArray(cr.handledBy)) return null;
    const handledBy = cr.handledBy.filter(
      (h): h is string => typeof h === "string",
    );
    coverage.push({ useCase: cr.useCase, handledBy });
  }
  const missingRaw = Array.isArray(r.missing) ? r.missing : [];
  const missing: WalkthroughMissingFn[] = [];
  for (const m of missingRaw) {
    if (!m || typeof m !== "object") return null;
    const mr = m as Record<string, unknown>;
    if (typeof mr.module !== "string") return null;
    if (typeof mr.name !== "string") return null;
    if (typeof mr.description !== "string") return null;
    if (typeof mr.reason !== "string") return null;
    const sig = parseSignature(mr.signature);
    if (!sig) return null;
    missing.push({
      module: mr.module,
      name: mr.name,
      signature: sig,
      description: mr.description,
      reason: mr.reason,
    });
  }
  return { coverage, missing };
}

function buildWalkthroughPrompt(graph: DesignGraph, task: string): string {
  const fns = graph.listFunctions();
  const fnList = fns
    .map((f) => {
      const params = f.signature.params
        .map((p) => `${p.name}: ${p.type}`)
        .join(", ");
      return `  - ${f.module}#${f.name}(${params}): ${f.signature.returnType} — ${f.description}`;
    })
    .join("\n");
  return [
    `You are walking through the task's use cases to verify the planned`,
    `function graph can actually handle them. This is a top-down check:`,
    `you're NOT writing code, you're confirming the shape is right.`,
    "",
    `User task:`,
    task,
    "",
    `Currently planned functions:`,
    fnList || "  (none)",
    "",
    `For every distinct USE CASE implied by the task (e.g. "GET /",`,
    `"POST /sign", "startup initialization", "error recovery"):`,
    `  1. Name the use case.`,
    `  2. List which planned function(s) would handle it.`,
    `  3. If NO planned function handles it, add a stub to \`missing\`.`,
    "",
    `Rules:`,
    `- ONLY flag genuinely missing capabilities. Do not invent features`,
    `  the task doesn't ask for.`,
    `- Missing stubs should be NEW function names — do NOT re-propose`,
    `  names already in the planned list.`,
    `- Keep missing short — typically 0–3 entries. If nothing is missing,`,
    `  return an empty array.`,
    "",
    `Return ONLY a fenced JSON block:`,
    "```json",
    "{",
    '  "coverage": [',
    '    {"useCase": "<what the task asks for>",',
    '     "handledBy": ["<fn name>", ...]}',
    "  ],",
    '  "missing": [',
    '    {"module": "<path>", "name": "<camelCase>",',
    '     "signature": {"params": [{"name":"x","type":"T"}], "returnType":"R"},',
    '     "description": "<one line>", "reason": "<why this is needed>"}',
    "  ]",
    "}",
    "```",
    "No prose outside the JSON block.",
  ].join("\n");
}

/**
 * Run the walkthrough pass. Adds any missing function stubs to the
 * graph with origin="plan". Returns the list of names actually added
 * (duplicates silent-skipped).
 */
export async function walkthroughTask(
  graph: DesignGraph,
  task: string,
  chat: ChatFn,
): Promise<WalkthroughReport> {
  const prompt = buildWalkthroughPrompt(graph, task);
  let response: string;
  try {
    response = await chat(prompt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debug("walkthrough", `chat threw: ${msg}`);
    return { addedNames: [], error: msg };
  }
  const parsed = parseWalkthroughResult(response);
  if (!parsed) {
    debug("walkthrough", `unparseable response; skipping gap-fill`);
    return { addedNames: [], error: "walkthrough response unparseable" };
  }
  const addedNames: string[] = [];
  const effectiveMissing = parsed.missing.slice(0, MAX_WALKTHROUGH_MISSING);
  if (parsed.missing.length > MAX_WALKTHROUGH_MISSING) {
    debug(
      "walkthrough",
      `missing list capped: ${parsed.missing.length} → ${MAX_WALKTHROUGH_MISSING}`,
    );
  }
  for (const m of effectiveMissing) {
    try {
      graph.addModule(m.module);
      graph.addFunction(m.module, m.name, m.signature, m.description, "plan");
      addedNames.push(m.name);
      debug(
        "walkthrough",
        `added missing ${m.module}#${m.name} — ${m.reason}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^duplicate function(?:\s+name)?:/.test(msg)) {
        debug(
          "walkthrough",
          `skipped duplicate ${m.module}#${m.name}: ${msg}`,
        );
        continue;
      }
      debug(
        "walkthrough",
        `failed to add ${m.module}#${m.name}: ${msg}`,
      );
    }
  }
  debug(
    "walkthrough",
    `coverage ${parsed.coverage.length} use-case(s); added ${addedNames.length} missing fn(s)`,
  );
  return { addedNames, error: null };
}
