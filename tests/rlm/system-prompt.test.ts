import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/rlm/system-prompt.js";

describe("buildSystemPrompt", () => {
  const config = {
    contextLength: 50000,
    contextLineCount: 1200,
    contextPreview: "Hello world, this is a test document.",
    contextType: "text document",
  };

  it("includes context metadata", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("50000 total characters");
    expect(prompt).toContain("1200 lines");
    expect(prompt).toContain("Hello world");
  });

  it("describes the REPL environment", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("`context` variable");
    expect(prompt).toContain("JavaScript REPL");
  });

  it("documents all search tools", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("grep(");
    expect(prompt).toContain("fuzzy_search(");
    expect(prompt).toContain("locate_line(");
    expect(prompt).toContain("count_tokens(");
    expect(prompt).toContain("text_stats()");
  });

  it("documents llm_query", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("llm_query");
    expect(prompt).toContain("sub-LLM");
  });

  it("documents z3 solver", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("z3(");
    expect(prompt).toContain("SMT-LIB");
    expect(prompt).toContain("declare-const");
  });

  it("documents prolog", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("prolog(");
    expect(prompt).toContain("ancestor");
    expect(prompt).toContain("rule-based reasoning");
  });

  it("explains the handle system", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("Handle System");
    expect(prompt).toContain("RESULTS");
    expect(prompt).toContain("$grep_error");
  });

  it("explains FINAL and FINAL_VAR", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("FINAL(");
    expect(prompt).toContain("FINAL_VAR(");
  });

  it("uses code blocks with repl language", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("```repl");
    expect(prompt).toContain("```js");
  });

  it("adds code-aware guidance when contextType is source code", () => {
    const codePrompt = buildSystemPrompt({
      ...config,
      contextType: "source code",
    });
    expect(codePrompt).toContain("CODE ANALYSIS");
    expect(codePrompt).toContain("graph()");
    expect(codePrompt).toContain("impact");
    expect(codePrompt).toContain("DO NOT WRITE YOUR OWN ANALYZER");
  });

  it("skips code-aware guidance for non-code contexts", () => {
    const textPrompt = buildSystemPrompt({
      ...config,
      contextType: "text document",
    });
    expect(textPrompt).not.toContain("CODE ANALYSIS");
    expect(textPrompt).not.toContain("DO NOT WRITE YOUR OWN ANALYZER");
  });
});
