import { describe, it, expect } from "vitest";
import {
  commandToSlug,
  createStub,
  createHandleStore,
} from "../../src/rlm/handles.js";

describe("commandToSlug", () => {
  it("extracts function name and string argument", () => {
    expect(commandToSlug('grep("ERROR")')).toBe("grep_error");
    expect(commandToSlug("fuzzy_search('timeout')")).toBe(
      "fuzzy_search_timeout",
    );
  });

  it("handles function call without string argument", () => {
    expect(commandToSlug("text_stats()")).toBe("text_stats");
    expect(commandToSlug("count_tokens(context)")).toBe("count_tokens");
  });

  it("truncates long arguments to meaningful words", () => {
    expect(commandToSlug('grep("ERROR timeout connection")')).toBe(
      "grep_error_timeout_connection",
    );
  });

  it("handles property access patterns", () => {
    expect(commandToSlug("context.slice(0, 1000)")).toBe("context_slice");
  });

  it("falls back to first meaningful words", () => {
    expect(commandToSlug("x + y")).toBe("result");
  });

  it("lowercases everything", () => {
    expect(commandToSlug('grep("ERROR_CODE")')).toBe("grep_error_code");
  });
});

describe("createStub", () => {
  it("shows null/undefined directly", () => {
    expect(createStub("$x", null)).toBe("$x: null");
    expect(createStub("$x", undefined)).toBe("$x: undefined");
  });

  it("shows array count and preview", () => {
    const stub = createStub("$grep_error", ["line 1", "line 2", "line 3"]);
    expect(stub).toContain("Array(3)");
    expect(stub).toContain('"line 1"');
  });

  it("shows empty array", () => {
    expect(createStub("$x", [])).toBe("$x: Array(0) []");
  });

  it("truncates large arrays with ...", () => {
    const data = Array.from({ length: 100 }, (_, i) => `item ${i}`);
    const stub = createStub("$big", data);
    expect(stub).toContain("Array(100)");
    expect(stub).toContain("...");
  });

  it("shows string length and preview", () => {
    const stub = createStub("$text", "hello world");
    expect(stub).toContain("String(11)");
    expect(stub).toContain('"hello world"');
  });

  it("shows object keys", () => {
    const stub = createStub("$obj", { a: 1, b: 2, c: 3 });
    expect(stub).toContain("Object");
    expect(stub).toContain("a, b, c");
  });

  it("shows primitives directly", () => {
    expect(createStub("$n", 42)).toBe("$n: 42");
    expect(createStub("$b", true)).toBe("$b: true");
  });
});

describe("createHandleStore", () => {
  it("stores and retrieves handles", () => {
    const store = createHandleStore();
    const handle = store.set([1, 2, 3], 'grep("test")');
    expect(handle.name).toBe("$grep_test");
    expect(store.get("$grep_test")?.data).toEqual([1, 2, 3]);
  });

  it("tracks RESULTS as the last handle", () => {
    const store = createHandleStore();
    store.set("first", "grep('a')");
    store.set("second", "grep('b')");
    expect(store.getResults()?.data).toBe("second");
  });

  it("resolves RESULTS to the last handle's data", () => {
    const store = createHandleStore();
    store.set([1, 2], "grep('x')");
    expect(store.resolve("RESULTS")).toEqual([1, 2]);
  });

  it("generates unique names for duplicate slugs", () => {
    const store = createHandleStore();
    const h1 = store.set("a", 'grep("ERROR")');
    const h2 = store.set("b", 'grep("ERROR")');
    expect(h1.name).toBe("$grep_error");
    expect(h2.name).toBe("$grep_error_2");
  });

  it("evicts oldest handle when max reached", () => {
    const store = createHandleStore(3);
    store.set("a", "f1()");
    store.set("b", "f2()");
    store.set("c", "f3()");
    expect(store.size).toBe(3);

    store.set("d", "f4()");
    expect(store.size).toBe(3);
    // f1 was oldest and not RESULTS, so it should be evicted
    expect(store.get("$f1")).toBeUndefined();
  });

  it("does not evict the current RESULTS handle", () => {
    const store = createHandleStore(2);
    const h1 = store.set("a", "first()");
    // h1 is now RESULTS
    store.set("b", "second()");
    // Now h2 is RESULTS, h1 is oldest
    // Adding a third should evict h1, not h2 (RESULTS)
    store.set("c", "third()");
    expect(store.get(h1.name)).toBeUndefined();
  });

  it("buildContext returns all stubs", () => {
    const store = createHandleStore();
    store.set([1, 2], 'grep("a")');
    store.set("hello", "text()");
    const ctx = store.buildContext();
    expect(ctx).toContain("## Variable Bindings");
    expect(ctx).toContain("$grep_a");
    expect(ctx).toContain("$text");
    expect(ctx).toContain("RESULTS →");
  });

  it("buildContext returns empty string when no handles", () => {
    const store = createHandleStore();
    expect(store.buildContext()).toBe("");
  });

  it("clear removes everything", () => {
    const store = createHandleStore();
    store.set("x", "a()");
    store.set("y", "b()");
    store.clear();
    expect(store.size).toBe(0);
    expect(store.getResults()).toBeUndefined();
  });
});
