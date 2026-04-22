/**
 * Post-leaf-up cleanup / tightening pass.
 *
 * After pass 2 (leaf-up build), every function has a body and tests
 * green (or is blocked). The call graph observed in the BODIES may
 * diverge from the planned spec.dependencies:
 *
 *   - `body-orphan`: function exists in the graph, passed its tests,
 *     but no other body's `ctx.fns.<name>(...)` call reaches it
 *     (directly or transitively from entry points). The decomposition
 *     created a helper the assembly never wires in. Integration tests
 *     won't exercise it either.
 *
 *   - `unused-dep`: spec.dependencies lists X, but the body never
 *     calls `ctx.fns.X`. Harmless at runtime but misleading for
 *     reviewers and the coherence graph.
 *
 *   - `arity-mismatch`: body calls `ctx.fns.X(ctx, a, b)` but X is
 *     declared as `(ctx, a, b, c)` — three user params, call-site
 *     passes two. Sporulator-style edge sig-compat: flags clearly-
 *     wrong call sites independent of TypeScript's lenient mode.
 *     Doesn't catch type mismatches (those need real type inference)
 *     but catches structural drift that survives tsc's `strict: false`.
 *
 * This pass is PURE analysis — no automatic repair. Callers (the
 * integration orchestrator, a tightening sub-pass, or the user) decide
 * what to do: delete orphans, ask the architect to wire them in, or
 * ignore and trust the integration loop to surface the gap.
 *
 * Entry points for the reachability walk = functions with `parent ===
 * null` (top-level planned functions). These are the external call
 * surface; everything else should be reachable from one of them.
 */

import type { DesignGraph } from "./design-graph.js";
import type { DispatchResult } from "./dispatch-types.js";
import { analyzeSource } from "./body-analyzer.js";
import { debug } from "./debug.js";

export type CleanupFindingKind = "body-orphan" | "unused-dep";

export interface CleanupFinding {
  kind: CleanupFindingKind;
  module: string;
  name: string;
  /** For `unused-dep`: the callee name. */
  dep?: string;
  detail: string;
}

export interface CleanupReport {
  ok: boolean;
  findings: CleanupFinding[];
  /** Entry points used as the BFS root set. */
  entryPoints: string[];
  /** Names reachable from any entry point via observed body calls. */
  reachable: string[];
}

interface CallSiteDetail {
  name: string; // callee
  userArgCount: number;
  line: number;
}

interface BodyCallInfo {
  names: Set<string>; // callee names, for dep/reachability checks
  sites: CallSiteDetail[]; // per-call-site, for arity checks
}

async function collectObservedCalls(
  graph: DesignGraph,
): Promise<Map<string, BodyCallInfo>> {
  const knownSiblings = new Set(graph.listFunctions().map((f) => f.name));
  const candidates = graph
    .listFunctions()
    .filter((fn) => fn.implementation !== null);
  // Phase U8 — post-refactor, each function's `analyzedCallees` /
  // `analyzedImports` were written by `ingestBodyEdges` at save time.
  // Prefer that pre-computed data; re-parse only when it's empty (a
  // leaf function saved before the analyzer landed, or a body-only
  // implementation). Arity (userArgCount) is no longer tracked — the
  // arity-drift check is redundant now that the TypeScript compiler
  // validates the signature at tsc time.
  const results = await Promise.all(
    candidates.map(async (fn) => {
      const names = new Set<string>(fn.analyzedCallees ?? []);
      const sites: CallSiteDetail[] = [];
      // Fallback 1 — parse the stored implementation with the natural
      // analyzer (catches bodies written before ingestBodyEdges ran, or
      // test fixtures that set implementation but didn't analyze).
      if (names.size === 0 && fn.implementation) {
        try {
          const analysis = await analyzeSource(fn.implementation);
          for (const imp of analysis.imports) {
            const m = imp.source.match(/^\.\/(.+?)(?:\.js|\.ts)?$/);
            if (!m) continue;
            if (knownSiblings.has(m[1])) names.add(m[1]);
          }
        } catch (e) {
          debug(
            "cleanup",
            `analyzeSource threw for ${fn.name} (${e instanceof Error ? e.message : String(e)}); treating as leaf`,
          );
        }
      }
      for (const n of names) {
        sites.push({ name: n, userArgCount: -1, line: 0 });
      }
      return { name: fn.name, info: { names, sites } as BodyCallInfo };
    }),
  );
  const calls = new Map<string, BodyCallInfo>();
  for (const r of results) calls.set(r.name, r.info);
  return calls;
}

