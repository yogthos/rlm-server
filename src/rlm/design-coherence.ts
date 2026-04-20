/**
 * Post-sketch coherence analysis. After Phase 3 writes a body for every
 * function, this pass asks: does the call graph hold together? Four
 * classes of structural mismatch are detected via Prolog:
 *
 *   - orphan: function defined but no other function calls it, and
 *     it's not a top-level root (so nothing reaches it).
 *   - undeclared-call: body calls X, but X isn't in spec.dependencies.
 *   - unused-dep: spec lists X in dependencies, but the body never
 *     calls ctx.fns.X.
 *   - dangling-call: body calls X, but X isn't a defined function.
 *
 * Returns a `CoherenceReport` listing violations the caller can fix via
 * targeted re-dispatches. Pure analysis — does not mutate the graph.
 */

import type { DesignGraph } from "./design-graph.js";
import { analyzeBody } from "./body-analyzer.js";
import { prologQuery } from "./prolog-bridge.js";
import { debug } from "./debug.js";

export type CoherenceViolationKind =
  | "orphan"
  | "undeclared-call"
  | "unused-dep"
  | "dangling-call";

export interface CoherenceViolation {
  kind: CoherenceViolationKind;
  /** Module of the affected function. */
  module: string;
  /** Name of the affected function. */
  name: string;
  /** Human-readable explanation, suitable for prompt feedback. */
  detail: string;
}

export interface CoherenceReport {
  ok: boolean;
  violations: CoherenceViolation[];
}

function toProlog(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Build the Prolog fact-base describing the graph's observed call
 * structure. `fn/1` for every function, `calls/2` for each observed
 * ctx.fns call site, `declared_dep/2` for each spec.dependencies
 * entry, `root/1` for functions with no parent in the decomposition
 * tree AND no caller (treated as entry points).
 */
async function buildCoherenceFacts(graph: DesignGraph): Promise<string> {
  const fns = graph.listFunctions();
  const lines: string[] = [];
  // Observed calls from each implemented body. Collected into a map
  // so reachability (BFS) can be computed imperatively — Prolog
  // left-recursion on reachable/1 loops in tau-prolog.
  const adjacency = new Map<string, Set<string>>();
  for (const fn of fns) {
    if (fn.implementation === null) continue;
    const analysis = await analyzeBody(fn.implementation);
    const distinct = new Set(analysis.ctxFnsCalls.map((c) => c.name));
    if (distinct.size > 0) adjacency.set(fn.name, distinct);
  }
  // Roots: functions with no parent in the decomposition tree AND
  // no observed caller. These are the entry points nothing "falls
  // back to" — they must exist outside the call tree.
  const calledSet = new Set<string>();
  for (const callees of adjacency.values()) {
    for (const c of callees) calledSet.add(c);
  }
  const roots = new Set<string>();
  for (const fn of fns) {
    if (fn.parent === null && !calledSet.has(fn.name)) roots.add(fn.name);
  }
  // BFS reachability from roots.
  const reachable = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const nxt of adjacency.get(cur) ?? []) {
      if (!reachable.has(nxt)) queue.push(nxt);
    }
  }

  // Emit facts — pure ground facts, no rules. This side-steps tau-
  // prolog's fragile left-recursion handling; Prolog here is used
  // only for its pattern-matching + negation semantics.
  for (const fn of fns) {
    lines.push(`fn(${toProlog(fn.name)}).`);
  }
  for (const [caller, callees] of adjacency) {
    for (const callee of callees) {
      lines.push(`calls(${toProlog(caller)}, ${toProlog(callee)}).`);
    }
  }
  for (const fn of fns) {
    if (!fn.spec) continue;
    for (const dep of fn.spec.dependencies) {
      lines.push(
        `declared_dep(${toProlog(fn.name)}, ${toProlog(dep)}).`,
      );
    }
  }
  for (const r of reachable) {
    lines.push(`reachable(${toProlog(r)}).`);
  }
  // Dynamic declarations so queries referencing an empty predicate
  // don't trip an existence_error.
  lines.push(
    "",
    ":- dynamic(fn/1).",
    ":- dynamic(calls/2).",
    ":- dynamic(declared_dep/2).",
    ":- dynamic(reachable/1).",
  );
  return lines.join("\n");
}

