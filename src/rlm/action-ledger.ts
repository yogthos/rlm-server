/**
 * Action ledger — an append-only one-line-per-transition record of what
 * the loop did. The last N lines get re-injected into the next generate
 * prompt so the model has cheap working memory of its own recent actions.
 *
 * Ported in spirit from openwolf's memory.md.
 */

export interface LedgerEntry {
  iter: number;
  state: string;
  summary: string;
  tsMs?: number;
}

export type Ledger = readonly LedgerEntry[];

export function createLedger(): Ledger {
  return [];
}

export function appendLedger(prev: Ledger, entry: LedgerEntry): Ledger {
  const stamped: LedgerEntry = {
    tsMs: entry.tsMs ?? Date.now(),
    ...entry,
  };
  return [...prev, stamped];
}

/**
 * Render the last `window` entries as a compact block suitable for
 * injection into a user turn. Returns empty string when the ledger is
 * empty.
 */
export function renderRecent(ledger: Ledger, window: number): string {
  if (ledger.length === 0) return "";
  const slice = ledger.slice(-Math.max(1, window));
  const rows = slice.map(
    (e) => `| iter=${e.iter} | ${e.state} | ${e.summary}`,
  );
  return ["RECENT ACTIONS:", ...rows].join("\n");
}
