/**
 * Extract executable code blocks and FINAL directives from LLM output.
 */

export interface ExtractionResult {
  /** Concatenated code from all fenced blocks (null if none found). */
  code: string | null;
  /** Direct final answer from FINAL(...) outside code blocks. */
  finalAnswer: string | null;
  /** Variable name from FINAL_VAR(...) outside code blocks. */
  finalVar: string | null;
  /** Variable name from FINAL_FILES(...) — value is a Record<string, string>. */
  finalFiles: string | null;
  /** When the model wrote `FINAL_FILES(<inline object/string/template>)`
   *  instead of a variable name. We capture this so the loop can emit a
   *  focused nudge instead of silently failing to recognize the directive. */
  finalFilesInline: boolean;
  /** The non-code reasoning text from the LLM. */
  reasoning: string;
}

const CODE_FENCE_RE =
  /```(?:repl|javascript|js)\s*\n([\s\S]*?)```/g;

const FINAL_RE = /FINAL\(([\s\S]*)\)$/m;
// `\$?` allows the model to write either `FINAL_VAR(foo)` or the handle
// form `FINAL_VAR($foo)` it sees in the bindings. We capture the bare
// name either way; downstream resolvers already try both prefixes.
const FINAL_VAR_RE = /FINAL_VAR\(\$?(\w+)\)/;
const FINAL_FILES_RE = /FINAL_FILES\(\$?(\w+)\)/;
// Detect the common anti-pattern where the model writes
// `FINAL_FILES({...})` or `FINAL_FILES("..."...)` — an inline
// expression instead of a variable name. We want to REJECT that with a
// clear message rather than silently pass it through.
const FINAL_FILES_INLINE_RE = /FINAL_FILES\(\s*[\{"'`]/;

// Case-sensitive — directive names are capitalized everywhere they're real.
const MISPLACED_FINAL_VAR_RE = /\bFINAL_VAR\s*\(/;
const MISPLACED_FINAL_FILES_RE = /\bFINAL_FILES\s*\(/;
const MISPLACED_FINAL_RE = /\bFINAL\s*\(/;

/**
 * Did the model write a FINAL / FINAL_VAR directive inside the body of a
 * ```repl/js/javascript code block? Those directives are parsed OUTSIDE
 * fenced blocks — putting them in an executable block means the sandbox
 * tries to call a non-existent function and throws ReferenceError.
 *
 * Returns the kind, or null when the code is clean.
 */
export function detectMisplacedDirective(
  code: string | null,
): { kind: "FINAL" | "FINAL_VAR" | "FINAL_FILES" } | null {
  if (!code) return null;
  if (MISPLACED_FINAL_FILES_RE.test(code)) return { kind: "FINAL_FILES" };
  if (MISPLACED_FINAL_VAR_RE.test(code)) return { kind: "FINAL_VAR" };
  if (MISPLACED_FINAL_RE.test(code)) return { kind: "FINAL" };
  return null;
}

/**
 * Extract code blocks and FINAL directives from an LLM response.
 *
 * Code is extracted from ```repl, ```javascript, or ```js fenced blocks.
 * FINAL() and FINAL_VAR() are detected in non-code portions of the response.
 */
export function extractCode(response: string): ExtractionResult {
  // Collect all code blocks and their positions
  const codeBlocks: string[] = [];
  const codeRanges: Array<[number, number]> = [];

  let match: RegExpExecArray | null;
  const re = new RegExp(CODE_FENCE_RE.source, "g");

  while ((match = re.exec(response)) !== null) {
    const code = match[1].trim();
    if (code.length > 0) {
      codeBlocks.push(code);
    }
    codeRanges.push([match.index, match.index + match[0].length]);
  }

  // Build reasoning text (everything outside code blocks)
  let reasoning = "";
  let pos = 0;
  for (const [start, end] of codeRanges) {
    reasoning += response.slice(pos, start);
    pos = end;
  }
  reasoning += response.slice(pos);
  reasoning = reasoning.trim();

  // Look for FINAL / FINAL_VAR / FINAL_FILES in reasoning text only.
  // FINAL_FILES takes precedence (most structured); then FINAL_VAR; then
  // the raw FINAL text form.
  let finalAnswer: string | null = null;
  let finalVar: string | null = null;
  let finalFiles: string | null = null;

  const finalFilesMatch = reasoning.match(FINAL_FILES_RE);
  const finalVarMatch = reasoning.match(FINAL_VAR_RE);
  const finalMatch = reasoning.match(FINAL_RE);
  const finalFilesInline =
    !finalFilesMatch && FINAL_FILES_INLINE_RE.test(reasoning);

  if (finalFilesMatch) {
    finalFiles = finalFilesMatch[1];
    if (finalVarMatch || finalMatch) {
      // Surface a mixed-directive hint in reasoning so the loop's logs
      // show it; the precedence still wins but operators want to know.
      reasoning = `[note: multiple FINAL directives — FINAL_FILES wins]\n${reasoning}`;
    }
  } else if (finalVarMatch) {
    finalVar = finalVarMatch[1];
  } else if (finalMatch) {
    finalAnswer = finalMatch[1].trim();
  }

  return {
    code: codeBlocks.length > 0 ? codeBlocks.join("\n\n") : null,
    finalAnswer,
    finalVar,
    finalFiles,
    finalFilesInline,
    reasoning,
  };
}
