/**
 * Failure memory — normalize sandbox/enforcement errors into signatures,
 * track occurrences, and surface hints when the same failure shape recurs.
 *
 * Ported in spirit from openwolf's buglog.json + "read before fix, log
 * after fix" protocol.
 */

export interface FailureEntry {
  signature: string;
  hint: string;
  tags: string[];
  occurrences: number;
  createdAt: number;
}

export type FailureMemory = readonly FailureEntry[];

export function createFailureMemory(): FailureMemory {
  return [];
}

/**
 * Normalize an error message into a signature that compares equal across
 * incidental detail:
 *   - Drop path-like tokens (`/a/b/c.ts`, `C:\foo\bar`)
 *   - Drop line/column numbers (`:12:4`, `line 99`)
 *   - Drop quoted identifiers (`'foo'`, `"bar"`)
 *   - Drop bare multi-digit numbers
 *   - Collapse whitespace
 */
export function signatureOf(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // POSIX and Windows paths
  s = s.replace(/(?:\/|[A-Za-z]:\\)[\w./\\-]+/g, "<path>");
  // line:column suffixes
  s = s.replace(/:\d+:\d+/g, "");
  // "line N", "at line N"
  s = s.replace(/\bline\s+\d+\b/gi, "");
  // quoted identifiers
  s = s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "<id>");
  // dotted identifiers (e.g. `x.foo`, `process.env.PATH`)
  s = s.replace(/\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b/g, "<id>");
  // any remaining standalone multi-digit number
  s = s.replace(/\b\d+\b/g, "<n>");
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function recordFailure(
  mem: FailureMemory,
  raw: string,
  attrs: { hint: string; tags?: string[] },
): FailureMemory {
  const signature = signatureOf(raw);
  if (!signature) return mem;
  const idx = mem.findIndex((e) => e.signature === signature);
  if (idx === -1) {
    return [
      ...mem,
      {
        signature,
        hint: attrs.hint,
        tags: attrs.tags ?? [],
        occurrences: 1,
        createdAt: Date.now(),
      },
    ];
  }
  const updated: FailureEntry = {
    ...mem[idx],
    occurrences: mem[idx].occurrences + 1,
    // Prefer the newer hint only if present — older stays by default.
    hint: attrs.hint || mem[idx].hint,
    tags: attrs.tags ? Array.from(new Set([...mem[idx].tags, ...attrs.tags])) : mem[idx].tags,
  };
  return [...mem.slice(0, idx), updated, ...mem.slice(idx + 1)];
}

/**
 * Return hints for an incoming error — only if we've seen its signature
 * at least twice before. The threshold keeps first-time errors from
 * being pre-injected with irrelevant hints.
 */
export function findHints(mem: FailureMemory, raw: string): FailureEntry[] {
  const signature = signatureOf(raw);
  if (!signature) return [];
  return mem.filter((e) => e.signature === signature && e.occurrences >= 2);
}

export function renderHints(hints: FailureEntry[]): string {
  if (hints.length === 0) return "";
  const lines = hints.map(
    (h) => `  - seen ${h.occurrences}× — hint: ${h.hint}`,
  );
  return ["REPEAT-FAILURE HINTS:", ...lines].join("\n");
}

/**
 * Mutable wrapper around `FailureMemory` so the same store can be shared
 * across recursive sub-RLMs. The functional helpers return new arrays;
 * this class swaps the internal reference on each update so all holders
 * observe every record regardless of recursion depth.
 */
export class FailureMemoryStore {
  private memory: FailureMemory;

  constructor(initial: FailureMemory = createFailureMemory()) {
    this.memory = initial;
  }

  record(raw: string, attrs: { hint: string; tags?: string[] }): void {
    this.memory = recordFailure(this.memory, raw, attrs);
  }

  findHints(raw: string): FailureEntry[] {
    return findHints(this.memory, raw);
  }

  snapshot(): FailureMemory {
    return this.memory;
  }
}

export function createFailureMemoryStore(): FailureMemoryStore {
  return new FailureMemoryStore();
}
