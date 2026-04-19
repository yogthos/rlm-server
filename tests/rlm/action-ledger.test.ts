import { describe, it, expect } from "vitest";
import {
  createLedger,
  appendLedger,
  renderRecent,
  type LedgerEntry,
} from "../../src/rlm/action-ledger.js";

describe("action ledger", () => {
  it("createLedger returns an empty list", () => {
    const l = createLedger();
    expect(l).toEqual([]);
  });

  it("appendLedger returns a new array (immutable)", () => {
    const l0 = createLedger();
    const entry: LedgerEntry = {
      iter: 0,
      state: "generate",
      summary: "llm returned 800ch",
    };
    const l1 = appendLedger(l0, entry);
    expect(l0).toEqual([]); // untouched
    expect(l1).toHaveLength(1);
    expect(l1[0]).toMatchObject(entry);
  });

  it("appendLedger stamps elapsed time when not given", () => {
    const l = appendLedger(createLedger(), {
      iter: 0,
      state: "generate",
      summary: "foo",
    });
    expect(typeof l[0].tsMs).toBe("number");
  });

  it("renderRecent returns the last N entries as a compact block", () => {
    let l = createLedger();
    for (let i = 0; i < 15; i++) {
      l = appendLedger(l, { iter: i, state: "generate", summary: `step ${i}` });
    }
    const block = renderRecent(l, 5);
    expect(block.split("\n").filter((line) => line.includes("|")).length).toBe(5);
    expect(block).toContain("step 14");
    expect(block).toContain("step 10");
    expect(block).not.toContain("step 5"); // outside the window
  });

  it("renderRecent with fewer entries than the window uses all of them", () => {
    let l = createLedger();
    l = appendLedger(l, { iter: 0, state: "generate", summary: "first" });
    l = appendLedger(l, { iter: 0, state: "execute", summary: "second" });
    const block = renderRecent(l, 10);
    expect(block).toContain("first");
    expect(block).toContain("second");
  });

  it("renderRecent returns empty string when ledger is empty", () => {
    expect(renderRecent(createLedger(), 5)).toBe("");
  });

  it("entries are formatted as one-line pipe-separated fields", () => {
    let l = createLedger();
    l = appendLedger(l, {
      iter: 2,
      state: "execute",
      summary: "stdout=120ch handle=$r2",
    });
    const block = renderRecent(l, 1);
    const row = block.split("\n").find((line) => line.includes("|"))!;
    // iter, state, summary separated by pipes
    expect(row).toMatch(/iter=2/);
    expect(row).toMatch(/execute/);
    expect(row).toMatch(/stdout=120ch/);
    expect(row).toMatch(/handle=\$r2/);
  });
});
