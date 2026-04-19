/**
 * Spec checklist — parses enumerated requirements out of the user prompt,
 * keeps them as a small structured list the loop can re-inject each turn,
 * and heuristically marks items as satisfied by scanning produced artifacts.
 *
 * Ported in spirit from openwolf's anatomy.md + OPENWOLF.md re-injection:
 * the model always sees the remaining items, so it cannot quietly drop them
 * as the spec scrolls out of its context window.
 */

export interface SpecItem {
  id: string;        // "1", "2", "4.a", "4.b" …
  text: string;
  status: "open" | "done";
}

const SUB_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Extract enumerated requirements from a prompt.
 *
 * Heuristic recognizes:
 *   - Top-level numbered lines: `^\d+\. `
 *   - Sub-bullets under a top-level item: indented `-` or `*`
 *
 * Sub-bullets become `4.a`, `4.b`, … so the enclosing item stays a distinct
 * bucket and sub-items can still be marked done independently.
 */
export function parseSpec(prompt: string): SpecItem[] {
  const items: SpecItem[] = [];
  const lines = prompt.split("\n");

  let currentParent: string | null = null;
  let subLetterIdx = 0;

  for (const raw of lines) {
    const topMatch = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(raw);
    if (topMatch) {
      const [, id, text] = topMatch;
      currentParent = id;
      subLetterIdx = 0;
      // Strip trailing `:` and inline markers so list-intros stay readable.
      items.push({ id, text: cleanText(text), status: "open" });
      continue;
    }
    const subMatch = /^\s+[-*]\s+(.+?)\s*$/.exec(raw);
    if (subMatch && currentParent) {
      const [, text] = subMatch;
      const letter = SUB_LETTERS[subLetterIdx] ?? String(subLetterIdx);
      subLetterIdx++;
      items.push({
        id: `${currentParent}.${letter}`,
        text: cleanText(text),
        status: "open",
      });
      continue;
    }
    // Blank line or unrelated prose — don't reset parent; sub-bullets can
    // follow a blank line in some prompts.
  }

  return items;
}

function cleanText(t: string): string {
  return t.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Compact block listing only open items, designed to be prepended to the
 * environment-feedback user turn so it re-enters the context each cycle.
 */
export function renderChecklist(items: SpecItem[]): string {
  const open = items.filter((i) => i.status === "open");
  if (open.length === 0) return "";
  const lines = open.map((i) => `  [${i.id}] ${i.text}`);
  return ["REMAINING SPEC ITEMS:", ...lines].join("\n");
}

/**
 * Heuristic: mark items `done` when distinctive tokens from their text
 * appear in the artifact. Distinctive = anything that isn't a stopword
 * and isn't generic filler. Items whose texts produce *no* distinctive
 * tokens stay open — we'd rather leave a true-positive unmarked than
 * auto-accept a fake.
 */
export function markSatisfied(items: SpecItem[], artifact: string): SpecItem[] {
  const hay = artifact.toLowerCase();
  return items.map((item) => {
    if (item.status === "done") return item;
    const { strong, weak } = distinctiveTokens(item.text);

    // Prefer strong tokens: any single hit is enough. Strong tokens are
    // paths, HTTP methods+paths, quoted literals, status codes, known
    // technical keywords — if the artifact contains even one, the item
    // is almost certainly addressed.
    if (strong.length > 0) {
      const strongHit = strong.some((t) => hay.includes(t.toLowerCase()));
      return strongHit ? { ...item, status: "done" as const } : item;
    }

    // Items without strong tokens need most of their weak tokens present.
    if (weak.length === 0) return item; // no signal → stay conservative
    const hits = weak.filter((t) => hay.includes(t.toLowerCase())).length;
    const threshold = Math.max(2, Math.ceil(weak.length * 0.6));
    return hits >= threshold ? { ...item, status: "done" as const } : item;
  });
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for",
  "with", "from", "by", "as", "is", "are", "be", "this", "that", "these",
  "those", "it", "its", "should", "must", "will", "can", "may", "one",
  "some", "all", "any", "each", "every", "no", "not", "into", "out",
  "up", "down", "over", "under", "per", "via", "about", "if", "then",
  "else", "when", "while", "etc",
  // Generic filler frequent in prompts
  "module", "modules", "npm", "package", "file", "files", "code",
  "using", "use", "used", "serves", "serves", "create", "created",
  "creates", "creating", "return", "returns", "returning", "provide",
  "provides", "accepts", "accepted", "accept", "work", "works", "well",
  "page", "pages", "line", "lines", "value", "values",
]);

interface TokenSet {
  strong: string[];
  weak: string[];
}

function distinctiveTokens(text: string): TokenSet {
  const strong = new Set<string>();
  const weak = new Set<string>();

  // Quoted strings — usually meaningful (e.g. "guestbook.db")
  for (const m of text.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) {
    const q = m[1] ?? m[2] ?? m[3];
    if (q) strong.add(q);
  }
  // Standalone paths (e.g. "/api/entries", "/sign") — also covers the tail
  // half of a "POST /sign" phrase.
  for (const m of text.matchAll(/\/[a-zA-Z][\w./-]*/g)) {
    strong.add(m[0]);
  }
  // HTTP status codes and other ≥3-digit numbers — e.g. "400", "3001"
  for (const m of text.matchAll(/\b\d{3,}\b/g)) {
    strong.add(m[0]);
  }
  // Well-known technical keywords
  for (const m of text.matchAll(/\b(?:SQLite|JSON|HTML|CSS|HTTP|ISO|SHA\d*|better-sqlite3|UTF-?8)\b/gi)) {
    strong.add(m[0]);
  }
  // Dotted identifiers (`guestbook.db`, `better-sqlite3`, `api.entries`)
  for (const m of text.matchAll(/[a-zA-Z][\w.-]*\.[a-zA-Z][\w.-]*/g)) {
    strong.add(m[0]);
  }

  // Multi-letter words that are neither stopwords nor 2–3-char fillers
  // contribute as weak support only.
  for (const w of text.split(/\s+/)) {
    const norm = w.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
    if (norm.length < 4) continue;
    if (STOPWORDS.has(norm)) continue;
    weak.add(norm);
  }

  return {
    strong: Array.from(strong).filter((t) => t.length > 0),
    weak: Array.from(weak).filter((t) => t.length > 0),
  };
}
