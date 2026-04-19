import { describe, it, expect } from "vitest";
import { detectCodeArtifact } from "../../src/rlm/code-artifact.js";

describe("detectCodeArtifact", () => {
  it("returns null for plain prose", () => {
    expect(detectCodeArtifact("Here is some thought, nothing else.")).toBeNull();
  });

  it("returns null for a repl block (exploratory, not a file)", () => {
    const r = detectCodeArtifact("```repl\ngrep('err')\n```");
    expect(r).toBeNull();
  });

  it("extracts a ts-fenced code block", () => {
    const raw = "Here is the file:\n```ts\nexport const x = 1;\nexport function f(a: number) {}\n```";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content).toContain("export const x = 1");
    expect(r!.content).toContain("export function f");
  });

  it("extracts a typescript-fenced code block", () => {
    const r = detectCodeArtifact("```typescript\nexport const y = 2;\n```");
    expect(r).not.toBeNull();
    expect(r!.content).toContain("export const y = 2");
  });

  it("extracts a js-fenced code block", () => {
    const r = detectCodeArtifact("```js\nexport const z = 3;\n```");
    expect(r).not.toBeNull();
    expect(r!.content).toContain("export const z = 3");
  });

  it("extracts the FINAL() argument when it contains code-like content", () => {
    const raw = "I'm done.\n\nFINAL(export function add(a: number, b: number): number { return a + b; })";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content).toMatch(/export function add/);
  });

  it("ignores FINAL() with non-code prose", () => {
    const raw = "FINAL(the answer is 42)";
    expect(detectCodeArtifact(raw)).toBeNull();
  });

  it("prefers the ts/typescript/js fence over repl", () => {
    const raw = "```repl\nconsole.log('x')\n```\n\n```ts\nexport const y = 2;\n```";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content).not.toContain("console.log");
    expect(r!.content).toContain("export const y");
  });

  it("picks up filename hints from a leading comment", () => {
    const raw = "```ts\n// src/utils.ts\nexport const u = 1;\n```";
    const r = detectCodeArtifact(raw);
    expect(r!.path).toBe("src/utils.ts");
  });

  it("falls back to null path when no filename hint", () => {
    const raw = "```ts\nexport const x = 1;\n```";
    const r = detectCodeArtifact(raw);
    expect(r!.path).toBeUndefined();
  });

  it("recognises imports/exports as code-likeness signal in FINAL", () => {
    const raw = "FINAL(import { foo } from './foo.js'; export function bar() {})";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
  });

  it("does NOT latch onto FINAL( inside string literals or comments", () => {
    // The "FINAL(" here is inside a quoted string — not the real FINAL
    // directive. extractCode's EOL anchor protects against this; we need
    // detectCodeArtifact to behave the same way.
    const raw = `Here's analysis.\n\nconsole.log("FINAL(fake-argument)");\n\nNo actual FINAL emitted.`;
    expect(detectCodeArtifact(raw)).toBeNull();
  });

  it("does NOT latch onto a buried FINAL( whose content looks code-like", () => {
    // Here the closing ) is followed by `;` and `)` — NOT at end of line.
    // extractCode's regex would ignore this; detectCodeArtifact must too,
    // otherwise we validate code the model never proposed.
    const raw = `console.log("FINAL(import x from 'y'; export function f() {})");  // just logging`;
    expect(detectCodeArtifact(raw)).toBeNull();
  });

  it("unwraps a template-literal (single-backtick) wrapping around the FINAL body", () => {
    // Observed in real runs — the model ships code as a JS template literal
    // inside FINAL(...). Strip the outer backticks so the validator sees
    // actual TS/JS, not ` at byte 0.
    const raw = "FINAL(`const http = require('http');\nconst x = 1;\nfunction foo() { return 1; }`)";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content.startsWith("`")).toBe(false);
    expect(r!.content.endsWith("`")).toBe(false);
    expect(r!.content).toContain("require('http')");
  });

  it("unwraps a triple-fence wrapping inside the FINAL body", () => {
    // Some models wrap their FINAL-produced code in a fenced block AND the
    // FINAL directive too. Extract the fence content as the artifact.
    const raw = "FINAL(```ts\nexport const x = 1;\nexport function f() {}\n```)";
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content).toContain("export const x = 1");
    expect(r!.content).not.toContain("```");
  });

  it("recognises CommonJS / Node-style code as an artifact", () => {
    // Real-world TS/JS files use require(...) and module.exports without
    // any `import`/`export` keywords — must still count as code.
    const raw = [
      "FINAL(",
      "const http = require('http');",
      "const Database = require('better-sqlite3');",
      "const db = new Database('guestbook.db');",
      "const server = http.createServer((req, res) => { res.end('ok'); });",
      "server.listen(3001);",
      "module.exports = server;",
      ")",
    ].join("\n");
    const r = detectCodeArtifact(raw);
    expect(r).not.toBeNull();
    expect(r!.content).toContain("require('http')");
  });

  it("recognises a class-extends definition as code", () => {
    const raw = "FINAL(class Foo extends Bar { constructor() { super(); } foo() { return 1; } })";
    expect(detectCodeArtifact(raw)).not.toBeNull();
  });

  it("recognises an async-function definition as code", () => {
    const raw = "FINAL(async function handler(req, res) { const x = await res.json(); return x; })";
    expect(detectCodeArtifact(raw)).not.toBeNull();
  });

  it("only recognises FINAL( when the closing ) is at end of line", () => {
    // Real FINAL with EOL anchor — valid
    const realFinal = "Some stuff\nFINAL(export function f(): number { return 1; })";
    expect(detectCodeArtifact(realFinal)).not.toBeNull();
    // Fake FINAL buried in mid-line text — must be rejected
    const fake = `Before "FINAL(nope)" in the middle and real stuff continues`;
    expect(detectCodeArtifact(fake)).toBeNull();
  });
});
