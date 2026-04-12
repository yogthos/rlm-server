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
  /** The non-code reasoning text from the LLM. */
  reasoning: string;
}

const CODE_FENCE_RE =
  /```(?:repl|javascript|js)\s*\n([\s\S]*?)```/g;

const FINAL_RE = /FINAL\(([\s\S]*)\)$/m;
const FINAL_VAR_RE = /FINAL_VAR\((\w+)\)/;

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

  // Look for FINAL/FINAL_VAR in reasoning text only
  let finalAnswer: string | null = null;
  let finalVar: string | null = null;

  const finalVarMatch = reasoning.match(FINAL_VAR_RE);
  if (finalVarMatch) {
    finalVar = finalVarMatch[1];
  }

  if (!finalVar) {
    const finalMatch = reasoning.match(FINAL_RE);
    if (finalMatch) {
      finalAnswer = finalMatch[1].trim();
    }
  }

  return {
    code: codeBlocks.length > 0 ? codeBlocks.join("\n\n") : null,
    finalAnswer,
    finalVar,
    reasoning,
  };
}
