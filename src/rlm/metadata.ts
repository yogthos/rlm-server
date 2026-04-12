/**
 * Constant-size metadata generation.
 *
 * Implements Algorithm 1's Metadata() function: the LLM receives only
 * compact summaries of the prompt and execution results, never the full data.
 */

const DEFAULT_PREVIEW_LENGTH = 200;
const DEFAULT_STDOUT_PREVIEW = 500;

/** Generate metadata about the user prompt for the initial history entry. */
export function promptMetadata(prompt: string): string {
  const lines = prompt.split("\n");
  const preview = prompt.slice(0, DEFAULT_PREVIEW_LENGTH);
  const suffix = prompt.length > DEFAULT_PREVIEW_LENGTH ? "..." : "";

  const type = guessContentType(prompt);

  return [
    `Context loaded: ${type}`,
    `Length: ${prompt.length} chars, ${lines.length} lines`,
    `Preview: "${preview}${suffix}"`,
    "",
    'The full content is available as the `context` variable in the REPL.',
    "Write code to examine, search, and analyze it.",
  ].join("\n");
}

/** Generate metadata about stdout from a sandbox execution. */
export function stdoutMetadata(stdout: string): string {
  if (!stdout || stdout.length === 0) {
    return "[No output]";
  }

  const preview = stdout.slice(0, DEFAULT_STDOUT_PREVIEW);
  const suffix = stdout.length > DEFAULT_STDOUT_PREVIEW ? "..." : "";

  return `Output (${stdout.length} chars): "${preview}${suffix}"`;
}

/** Generate a type-aware summary of an execution result. */
export function resultMetadata(result: unknown): string {
  if (result === null || result === undefined) {
    return `Result: ${String(result)}`;
  }

  if (Array.isArray(result)) {
    if (result.length === 0) return "Result: empty array";
    const first = summarizeValue(result[0]);
    return `Result: Array(${result.length}), first item: ${first}`;
  }

  if (typeof result === "string") {
    if (result.length === 0) return "Result: empty string";
    const preview = result.slice(0, 100);
    return `Result: String(${result.length}) "${preview}${result.length > 100 ? "..." : ""}"`;
  }

  if (typeof result === "object") {
    const keys = Object.keys(result);
    return `Result: Object with keys [${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", ..." : ""}]`;
  }

  return `Result: ${String(result)}`;
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return `"${value.slice(0, 60)}${value.length > 60 ? "..." : ""}"`;
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.slice(0, 80) + "..." : s;
  }
  return String(value);
}

function guessContentType(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "JSON document";
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) return "HTML document";
  if (trimmed.startsWith("<?xml")) return "XML document";
  if (trimmed.startsWith("#") || /^#{1,6}\s/m.test(trimmed)) return "Markdown document";
  if (trimmed.includes("function ") || trimmed.includes("const ") || trimmed.includes("import "))
    return "source code";
  if (trimmed.includes("def ") || trimmed.includes("class ")) return "source code";
  return "text document";
}
