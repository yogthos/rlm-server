import { describe, it, expect } from "vitest";
import { extractCode } from "../../src/rlm/code-extractor.js";

describe("extractCode", () => {
  it("extracts code from ```repl block", () => {
    const response = `Let me search for errors.

\`\`\`repl
grep("ERROR")
\`\`\`

This will find all error lines.`;

    const result = extractCode(response);
    expect(result.code).toBe('grep("ERROR")');
    expect(result.finalAnswer).toBeNull();
    expect(result.finalVar).toBeNull();
  });

  it("extracts code from ```javascript block", () => {
    const response = `\`\`\`javascript
const x = 42;
\`\`\``;

    expect(extractCode(response).code).toBe("const x = 42;");
  });

  it("extracts code from ```js block", () => {
    const response = `\`\`\`js
const x = 42;
\`\`\``;

    expect(extractCode(response).code).toBe("const x = 42;");
  });

  it("concatenates multiple code blocks", () => {
    const response = `Step 1:
\`\`\`repl
const a = 1;
\`\`\`

Step 2:
\`\`\`repl
const b = a + 1;
\`\`\``;

    const result = extractCode(response);
    expect(result.code).toContain("const a = 1;");
    expect(result.code).toContain("const b = a + 1;");
  });

  it("returns null code when no code blocks", () => {
    const response = "I think the answer is 42.";
    expect(extractCode(response).code).toBeNull();
  });

  it("detects FINAL() in reasoning text", () => {
    const response = `After analyzing the data, I found the answer.

FINAL(The answer is 42)`;

    const result = extractCode(response);
    expect(result.finalAnswer).toBe("The answer is 42");
    expect(result.code).toBeNull();
  });

  it("detects FINAL_VAR() in reasoning text", () => {
    const response = "The results are stored in the variable.\n\nFINAL_VAR(summary)";
    const result = extractCode(response);
    expect(result.finalVar).toBe("summary");
  });

  it("prefers FINAL_VAR over FINAL", () => {
    const response = "FINAL_VAR(result)\nFINAL(something else)";
    const result = extractCode(response);
    expect(result.finalVar).toBe("result");
    expect(result.finalAnswer).toBeNull();
  });

  it("does not detect FINAL inside code blocks", () => {
    const response = `\`\`\`repl
FINAL("inside code")
\`\`\``;

    const result = extractCode(response);
    expect(result.code).toBe('FINAL("inside code")');
    expect(result.finalAnswer).toBeNull();
  });

  it("ignores non-matching code fences", () => {
    const response = `\`\`\`python
print("hello")
\`\`\`

\`\`\`repl
console.log("hello")
\`\`\``;

    const result = extractCode(response);
    expect(result.code).toBe('console.log("hello")');
    expect(result.code).not.toContain("print");
  });

  it("captures reasoning text outside code blocks", () => {
    const response = `I'll analyze this step by step.

\`\`\`repl
grep("test")
\`\`\`

The results show interesting patterns.`;

    const result = extractCode(response);
    expect(result.reasoning).toContain("step by step");
    expect(result.reasoning).toContain("interesting patterns");
    expect(result.reasoning).not.toContain("grep");
  });

  it("handles FINAL with nested parentheses", () => {
    const response = "FINAL(f(x) = 2x + 1)";
    const result = extractCode(response);
    expect(result.finalAnswer).toBe("f(x) = 2x + 1");
  });

  it("handles empty code blocks", () => {
    const response = `\`\`\`repl
\`\`\``;
    expect(extractCode(response).code).toBeNull();
  });
});
