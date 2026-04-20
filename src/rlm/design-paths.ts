/**
 * Call-graph path enumeration.
 *
 * For integration-test coverage we need to know every execution path
 * from a call-graph entry point to a terminal node. `enumeratePaths`
 * walks the graph depth-first from each entry, emitting one `Path`
 * per root-to-leaf chain. Cycles are flagged (`kind: "cyclical"`) and
 * truncated at the first repeat so enumeration terminates.
 *
 * Call edges are derived from `spec.dependencies` when available. If
 * no specs are attached (pre-phase-2), we fall back to the
 * decomposition tree (parent → children) so early callers still get
 * a non-empty result.
 *
 * Entry points are nodes with zero in-edges under the chosen edge
 * relation — i.e., functions no other function calls. This matches
 * `listRoots()` in the common case but is derived mechanically so it
 * stays correct when the decomposition tree disagrees with the call
 * graph.
 */

import type { DesignGraph } from "./design-graph.js";

export type PathKind = "complete" | "cyclical" | "truncated";

export interface Path {
  /** Call chain from entry to terminal. For cyclical paths, the final
   *  node is the one that would have repeated (not included twice). */
  nodes: string[];
  kind: PathKind;
}

export interface EnumeratePathsOptions {
  /** Cap on total paths emitted. On branching-heavy graphs the
   *  enumeration can blow up exponentially (K branches × N depth ⇒
   *  K^N paths). Default 100. A final `truncated` sentinel path is
   *  appended when the cap fires so callers know coverage is partial. */
  maxPaths?: number;
}

function buildAdjacency(graph: DesignGraph): Map<string, string[]> {
  const fns = graph.listFunctions();
  const names = new Set(fns.map((f) => f.name));
  const adj = new Map<string, string[]>();
  // Prefer spec.dependencies. Fall back to decomposition children when
  // no function has a spec (early-pipeline callers).
  const anySpec = fns.some((f) => f.spec !== null);
  if (anySpec) {
    for (const f of fns) {
      const deps = f.spec?.dependencies ?? [];
      // Drop phantom deps (names not in the graph) so enumeration
      // doesn't emit dangling paths. Coherence flags these separately.
      const real = deps.filter((d) => names.has(d));
      adj.set(f.name, real);
    }
  } else {
    for (const f of fns) {
      adj.set(f.name, [...f.children]);
    }
  }
  return adj;
}

function findEntryPoints(
  graph: DesignGraph,
  adj: Map<string, string[]>,
): string[] {
  const inCount = new Map<string, number>();
  for (const f of graph.listFunctions()) inCount.set(f.name, 0);
  for (const [, callees] of adj) {
    for (const c of callees) {
      inCount.set(c, (inCount.get(c) ?? 0) + 1);
    }
  }
  const entries: string[] = [];
  for (const [name, count] of inCount) {
    if (count === 0) entries.push(name);
  }
  // Fallback: a graph with no zero-in-degree node is entirely cyclical
  // (every function is called by someone). Seed DFS with the
  // alphabetically-first node so enumeration still produces a path —
  // it'll be flagged `cyclical` once DFS hits the repeat.
  if (entries.length === 0) {
    const all = [...inCount.keys()].sort();
    if (all.length > 0) entries.push(all[0]);
  }
  entries.sort();
  return entries;
}

export function enumeratePaths(
  graph: DesignGraph,
  options: EnumeratePathsOptions = {},
): Path[] {
  const maxPaths = options.maxPaths ?? 100;
  const adj = buildAdjacency(graph);
  const entries = findEntryPoints(graph, adj);
  const paths: Path[] = [];
  let capped = false;
  const dfs = (node: string, trail: string[], visited: Set<string>) => {
    if (capped) return;
    if (paths.length >= maxPaths) {
      capped = true;
      return;
    }
    if (visited.has(node)) {
      paths.push({ nodes: [...trail, node], kind: "cyclical" });
      return;
    }
    const nextTrail = [...trail, node];
    const nextVisited = new Set(visited);
    nextVisited.add(node);
    const callees = adj.get(node) ?? [];
    if (callees.length === 0) {
      paths.push({ nodes: nextTrail, kind: "complete" });
      return;
    }
    for (const c of callees) {
      if (capped) return;
      dfs(c, nextTrail, nextVisited);
    }
  };
  for (const entry of entries) {
    if (capped) break;
    dfs(entry, [], new Set());
  }
  if (capped) {
    // Sentinel entry lets downstream (integration-test authoring)
    // report partial coverage rather than silently miss paths.
    paths.push({ nodes: ["<truncated>"], kind: "truncated" });
  }
  return paths;
}