export async function designCleanup(
  graph: DesignGraph,
): Promise<CleanupReport> {
  const fns = graph.listFunctions();
  const byName = new Map(fns.map((f) => [f.name, f] as const));
  const observedMap = await collectObservedCalls(graph);
  // Backwards-compat view for the rest of the function — existing
  // reachability + unused-dep checks only need the callee-name set.
  const observed = new Map<string, Set<string>>();
  for (const [k, v] of observedMap) observed.set(k, v.names);
  // Entry points — top-level planned functions (no decomposition parent).
  const entryPoints = fns
    .filter((f) => f.parent === null)
    .map((f) => f.name)
    .sort();
  // BFS reachable closure from all entry points.
  const reachable = new Set<string>();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const callee of observed.get(cur) ?? []) {
      if (byName.has(callee) && !reachable.has(callee)) queue.push(callee);
    }
  }
  const findings: CleanupFinding[] = [];
  // body-orphan: function has a body, isn't in the reachable set, and
  // isn't itself an entry point (root). Excludes entry points because
  // they're unreachable by definition (nothing calls them externally).
  for (const f of fns) {
    if (f.parent === null) continue;
    if (f.implementation === null) continue;
    if (reachable.has(f.name)) continue;
    findings.push({
      kind: "body-orphan",
      module: f.module,
      name: f.name,
      detail: `Function "${f.name}" has a body but no other function's call chain reaches it from an entry point. The assembly doesn't wire it in. Either update a caller to invoke it, or drop it from the plan.`,
    });
  }
  // unused-dep: spec lists X, body doesn't call ctx.fns.X.
  for (const f of fns) {
    if (f.implementation === null || !f.spec) continue;
    const actualCalls = observed.get(f.name) ?? new Set<string>();
    for (const dep of f.spec.dependencies) {
      if (actualCalls.has(dep)) continue;
      if (!byName.has(dep)) continue; // phantom — coherence handled it
      findings.push({
        kind: "unused-dep",
        module: f.module,
        name: f.name,
        dep,
        detail: `spec.dependencies of "${f.name}" lists "${dep}", but the body never calls ctx.fns.${dep}. Either drop the dep or use it.`,
      });
    }
  }
  // Phase U8 — arity-mismatch check retired. It was a ctx.fns-era
  // sporulator-inspired edge check comparing `ctx.fns.X(ctx, ...args)`
  // call-site arity against X's declared params. Under natural mode,
  // siblings are imported directly and TypeScript's compiler catches
  // arity mismatches at tsc time. No runtime heuristic needed.
  debug(
    "cleanup",
    `post-leaf-up cleanup: ${findings.length} finding(s) (${findings.map((f) => f.kind).join(", ")})`,
  );
  return {
    ok: findings.length === 0,
    findings,
    entryPoints,
    reachable: [...reachable].sort(),
  };
}

export type FixDispatch = (
  graph: DesignGraph,
  module: string,
  name: string,
  opts?: { feedback?: string; projectDir?: string },
) => Promise<DispatchResult>;

export interface AutoRepairReport {
  /** Function names whose fix-dispatch returned tests-green. */
  repaired: string[];
  /** Function names whose fix-dispatch failed / stagnated. */
  failed: string[];
}

/**
 * Basic auto-repair for cleanup findings. Groups findings by the
 * function that needs to be re-dispatched:
 *
 *   - `body-orphan X` → re-dispatch X's decomposition parent with
 *     feedback "wire in ctx.fns.X or drop it."
 *   - `unused-dep (X, Y)` → re-dispatch X with feedback "spec lists
 *     Y but body doesn't call it; drop or use."
 *
 * One dispatch per target function per invocation (findings pointing
 * at the same target share a single dispatch with combined feedback).
 * No retry/bounding beyond that — if fix dispatch doesn't resolve,
 * the integration loop will surface the remaining failures. Keeps
 * the pipeline forward-moving rather than iterating on the same
 * functions indefinitely.
 */
export async function autoRepairCleanup(
  graph: DesignGraph,
  findings: CleanupFinding[],
  dispatch: FixDispatch,
): Promise<AutoRepairReport> {
  const targets = new Map<
    string,
    { module: string; name: string; messages: string[] }
  >();
  for (const f of findings) {
    if (f.kind === "body-orphan") {
      // Target = the orphan's decomposition parent (the function
      // whose body needs to wire in the orphan).
      const orphan = graph.listFunctions().find((x) => x.name === f.name);
      if (!orphan?.parent) continue;
      const parent = graph
        .listFunctions()
        .find((x) => x.name === orphan.parent);
      if (!parent) continue;
      const key = `${parent.module}#${parent.name}`;
      if (!targets.has(key)) {
        targets.set(key, {
          module: parent.module,
          name: parent.name,
          messages: [],
        });
      }
      targets.get(key)!.messages.push(
        `Cleanup: child function "${f.name}" has a green body but your body doesn't call ctx.fns.${f.name} — wire it into your assembly or drop "${f.name}" from the plan.`,
      );
    } else if (f.kind === "unused-dep" && f.dep) {
      // Target = the caller whose spec lists the unused dep.
      const key = `${f.module}#${f.name}`;
      if (!targets.has(key)) {
        targets.set(key, { module: f.module, name: f.name, messages: [] });
      }
      targets.get(key)!.messages.push(
        `Cleanup: spec.dependencies lists "${f.dep}" but your body doesn't import or call ${f.dep} — drop the dep or call it.`,
      );
    }
  }
  const repaired: string[] = [];
  const failed: string[] = [];
  for (const { module, name, messages } of targets.values()) {
    debug(
      "cleanup",
      `auto-repair dispatch ${name} — ${messages.length} finding(s)`,
    );
    let result: DispatchResult;
    try {
      result = await dispatch(graph, module, name, {
        feedback: messages.join("\n\n"),
      });
    } catch (e) {
      debug(
        "cleanup",
        `${name} repair threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      failed.push(name);
      continue;
    }
    if (result.status === "tests-green") repaired.push(name);
    else failed.push(name);
  }
  return { repaired, failed };
}
