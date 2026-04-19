import { describe, it, expect } from "vitest";
import {
  parseSpec,
  renderChecklist,
  markSatisfied,
  type SpecItem,
} from "../../src/rlm/spec-checklist.js";

const guestbookPrompt = `Build a Node.js guestbook web application with these requirements:

1. A single server.js file using Node.js built-in modules plus the \`better-sqlite3\` npm package for persistence
2. Persist entries in a SQLite database file (guestbook.db)
3. Schema: entries(id INTEGER PK, handle TEXT, message TEXT, created_at INTEGER)
4. HTTP server on port 3001 with these routes:
   - GET / — serves an HTML page
   - POST /sign — accepts form submission
   - GET /api/entries — returns all entries as JSON
5. Handle edge cases: empty handle/message (reject with 400), missing guestbook.db (create)
6. The HTML should be embedded in the JS file
`;

describe("parseSpec", () => {
  it("returns an empty list when the prompt has no enumeration", () => {
    expect(parseSpec("just a vague question")).toEqual([]);
  });

  it("parses top-level numbered items", () => {
    const items = parseSpec(guestbookPrompt);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).toContain("6");
  });

  it("parses indented bullet sub-items with dotted ids", () => {
    const items = parseSpec(guestbookPrompt);
    const ids = items.map((i) => i.id);
    // Item 4 has three route sub-bullets
    expect(ids).toContain("4.a");
    expect(ids).toContain("4.b");
    expect(ids).toContain("4.c");
  });

  it("captures sub-item text without the bullet marker", () => {
    const items = parseSpec(guestbookPrompt);
    const postSign = items.find((i) => i.text.includes("POST /sign"));
    expect(postSign).toBeDefined();
    expect(postSign!.text).not.toMatch(/^-\s/);
  });

  it("initializes every item as open", () => {
    const items = parseSpec(guestbookPrompt);
    expect(items.every((i) => i.status === "open")).toBe(true);
  });

  it("ignores embedded code-fence backticks in item text", () => {
    const items = parseSpec(guestbookPrompt);
    const item1 = items.find((i) => i.id === "1");
    // Distinctive phrase preserved
    expect(item1!.text).toMatch(/better-sqlite3/);
  });
});

describe("renderChecklist", () => {
  it("renders only open items in a compact block", () => {
    const items: SpecItem[] = [
      { id: "1", text: "foo", status: "done" },
      { id: "2", text: "bar", status: "open" },
      { id: "3", text: "baz", status: "open" },
    ];
    const block = renderChecklist(items);
    expect(block).toContain("[2]");
    expect(block).toContain("[3]");
    expect(block).not.toContain("[1]"); // done items omitted
    expect(block.toLowerCase()).toContain("remaining");
  });

  it("returns empty string when all items are done", () => {
    const items: SpecItem[] = [
      { id: "1", text: "foo", status: "done" },
    ];
    expect(renderChecklist(items)).toBe("");
  });

  it("returns empty string when there are no items", () => {
    expect(renderChecklist([])).toBe("");
  });
});

describe("markSatisfied", () => {
  it("marks items whose distinctive tokens appear in the artifact", () => {
    const items: SpecItem[] = [
      { id: "1", text: "POST /sign route for submissions", status: "open" },
      { id: "2", text: "GET /api/entries returns JSON", status: "open" },
      { id: "3", text: "Something entirely unrelated", status: "open" },
    ];
    const code = `
      if (req.method === 'POST' && req.url === '/sign') { ... }
      if (req.url === '/api/entries') { res.setHeader('content-type', 'application/json'); }
    `;
    const out = markSatisfied(items, code);
    expect(out.find((i) => i.id === "1")!.status).toBe("done");
    expect(out.find((i) => i.id === "2")!.status).toBe("done");
    expect(out.find((i) => i.id === "3")!.status).toBe("open");
  });

  it("preserves already-done items", () => {
    const items: SpecItem[] = [
      { id: "1", text: "foo bar baz", status: "done" },
    ];
    const out = markSatisfied(items, "");
    expect(out[0].status).toBe("done");
  });

  it("does not false-positive on generic words", () => {
    const items: SpecItem[] = [
      // Only generic words — no distinctive tokens → cannot be auto-satisfied
      { id: "1", text: "should work well", status: "open" },
    ];
    const out = markSatisfied(items, "the should work well code here");
    // Without distinctive tokens, we stay conservative: keep open.
    expect(out[0].status).toBe("open");
  });
});
