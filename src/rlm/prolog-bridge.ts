/**
 * Tau Prolog bridge for the RLM sandbox.
 *
 * Host-side: `prologQuery()` creates sessions and runs queries.
 * Sandbox-side: `PROLOG_IMPL` injectable string wraps `__prologBridge`.
 *
 * Adapted from chiasmus/src/solvers/prolog-solver.ts.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — tau-prolog has no bundled types; we declare them in tau-prolog.d.ts
import pl from "tau-prolog";
import type { PrologResult } from "./types.js";

type PrologSession = ReturnType<typeof pl.create>;

const MAX_ANSWERS = 1000;
const DEFAULT_MAX_INFERENCES = 100_000;
const MAX_TRACE_ENTRIES = 500;

// Tau Prolog is callback-based; wrap in promises.

function consult(session: PrologSession, program: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.consult(program, {
      success: () => resolve(),
      error: (err: unknown) => reject(err),
    });
  });
}

function query(session: PrologSession, goal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.query(goal, {
      success: () => resolve(),
      error: (err: unknown) => reject(err),
    });
  });
}

function nextAnswer(
  session: PrologSession,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    session.answer({
      success: (ans: unknown) => resolve(ans as Record<string, unknown>),
      fail: () => resolve(null),
      error: (err: unknown) => reject(err),
      limit: () => reject(new Error("inference limit exceeded")),
    });
  });
}

/**
 * Instrument a Prolog program for derivation tracing.
 * Rewrites each rule `head :- body.` to `head :- body, assertz(trace_goal(head)).`
 */
function instrumentForTracing(program: string): string {
  const parts: string[] = [":- dynamic(trace_goal/1).\n\n"];
  let pos = 0;
  const len = program.length;

  while (pos < len) {
    // Skip whitespace
    const wsStart = pos;
    while (pos < len && /\s/.test(program[pos])) pos++;
    if (pos > wsStart) parts.push(program.slice(wsStart, pos));
    if (pos >= len) break;

    // Skip line comments
    if (program[pos] === "%") {
      const nlIdx = program.indexOf("\n", pos);
      if (nlIdx === -1) {
        parts.push(program.slice(pos));
        break;
      }
      parts.push(program.slice(pos, nlIdx + 1));
      pos = nlIdx + 1;
      continue;
    }

    // Scan a clause to the next period at depth 0
    const clauseStart = pos;
    let depth = 0;
    let inQuote = false;

    while (pos < len) {
      const ch = program[pos];

      if (inQuote) {
        if (ch === "\\") {
          pos += 2;
          continue;
        }
        if (ch === "'") {
          if (pos + 1 < len && program[pos + 1] === "'") {
            pos += 2;
            continue;
          }
          inQuote = false;
        }
        pos++;
        continue;
      }

      if (ch === "'") {
        inQuote = true;
        pos++;
        continue;
      }
      if (ch === "%") {
        const nlIdx = program.indexOf("\n", pos);
        if (nlIdx === -1) {
          pos = len;
          break;
        }
        pos = nlIdx + 1;
        continue;
      }
      if (ch === "(") {
        depth++;
        pos++;
        continue;
      }
      if (ch === ")") {
        depth--;
        pos++;
        continue;
      }

      if (ch === "." && depth === 0) {
        // Skip decimal literals like 3.14
        const prevCh = pos > 0 ? program[pos - 1] : "";
        const nextCh = pos + 1 < len ? program[pos + 1] : "";
        if (prevCh >= "0" && prevCh <= "9" && nextCh >= "0" && nextCh <= "9") {
          pos++;
          continue;
        }
        pos++;
        const clause = program.slice(clauseStart, pos).trim();

        if (clause.startsWith(":-")) {
          parts.push(clause + "\n");
          break;
        }

        const neckIdx = findNeck(clause);
        if (neckIdx >= 0) {
          const head = clause.slice(0, neckIdx).trim();
          const body = clause.slice(neckIdx + 2, -1).trim();
          parts.push(`${head} :- ${body}, assertz(trace_goal(${head})).\n`);
        } else {
          parts.push(clause + "\n");
        }
        break;
      }

      pos++;
    }

    if (pos >= len && program.slice(clauseStart, pos).trim()) {
      parts.push(program.slice(clauseStart));
    }
  }

  return parts.join("").trim();
}

function findNeck(clause: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < clause.length - 1; i++) {
    const ch = clause[i];
    if (inQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'" && clause[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      continue;
    }
    if (ch === "%") {
      const nl = clause.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === ":" && clause[i + 1] === "-" && depth === 0) {
      return i;
    }
  }
  return -1;
}

function formatError(session: PrologSession, err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return (session as any).format_answer(err) || String(err);
  } catch {
    return String(err);
  }
}

export interface PrologOptions {
  maxAnswers?: number;
  maxInferences?: number;
  trace?: boolean;
}

/**
 * Query a Prolog program.
 *
 * @param program - Prolog facts and rules.
 * @param goal - Query goal (e.g. "parent(tom, X).").
 * @param options - Optional: maxAnswers, maxInferences, trace.
 */
export async function prologQuery(
  program: string,
  goal: string,
  options: PrologOptions = {},
): Promise<PrologResult> {
  const explain = options.trace ?? false;
  const inferenceBudget = options.maxInferences ?? DEFAULT_MAX_INFERENCES;
  const maxAns = options.maxAnswers ?? MAX_ANSWERS;

  const instrumentedProgram = explain ? instrumentForTracing(program) : program;
  const session = pl.create(inferenceBudget);

  try {
    await consult(session, instrumentedProgram);
  } catch (e: unknown) {
    return { status: "error", error: formatError(session, e) };
  }

  try {
    await query(session, goal);
  } catch (e: unknown) {
    return { status: "error", error: formatError(session, e) };
  }

  const answers: Array<{ bindings: Record<string, string>; formatted: string }> = [];
  try {
    for (let i = 0; i < maxAns; i++) {
      const ans = await nextAnswer(session);
      if (ans === null) break;

      const bindings: Record<string, string> = {};
      const links = (ans as any).links;
      if (links) {
        for (const [name, term] of Object.entries(links)) {
          bindings[name] =
            (term as any).toString?.() ?? (term as any).id ?? String(term);
        }
      }

      const formatted = pl.format_answer(ans as any) ?? "";
      answers.push({ bindings, formatted });
    }
  } catch (e: unknown) {
    return { status: "error", error: formatError(session, e) };
  }

  // Collect derivation trace if explain mode is on
  if (explain) {
    try {
      await query(session, "trace_goal(X).");
      const trace: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < MAX_TRACE_ENTRIES; i++) {
        const t = await nextAnswer(session);
        if (t === null) break;
        const links = (t as any).links;
        if (links?.X) {
          const entry = (links.X as any).toString?.() ?? String(links.X);
          if (!seen.has(entry)) {
            seen.add(entry);
            trace.push(entry);
          }
        }
      }
      return { status: "success", answers, trace };
    } catch {
      return { status: "success", answers };
    }
  }

  return {
    status: "success",
    answers,
    exhausted: answers.length < maxAns,
  };
}

/**
 * Injectable string for the sandbox VM.
 * Requires `__prologBridge` async function in the VM context.
 */
export const PROLOG_IMPL = `
async function prolog(program, goal, options) {
  return await __prologBridge(program, goal, options || {});
}
`;
