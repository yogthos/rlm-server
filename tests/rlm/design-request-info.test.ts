import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import {
  extractRequestInfo,
  resolveRequests,
  registerInfoHandler,
  listInfoHandlers,
} from "../../src/rlm/design-request-info.js";

const sig = () => ({ params: [], returnType: "void" });
function spec(deps: string[] = [], edgeCases: string[] = []) {
  return {
    purpose: "x",
    inputs: [],
    output: { type: "void", description: "" },
    sideEffects: [],
    dependencies: deps,
    edgeCases,
    examples: [],
  };
}

describe("extractRequestInfo", () => {
  it("returns null when no fence is present", () => {
    expect(extractRequestInfo("just some text\n```ts\nreturn 1;\n```")).toBeNull();
  });

  it("parses each line as a request with kind:args", () => {
    const response =
      "sure thing\n```request-info\nstack-trace\nsibling:foo\nspec:bar\n```";
    const reqs = extractRequestInfo(response);
    expect(reqs).toHaveLength(3);
    expect(reqs![0]).toEqual({ kind: "stack-trace", args: "", raw: "stack-trace" });
    expect(reqs![1]).toEqual({ kind: "sibling", args: "foo", raw: "sibling:foo" });
    expect(reqs![2]).toEqual({ kind: "spec", args: "bar", raw: "spec:bar" });
  });

  it("ignores blank lines and comments", () => {
    const response =
      "```request-info\n# a comment\n\nsibling:foo\n\n```";
    const reqs = extractRequestInfo(response);
    expect(reqs).toHaveLength(1);
    expect(reqs![0].kind).toBe("sibling");
  });

  it("returns null for an empty fence (no actionable requests)", () => {
    expect(extractRequestInfo("```request-info\n\n```")).toBeNull();
  });
});

describe("resolveRequests — built-in handlers", () => {
  it("stack-trace returns the stored failure messages", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const messages = new Map<string, string>([
      ["foo > rejects empty input", "AssertionError: expected {} to equal null\n    at foo.test.ts:12:5"],
    ]);
    const out = await resolveRequests(
      [{ kind: "stack-trace", args: "", raw: "stack-trace" }],
      {
        graph: g,
        module: "src/a.ts",
        fnName: "foo",
        lastFailureMessages: messages,
      },
    );
    expect(out).toContain("foo > rejects empty input");
    expect(out).toContain("AssertionError");
    expect(out).toContain("foo.test.ts:12:5");
  });

  it("stack-trace reports no data when no run on record", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const out = await resolveRequests(
      [{ kind: "stack-trace", args: "", raw: "stack-trace" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toMatch(/no prior|no record/i);
  });

  it("sibling returns body + spec purpose + tests", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "caller", sig());
    g.addFunction("src/a.ts", "helper", sig());
    g.setSpec("src/a.ts", "helper", spec([], ["null input"]));
    g.setImplementation("src/a.ts", "helper", "return 42;");
    g.addTest("src/a.ts", "helper", { name: "returns 42", code: "expect(helper(ctx)).toBe(42);" });
    const out = await resolveRequests(
      [{ kind: "sibling", args: "helper", raw: "sibling:helper" }],
      { graph: g, module: "src/a.ts", fnName: "caller" },
    );
    expect(out).toContain("helper");
    expect(out).toContain("return 42;");
    expect(out).toContain("returns 42");
  });

  it("sibling without args reports usage", async () => {
    const g = createDesignGraph();
    const out = await resolveRequests(
      [{ kind: "sibling", args: "", raw: "sibling" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toMatch(/Usage/i);
  });

  it("spec returns full spec detail", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    g.setSpec("src/a.ts", "foo", spec(["bar"], ["empty input", "null input"]));
    const out = await resolveRequests(
      [{ kind: "spec", args: "foo", raw: "spec:foo" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toContain("empty input");
    expect(out).toContain("null input");
    expect(out).toContain("bar");
  });

  it("callers lists functions whose spec deps reference us", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "leaf", sig());
    g.setSpec("src/a.ts", "leaf", spec());
    g.addFunction("src/a.ts", "alice", sig());
    g.setSpec("src/a.ts", "alice", spec(["leaf"]));
    g.addFunction("src/a.ts", "bob", sig());
    g.setSpec("src/a.ts", "bob", spec(["leaf"]));
    const out = await resolveRequests(
      [{ kind: "callers", args: "", raw: "callers" }],
      { graph: g, module: "src/a.ts", fnName: "leaf" },
    );
    expect(out).toContain("alice");
    expect(out).toContain("bob");
  });

  it("task returns the top-level task string", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const out = await resolveRequests(
      [{ kind: "task", args: "", raw: "task" }],
      { graph: g, module: "src/a.ts", fnName: "foo", task: "Build a guestbook app" },
    );
    expect(out).toContain("Build a guestbook app");
  });

  it("help lists registered handlers", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const out = await resolveRequests(
      [{ kind: "help", args: "", raw: "help" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toContain("stack-trace");
    expect(out).toContain("sibling");
  });

  it("unknown kind returns an error with the available list", async () => {
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const out = await resolveRequests(
      [{ kind: "mystery", args: "", raw: "mystery" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toMatch(/unknown/i);
    expect(out).toContain("stack-trace");
  });
});

describe("registerInfoHandler", () => {
  it("allows adding custom kinds at runtime", async () => {
    registerInfoHandler("custom-thing", () => "custom answer");
    expect(listInfoHandlers()).toContain("custom-thing");
    const g = createDesignGraph();
    g.addFunction("src/a.ts", "foo", sig());
    const out = await resolveRequests(
      [{ kind: "custom-thing", args: "", raw: "custom-thing" }],
      { graph: g, module: "src/a.ts", fnName: "foo" },
    );
    expect(out).toContain("custom answer");
  });
});
