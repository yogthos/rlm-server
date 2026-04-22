/**
 * Self-heal for structure coherence violations.
 *
 * The integration orchestrator runs `designCoherence` after phase 0-2
 * (specs attached, no bodies). If violations exist, we try to auto-fix
 * each one before giving up:
 *
 *   - `phantom-dep`: drop the phantom name from the offending
 *     function's spec.dependencies. Mechanical — no LLM call.
 *   - `cycle`: can't auto-break without restructuring the whole
 *     decomposition. Hard-fail; surface the cycle to the caller.
 *
 * Returns `{ ok, healed, unhealed }`. `ok: true` means every violation
 * was fixed and the graph is now coherent; `false` means at least one
 * violation remained unresolved.
 */

import type { DesignGraph } from "./design-graph.js";
import { designCoherence } from "./design-coherence.js";

export interface HealReport {
  ok: boolean;
  /** Per-violation tags identifying what got fixed: `<kind>:<name>`. */
  healed: string[];
  /** Per-violation tags identifying what remained unresolved. */
  unhealed: string[];
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

export async function healStructureCoherence(
  graph: DesignGraph,
): Promise<HealReport> {
  const healed: string[] = [];
  const unhealed: string[] = [];
  const report = await designCoherence(graph);
  if (report.ok) return { ok: true, healed: [], unhealed: [] };
  for (const v of report.violations) {
    const tag = v.phantomName
      ? `${v.kind}:${v.name}:${v.phantomName}`
      : `${v.kind}:${v.name}`;
    // A prior heal may have already removed the phantom as a
    // side-effect (removeFunction cleans up sibling deps). Skip
    // silently — the violation is resolved by the earlier action,
    // just not in the stale report.
    if (!graph.getFunction(v.module, v.name)) {
      healed.push(tag);
      continue;
    }
    if (v.kind === "cycle") {
      unhealed.push(tag);
      continue;
    }
    if (v.kind === "phantom-dep") {
      if (!v.phantomName) {
        unhealed.push(tag);
        continue;
      }
      const ok = await healPhantomDep(graph, v.module, v.name, v.phantomName);
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
