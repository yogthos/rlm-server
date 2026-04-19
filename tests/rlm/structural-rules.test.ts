import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prologQuery } from "../../src/rlm/prolog-bridge.js";
import {
  extractStructuralFacts,
  structuralFactsToProlog,
} from "../../src/rlm/structural-facts.js";

let RULES: string;

beforeAll(async () => {
  RULES = await readFile(
    resolve(import.meta.dirname, "../../src/rlm/structural-rules.pl"),
    "utf8",
  );
});

async function factsFor(sources: Record<string, string>, entryPoints?: string[]): Promise<string> {
  const files = Object.entries(sources).map(([path, content]) => ({ path, content }));
  const facts = await extractStructuralFacts(files);
  return structuralFactsToProlog(facts, entryPoints);
}

async function runQuery(program: string, goal: string): Promise<string[]> {
  const r = await prologQuery(program, goal);
  if (r.status !== "success") throw new Error(`prolog failed: ${r.error}`);
  return (r.answers ?? []).map((a) => a.formatted);
}

describe("structural-rules.pl", () => {
  it("complexity_violation fires when cyclomatic > 10", async () => {
    // Build a function with 11 if statements → cyclomatic = 12
    const ifs = Array.from({ length: 11 }, (_, i) => `  if (n === ${i}) return ${i};`).join("\n");
    const src = `export function big(n: number): number {\n${ifs}\n  return -1;\n}`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "complexity_violation(F, C).");
    expect(answers.some((a) => a.includes("big"))).toBe(true);
  });

  it("complexity_violation does not fire when cyclomatic <= 10", async () => {
    const src = `export function small(n: number): number { return n + 1; }`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "complexity_violation(F, C).");
    expect(answers).toHaveLength(0);
  });

  it("length_violation fires when body_lines > 100", async () => {
    const body = Array.from({ length: 105 }, () => "  x++;").join("\n");
    const src = `export function longFn(): void {\n  let x = 0;\n${body}\n}`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "length_violation(F, L).");
    expect(answers.some((a) => a.includes("longFn"))).toBe(true);
  });

  it("nesting_violation fires when nesting > 5", async () => {
    const src = `
export function deep(xs: number[]): number {
  for (const a of xs) {
    for (const b of xs) {
      for (const c of xs) {
        for (const d of xs) {
          for (const e of xs) {
            for (const f of xs) {
              if (a + b + c + d + e + f > 0) return 1;
            }
          }
        }
      }
    }
  }
  return 0;
}`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "nesting_violation(F, D).");
    expect(answers.some((a) => a.includes("deep"))).toBe(true);
  });

  it("dead_code fires on unreachable function (not exported, not called)", async () => {
    const src = `
export function main(): number { return helper(); }
function helper(): number { return 1; }
function orphan(): number { return 42; }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "dead_code(F).");
    expect(answers.some((a) => a.includes("orphan"))).toBe(true);
    expect(answers.some((a) => a.includes("main"))).toBe(false);
    expect(answers.some((a) => a.includes("helper"))).toBe(false);
  });

  it("call_cycle fires on mutually recursive functions", async () => {
    const src = `
export function a(): number { return b(); }
export function b(): number { return a(); }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "call_cycle(F).");
    expect(answers.length).toBeGreaterThan(0);
  });

  it("call_cycle does not fire on DAG", async () => {
    const src = `
export function a(): number { return b() + c(); }
function b(): number { return c(); }
function c(): number { return 1; }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "call_cycle(F).");
    expect(answers).toHaveLength(0);
  });

  it("orphan_function fires on declared-but-unlinked function", async () => {
    const src = `
function floating(): number { return 42; }
export function main(): number { return 1; }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "orphan_function(F).");
    expect(answers.some((a) => a.includes("floating"))).toBe(true);
    expect(answers.some((a) => a.includes("main"))).toBe(false);
  });

  it("unresolved_call fires on calls to phantom symbols", async () => {
    const src = `
export function a(): number { return mystery(42); }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "unresolved_call(Caller, Callee).");
    expect(answers.some((a) => a.includes("mystery"))).toBe(true);
  });

  it("unresolved_call does NOT fire when the callee is declared", async () => {
    const src = `
function helper(): number { return 1; }
export function main(): number { return helper(); }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "unresolved_call(Caller, Callee).");
    expect(answers).toHaveLength(0);
  });

  it("unresolved_call does NOT fire when the callee is imported", async () => {
    const facts = await factsFor({
      "a.ts": "export function helper(): number { return 1; }",
      "b.ts": "import { helper } from './a.js';\nexport function main(): number { return helper(); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "unresolved_call(Caller, Callee).");
    expect(answers).toHaveLength(0);
  });

  it("island_file fires on a file with no adjacency to the rest of the project", async () => {
    const facts = await factsFor({
      "a.ts": "export function foo(): number { return 1; }",
      "b.ts": "import { foo } from './a.js';\nexport function bar(): number { return foo(); }",
      "c.ts": "function orphanHelper(): number { return 99; }", // no import, no export, no cross-file edge
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "island_file(F).");
    expect(answers.some((a) => a.toLowerCase().includes("c.ts"))).toBe(true);
  });

  it("island_file does NOT fire on a file whose exports are called from elsewhere", async () => {
    const facts = await factsFor({
      "a.ts": "export function foo(): number { return 1; }",
      "b.ts": "import { foo } from './a.js';\nexport function bar(): number { return foo(); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "island_file(F).");
    expect(answers).toHaveLength(0);
  });

  it("arity_mismatch fires when a call-site arity disagrees with the declaration", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function insert(handle: string, message: string, ts: number): number { return ts; }",
      "b.ts":
        "import { insert } from './a.js';\nexport function use(): number { return insert('handle'); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers.some((a) => a.includes("insert"))).toBe(true);
  });

  it("arity_mismatch does NOT fire when the call uses optional params in range", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function greet(name: string, title?: string): string { return title ? `${title} ${name}` : name; }\nexport function use(): string { return greet('foo'); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers).toHaveLength(0);
  });

  it("arity_mismatch does NOT fire on rest-parameter functions", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function join(sep: string, ...parts: string[]): string { return parts.join(sep); }\nexport function use(): string { return join(','); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers).toHaveLength(0);
  });

  it("arity_mismatch STILL fires when call is below required count", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function pair(a: number, b: number, c?: number): number { return a + b + (c ?? 0); }\nexport function use(): number { return pair(1); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers.some((a) => a.includes("pair"))).toBe(true);
  });

  it("arity_mismatch does NOT fire on member-expression (method) calls", async () => {
    // Top-level `prepare` has 3 params; `db.prepare('x')` is a method call
    // on an unrelated object — must not collide by unqualified name.
    const facts = await factsFor({
      "a.ts":
        "export function prepare(query: string, params: any[], opts: unknown): void {}\nexport function use(db: any): void { db.prepare('x'); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers).toHaveLength(0);
  });

  it("arity_mismatch STILL fires on plain-call arity mismatch (not confused by method-call escape)", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function prepare(a: number): void {}\nexport function use(): void { prepare(1, 2); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers.some((a) => a.includes("prepare"))).toBe(true);
  });

  it("arity_mismatch does NOT fire when arity matches", async () => {
    const facts = await factsFor({
      "a.ts":
        "export function add(a: number, b: number): number { return a + b; }\nexport function use(): number { return add(1, 2); }",
    });
    const answers = await runQuery(`${facts}\n${RULES}`, "arity_mismatch(F, D, U).");
    expect(answers).toHaveLength(0);
  });

  it("blocking_violation reports cycles and extreme complexity", async () => {
    const src = `
export function a(): number { return b(); }
export function b(): number { return a(); }
`;
    const facts = await factsFor({ "a.ts": src });
    const answers = await runQuery(`${facts}\n${RULES}`, "blocking_violation(Kind, Name).");
    expect(answers.length).toBeGreaterThan(0);
  });
});
