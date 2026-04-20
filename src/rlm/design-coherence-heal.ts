/**
 * Self-heal for structure coherence violations.
 *
 * The integration orchestrator runs `designCoherence` after phase 0-2
 * (specs attached, no bodies). If violations exist, we try to auto-fix
 * each one before giving up:
 *
 *   - `phantom-dep`: drop the phantom name from the offending
 *     function's spec.dependencies. Mechanical — no LLM call.
 *   - `orphan`: ask the architect which existing function should take
 *     the orphan as a dep, OR whether to drop the orphan from the
 *     plan entirely. Applies the chosen fix.
 *   - `cycle`: can't auto-break without restructuring the whole
 *     decomposition. Hard-fail; surface the cycle to the caller.
 *
 * Returns `{ ok, healed, unhealed }`. `ok: true` means every violation
 * was fixed and the graph is now coherent; `false` means at least one
 * violation remained unresolved.
 */

import type { DesignGraph } from "./design-graph.js";
import { designCoherence } from "./design-coherence.js";
import { extractJson } from "./design-plan.js";
import { debug } from "./debug.js";

export interface HealOptions {
  chat: (prompt: string) => Promise<string>;
}

export interface HealReport {
  ok: boolean;
  /** Per-violation tags identifying what got fixed: `<kind>:<name>`. */
  healed: string[];
  /** Per-violation tags identifying what remained unresolved. */
  unhealed: string[];
}

function buildOrphanPrompt(
  graph: DesignGraph,
  orphanName: string,
): string {
  const candidates = graph
    .listFunctions()
    .filter((f) => f.name !== orphanName)
    .map((f) => `  - ${f.name}: ${f.spec?.purpose?.slice(0, 120) ?? "(no spec)"}`);
  return [
    `Function "${orphanName}" is in the graph but no other function's`,
    `spec.dependencies lists it. Either it should be called by one of`,
    `the existing functions, or it shouldn't be in the plan at all.`,
    "",
    "Candidates that could declare it as a dependency:",
    candidates.length > 0 ? candidates.join("\n") : "  (no other functions)",
    "",
    "Return ONLY a fenced JSON object:",
    "```json",
    '{"caller": "<function name that should depend on this, or null>",',
    ' "action": "add-dep" | "drop"}',
    "```",
    "",
    `- action="add-dep": pick a caller from the list above.`,
    `  We'll append "${orphanName}" to that function's spec.dependencies.`,
    `- action="drop": no one should call it; remove from the plan.`,
  ].join("\n");
}

async function healPhantomDep(
  graph: DesignGraph,
  module: string,
  name: string,
  phantomName: string,
): Promise<boolean> {
  const fn = graph.getFunction(module, name);
  if (!fn || !fn.spec) return false;
  if (!fn.spec.dependencies.includes(phantomName)) return true;
  graph.setSpec(module, name, {
    ...fn.spec,
    dependencies: fn.spec.dependencies.filter((d) => d !== phantomName),
  });
  return true;
}

async function healOrphan(
  graph: DesignGraph,
  module: string,
  name: string,
  chat: (prompt: string) => Promise<string>,
): Promise<boolean> {
  const prompt = buildOrphanPrompt(graph, name);
  let response: string;
  try {
    response = await chat(prompt);
  } catch (e) {
    debug(
      "coherence",
      `orphan heal chat threw (${e instanceof Error ? e.message : String(e)})`,
    );
    return false;
  }
  const parsed = extractJson(response);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const r = parsed as Record<string, unknown>;
  if (r.action === "drop") {
    graph.removeFunction(module, name);
    return true;
  }
  if (r.action !== "add-dep") return false;
  if (typeof r.caller !== "string") return false;
  const caller = graph.listFunctions().find((f) => f.name === r.caller);
  if (!caller || !caller.spec) return false;
  if (caller.name === name) return false; // no self-cycles
  if (caller.spec.dependencies.includes(name)) return true;
  graph.setSpec(caller.module, caller.name, {
    ...caller.spec,
    dependencies: [...caller.spec.dependencies, name],
  });
  return true;
}

/**
 * Extract the phantom name from a phantom-dep violation's detail text.
 * The structure coherence formatter emits:
 *   spec.dependencies of "<caller>" lists "<phantom>", but ...
 */
function extractPhantomName(detail: string): string | null {
  const m = detail.match(/lists "([^"]+)"/);
  return m ? m[1] : null;
}

export async function healStructureCoherence(
  graph: DesignGraph,
  options: HealOptions,
): Promise<HealReport> {
  const healed: string[] = [];
  const unhealed: string[] = [];
  const report = await designCoherence(graph);
  if (report.ok) return { ok: true, healed: [], unhealed: [] };
  for (const v of report.violations) {
    const tag = `${v.kind}:${v.name}`;
    if (v.kind === "cycle") {
      unhealed.push(tag);
      continue;
    }
    if (v.kind === "phantom-dep") {
      const phantom = extractPhantomName(v.detail);
      if (!phantom) {
        unhealed.push(tag);
        continue;
      }
      const ok = await healPhantomDep(graph, v.module, v.name, phantom);
      if (ok) healed.push(tag);
      else unhealed.push(tag);
      continue;
    }
    if (v.kind === "orphan") {
      const ok = await healOrphan(graph, v.module, v.name, options.chat);
      if (ok) healed.push(tag);
      else unhealed.push(tag);
      continue;
    }
    unhealed.push(tag);
  }
  return {
    ok: unhealed.length === 0,
    healed,
    unhealed,
  };
}