async function queryNames(program: string, goal: string): Promise<string[]> {
  try {
    const result = await prologQuery(program, goal, { maxAnswers: 200 });
    if (result.status !== "success" || !result.answers) return [];
    const out = new Set<string>();
    for (const a of result.answers) {
      const x = a.bindings.X ?? a.bindings.x;
      if (typeof x !== "string") continue;
      out.add(x.replace(/^'/, "").replace(/'$/, ""));
    }
    return [...out];
  } catch (e) {
    debug(
      "coherence",
      `prolog threw (${e instanceof Error ? e.message : String(e)})`,
    );
    return [];
  }
}

async function queryPairs(
  program: string,
  goal: string,
): Promise<Array<{ caller: string; dep: string }>> {
  try {
    const result = await prologQuery(program, goal, { maxAnswers: 500 });
    if (result.status !== "success" || !result.answers) return [];
    const pairs: Array<{ caller: string; dep: string }> = [];
    for (const a of result.answers) {
      const c = a.bindings.C ?? a.bindings.c;
      const d = a.bindings.D ?? a.bindings.d;
      if (typeof c !== "string" || typeof d !== "string") continue;
      pairs.push({
        caller: c.replace(/^'/, "").replace(/'$/, ""),
        dep: d.replace(/^'/, "").replace(/'$/, ""),
      });
    }
    return pairs;
  } catch (e) {
    debug(
      "coherence",
      `prolog threw (${e instanceof Error ? e.message : String(e)})`,
    );
    return [];
  }
}

export async function designCoherence(
  graph: DesignGraph,
): Promise<CoherenceReport> {
  const fns = graph.listFunctions();
  const fnByName = new Map(fns.map((f) => [f.name, f] as const));
  const program = await buildCoherenceFacts(graph);
  const violations: CoherenceViolation[] = [];

  // 1. Orphans — defined, not reachable from any root.
  const orphanGoal = "fn(X), \\+ reachable(X).";
  const orphanNames = await queryNames(program, orphanGoal);
  for (const n of orphanNames) {
    const fn = fnByName.get(n);
    if (!fn) continue;
    violations.push({
      kind: "orphan",
      module: fn.module,
      name: n,
      detail: `Function "${n}" is defined but no other function calls it, and it's not a top-level entry point. Either wire it into the call graph or remove it.`,
    });
  }

  // 2. Undeclared calls — calls(C, D) but no declared_dep(C, D).
  const undeclaredGoal =
    "calls(C, D), fn(D), \\+ declared_dep(C, D).";
  const undeclaredPairs = await queryPairs(program, undeclaredGoal);
  for (const { caller, dep } of undeclaredPairs) {
    const fn = fnByName.get(caller);
    if (!fn) continue;
    violations.push({
      kind: "undeclared-call",
      module: fn.module,
      name: caller,
      detail: `Body of "${caller}" calls ctx.fns.${dep} but "${dep}" isn't in spec.dependencies. Either add it to the spec or remove the call.`,
    });
  }

  // 3. Unused declared deps — declared_dep(C, D) but no calls(C, D).
  const unusedGoal =
    "declared_dep(C, D), \\+ calls(C, D).";
  const unusedPairs = await queryPairs(program, unusedGoal);
  for (const { caller, dep } of unusedPairs) {
    const fn = fnByName.get(caller);
    if (!fn) continue;
    violations.push({
      kind: "unused-dep",
      module: fn.module,
      name: caller,
      detail: `spec.dependencies of "${caller}" lists "${dep}", but the body never calls ctx.fns.${dep}. Either call it or drop the declared dependency.`,
    });
  }

  // 4. Dangling calls — calls(C, X) but no fn(X).
  const danglingGoal = "calls(C, D), \\+ fn(D).";
  const danglingPairs = await queryPairs(program, danglingGoal);
  for (const { caller, dep } of danglingPairs) {
    const fn = fnByName.get(caller);
    if (!fn) continue;
    violations.push({
      kind: "dangling-call",
      module: fn.module,
      name: caller,
      detail: `Body of "${caller}" calls ctx.fns.${dep} but "${dep}" isn't defined anywhere in the graph. Either define it or remove the call.`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
