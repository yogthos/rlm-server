import { describe, it, expect } from "vitest";
import { createSandbox } from "../src/sandbox.js";
import { GREP_IMPL } from "../src/builtins/grep.js";
import { FUZZY_SEARCH_IMPL } from "../src/builtins/fuzzy-search.js";
import { COUNT_TOKENS_IMPL, LOCATE_LINE_IMPL } from "../src/builtins/text-utils.js";

describe("createSandbox", () => {
  it("executes simple expressions and returns result", async () => {
    const sandbox = createSandbox("hello world");
    const result = await sandbox.execute("1 + 2");
    expect(result.result).toBe(3);
    expect(result.error).toBeUndefined();
    sandbox.dispose();
  });

  it("provides context as document content", async () => {
    const sandbox = createSandbox("line one\nline two\nline three");
    const result = await sandbox.execute("context.split('\\n').length");
    expect(result.result).toBe(3);
    sandbox.dispose();
  });

  it("persists memory across executions", async () => {
    const sandbox = createSandbox("test");
    await sandbox.execute('memory.push("first")');
    await sandbox.execute('memory.push("second")');
    const mem = sandbox.getMemory();
    expect(mem).toEqual(["first", "second"]);
    sandbox.dispose();
  });

  it("persists variable declarations across executions (REPL semantics)", async () => {
    const sandbox = createSandbox("test");
    await sandbox.execute("const x = 42");
    const result = await sandbox.execute("x");
    expect(result.result).toBe(42);
    sandbox.dispose();
  });

  it("captures console.log output", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute('console.log("hello")\n42');
    expect(result.logs).toContain("hello");
    expect(result.result).toBe(42);
    sandbox.dispose();
  });

  it("captures console.error with prefix", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute('console.error("oops")');
    expect(result.logs[0]).toContain("[ERROR]");
    expect(result.logs[0]).toContain("oops");
    sandbox.dispose();
  });

  it("returns error on invalid code", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute("throw new Error('boom')");
    expect(result.error).toContain("boom");
    sandbox.dispose();
  });

  it("allows eval inside the sandbox VM", async () => {
    // The VM context is already isolated (no process, require, etc.),
    // so eval is safe to permit and useful for LLM-generated code that
    // needs to parse dynamic strings from sub-RLM results.
    const sandbox = createSandbox("test");
    const result = await sandbox.execute('eval("1+1")');
    expect(result.error).toBeUndefined();
    expect(result.result).toBe(2);
    sandbox.dispose();
  });

  it("provides text_stats", async () => {
    const sandbox = createSandbox("line 1\nline 2\nline 3");
    const result = await sandbox.execute("text_stats()");
    const stats = result.result as Record<string, unknown>;
    expect(stats).toHaveProperty("lineCount", 3);
    expect(stats).toHaveProperty("length");
    sandbox.dispose();
  });

  it("handles async code", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute(
      "await Promise.resolve(99)",
    );
    expect(result.result).toBe(99);
    sandbox.dispose();
  });

  it("returns error after dispose", async () => {
    const sandbox = createSandbox("test");
    sandbox.dispose();
    const result = await sandbox.execute("1 + 1");
    expect(result.error).toContain("disposed");
  });

  it("accepts custom globals", async () => {
    const sandbox = createSandbox("test", {
      globals: { myTool: (x: number) => x * 2 },
    });
    const result = await sandbox.execute("myTool(21)");
    expect(result.result).toBe(42);
    sandbox.dispose();
  });

  it("accepts custom initCode", async () => {
    const sandbox = createSandbox("test", {
      globals: { __doubleBridge: (x: number) => x * 2 },
      initCode: "function double(x) { return __doubleBridge(x); }",
    });
    const result = await sandbox.execute("double(5)");
    expect(result.result).toBe(10);
    sandbox.dispose();
  });

  it("grep builtin works", async () => {
    const sandbox = createSandbox("ERROR: something\nINFO: ok\nERROR: another", {
      builtins: [GREP_IMPL],
    });
    const result = await sandbox.execute('grep("ERROR")');
    const matches = result.result as Array<{ lineNum: number }>;
    expect(matches).toHaveLength(2);
    expect(matches[0].lineNum).toBe(1);
    expect(matches[1].lineNum).toBe(3);
    sandbox.dispose();
  });

  it("fuzzy_search builtin works", async () => {
    const sandbox = createSandbox("hello world\ngoodbye world\nhelo wrld", {
      builtins: [FUZZY_SEARCH_IMPL],
    });
    const result = await sandbox.execute('fuzzy_search("hello", 5)');
    const matches = result.result as Array<{ lineNum: number; score: number }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].lineNum).toBe(1);
    expect(matches[0].score).toBe(0); // exact match
    sandbox.dispose();
  });

  it("count_tokens builtin works", async () => {
    const sandbox = createSandbox("one two three four five", {
      builtins: [COUNT_TOKENS_IMPL],
    });
    const result = await sandbox.execute("count_tokens()");
    expect(result.result).toBeGreaterThan(0);
    sandbox.dispose();
  });

  it("locate_line builtin works", async () => {
    const sandbox = createSandbox("line1\nline2\nline3\nline4", {
      builtins: [LOCATE_LINE_IMPL],
    });
    const result = await sandbox.execute("locate_line(2, 3)");
    expect(result.result).toBe("line2\nline3");
    sandbox.dispose();
  });

  it("handles concurrent executions without interference", async () => {
    const sandbox = createSandbox("test");
    const [r1, r2, r3] = await Promise.all([
      sandbox.execute("1 + 1"),
      sandbox.execute("2 + 2"),
      sandbox.execute("3 + 3"),
    ]);
    expect(r1.result).toBe(2);
    expect(r2.result).toBe(4);
    expect(r3.result).toBe(6);
    // Each execution should have its own logs
    expect(r1.logs).toEqual([]);
    expect(r2.logs).toEqual([]);
    expect(r3.logs).toEqual([]);
    sandbox.dispose();
  });

  it("destructuring works when RHS is defined in same execution", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute(
      "const obj = { x: 1, y: 2 }\nconst { x, y } = obj\nx + y",
    );
    expect(result.result).toBe(3);
    expect(result.error).toBeUndefined();
    sandbox.dispose();
  });

  it("clears memory on dispose", async () => {
    const sandbox = createSandbox("test");
    await sandbox.execute('memory.push("data")');
    expect(sandbox.getMemory()).toEqual(["data"]);
    sandbox.dispose();
    expect(sandbox.getMemory()).toEqual([]);
  });

  it("captures console.warn with prefix", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute('console.warn("caution")');
    expect(result.logs[0]).toContain("[WARN]");
    expect(result.logs[0]).toContain("caution");
    sandbox.dispose();
  });

  it("handles syntax errors gracefully", async () => {
    const sandbox = createSandbox("test");
    const result = await sandbox.execute("const = ;");
    expect(result.error).toBeDefined();
    expect(result.result).toBeNull();
    sandbox.dispose();
  });

  it("evicts oldest user variables when maxVariables exceeded", async () => {
    const sandbox = createSandbox("test", { maxVariables: 3 });

    await sandbox.execute("const a = 1");
    await sandbox.execute("const b = 2");
    await sandbox.execute("const c = 3");

    // All three should still be accessible
    expect((await sandbox.execute("a")).result).toBe(1);
    expect((await sandbox.execute("b")).result).toBe(2);
    expect((await sandbox.execute("c")).result).toBe(3);

    // Adding a 4th should evict 'a' (oldest) — set to undefined to free data
    await sandbox.execute("const d = 4");
    expect((await sandbox.execute("d")).result).toBe(4);
    expect((await sandbox.execute("a")).result).toBeUndefined();

    // b and c should still be there
    expect((await sandbox.execute("b")).result).toBe(2);
    expect((await sandbox.execute("c")).result).toBe(3);

    sandbox.dispose();
  });

  it("does not evict protected variables like context", async () => {
    const sandbox = createSandbox("hello", {
      maxVariables: 2,
      globals: { myTool: () => 42 },
    });

    await sandbox.execute("const x = 1");
    await sandbox.execute("const y = 2");
    await sandbox.execute("const z = 3");

    // context and myTool must survive regardless of eviction
    expect((await sandbox.execute("context")).result).toBe("hello");
    expect((await sandbox.execute("myTool()")).result).toBe(42);

    sandbox.dispose();
  });

  it("does not evict when maxVariables is not set", async () => {
    const sandbox = createSandbox("test");

    // Declare many variables without limit
    for (let i = 0; i < 50; i++) {
      await sandbox.execute(`var v${i} = ${i}`);
    }

    // All should still be accessible
    expect((await sandbox.execute("v0")).result).toBe(0);
    expect((await sandbox.execute("v49")).result).toBe(49);

    sandbox.dispose();
  });

  it("grep returns empty for invalid regex", async () => {
    const sandbox = createSandbox("test content", {
      builtins: [GREP_IMPL],
    });
    const result = await sandbox.execute('grep("[invalid")');
    expect(result.result).toEqual([]);
    sandbox.dispose();
  });
});
