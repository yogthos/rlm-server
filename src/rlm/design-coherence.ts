/**
 * Pre-build structural coherence check on the design graph.
 *
 * Round 17 replaces the body-based coherence (which required every
 * function to have an implementation) with a pure structural check
 * that operates on `spec.dependencies`. Runs BEFORE leaf-up build
 * to catch designs that can't possibly assemble:
 *
 *   - `phantom-dep`: a spec lists a dependency whose name isn't in
 *     the graph. Was `dangling-call` under the old scheme; now
 *     caught at the spec layer instead of the body layer.
 *   - `cycle`: a dependency cycle. Leaf-up build can't level the
 *     graph with cycles, so this is a hard error.
 *
 * Orphan detection was removed: decomposition children (parent !==
 * null) are wired via the tree link — `computeDependencyLevels` unions
 * spec.deps with tree-children, and the implementer prompt lists
 * `fn.children` directly. The prior orphan heal burned LLM calls
 * patching spec.deps that nothing reads (run 9: 24 false-positive
 * cycle-reverts).
 *
 * Dropped vs. old coherence:
 *   - `undeclared-call` (body calls X but spec doesn't list it):
 *     caught implicitly by leaf-up build — the body's unit tests
 *     fail because ctx.fns.X isn't wired when spec doesn't declare
 *     the dep.
 *   - `unused-dep` (spec lists X but body never calls it): caught
 *     by architect review post-implementation.
 *
 * Pure analysis — does not mutate the graph.
 */

import type { DesignGraph } from "./design-graph.js";
import { debug } from "./debug.js";

export type CoherenceViolationKind = "phantom-dep" | "cycle";

export interface CoherenceViolation {
  kind: CoherenceViolationKind;
  module: string;
  name: string;
  detail: string;
  /** For `phantom-dep`: the name the spec lists that isn't in the
   *  graph. Lets consumers (e.g., heal) act on the violation without
   *  reparsing `detail`. */
  phantomName?: string;
}

export interface CoherenceReport {
  ok: boolean;
  violations: CoherenceViolation[];
}

function detectCycles(
  fns: ReturnType<DesignGraph["listFunctions"]>,
  depsByName: Map<string, string[]>,
): string[][] {
  // DFS with a recursion stack; return the cycle path when hit.
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (n: string): void => {
    if (visited.has(n)) return;
    if (visiting.has(n)) {
      const startIdx = stack.indexOf(n);
      cycles.push(stack.slice(startIdx).concat(n));
      return;
    }
    visiting.add(n);
    stack.push(n);
    for (const d of depsByName.get(n) ?? []) visit(d);
    stack.pop();
    visiting.delete(n);
    visited.add(n);
  };
  for (const f of fns) visit(f.name);
  return cycles;
}

export async function designCoherence(
  graph: DesignGraph,
): Promise<CoherenceReport> {
  const fns = graph.listFunctions();
  const fnByName = new Map(fns.map((f) => [f.name, f] as const));
  const names = new Set(fns.map((f) => f.name));
  const violations: CoherenceViolation[] = [];

  // Build dep edges (real only — phantoms get their own violation).
  const depsByName = new Map<string, string[]>();
  const calledSet = new Set<string>();
  for (const f of fns) {
    const declared = f.spec?.dependencies ?? [];
    const real: string[] = [];
    for (const d of declared) {
      if (!names.has(d)) {
        violations.push({
          kind: "phantom-dep",
          module: f.module,
          name: f.name,
          detail: `spec.dependencies of "${f.name}" lists "${d}", but "${d}" isn't defined anywhere in the graph. Either declare "${d}" as a function or drop the dependency.`,
          phantomName: d,
        });
        continue;
      }
      real.push(d);
      calledSet.add(d);
    }
    depsByName.set(f.name, real);
  }

  // Cycles (hard error — leaf-up build can't proceed).
  const cycles = detectCycles(fns, depsByName);
  for (const cyc of cycles) {
    // Report on the first node in the cycle; include the path.
    const head = fnByName.get(cyc[0]);
    if (!head) continue;
    violations.push({
      kind: "cycle",
      module: head.module,
      name: head.name,
      detail: `dependency cycle: ${cyc.join(" → ")}. Break the cycle by splitting or inlining one of the edges.`,
    });
  }

  // Orphan detection intentionally dropped: decomposition children
  // (parent !== null) are wired via the tree link — `computeDependency
  // Levels` unions spec.deps with tree-children, and the implementer
  // prompt lists `fn.children` directly. Top-level functions are
  // legitimate entry points, so they're not orphans either. The prior
  // flag triggered a heal that burned LLM calls patching spec.deps
  // nothing reads (run 9: 24 false-positive cycle-reverts).

  debug(
    "coherence",
    `structure check: ${violations.length} violation(s) — ${violations.map((v) => v.kind).join(", ")}`,
  );
  return {
    ok: violations.length === 0,
    violations,
  };
}
