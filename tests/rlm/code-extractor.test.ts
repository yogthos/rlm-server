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

  it("accepts FINAL_VAR with a $-prefixed handle name", () => {
    // Model sometimes writes the handle syntax it sees in bindings:
    // `FINAL_VAR($serverJs)`. Capture the bare name.
    const response = "FINAL_VAR($serverJs)";
    const result = extractCode(response);
    expect(result.finalVar).toBe("serverJs");
  });

  it("does not detect FINAL inside code blocks", () => {
    const response = `\`\`\`repl
FINAL("inside code")
\`\`\``;

    const result = extractCode(response);
    expect(result.code).toBe('FINAL("inside code")');
    expect(result.finalAnswer).toBeNull();
  });

  describe("detectMisplacedDirective", () => {
    it("returns null for ordinary code", async () => {
      const { detectMisplacedDirective } = await import("../../src/rlm/code-extractor.js");
      expect(detectMisplacedDirective("const x = 1; console.log(x);")).toBeNull();
      expect(detectMisplacedDirective(null)).toBeNull();
      expect(detectMisplacedDirective("")).toBeNull();
    });

    it("detects FINAL_VAR( inside code body", async () => {
      const { detectMisplacedDirective } = await import("../../src/rlm/code-extractor.js");
      const r = detectMisplacedDirective("const x = 1; FINAL_VAR(x)");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("FINAL_VAR");
    });

    it("detects FINAL( inside code body", async () => {
      const { detectMisplacedDirective } = await import("../../src/rlm/code-extractor.js");
      const r = detectMisplacedDirective("const x = 1; FINAL(answer)");
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("FINAL");
    });

    it("detects FINAL_VAR with $-prefix", async () => {
      const { detectMisplacedDirective } = await import("../../src/rlm/code-extractor.js");
      expect(detectMisplacedDirective("FINAL_VAR($foo)")!.kind).toBe("FINAL_VAR");
    });

    it("is tolerant of whitespace and capitalization matches literal", async () => {
      const { detectMisplacedDirective } = await import("../../src/rlm/code-extractor.js");
      // Only exact-case FINAL / FINAL_VAR — our directive names are
      // case-sensitive everywhere else.
      expect(detectMisplacedDirective("final_var(x)")).toBeNull();
      expect(detectMisplacedDirective("final(x)")).toBeNull();
      // With inner whitespace still detected.
      expect(detectMisplacedDirective("FINAL_VAR( x )")).not.toBeNull();
    });
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
