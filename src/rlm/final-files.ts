/**
 * Render the value of a FINAL_FILES directive as a readable, parseable
 * multi-file payload. The Architect returns a Record<string, string>
 * (typically from `design_finalize().files` or `design_query()`-derived
 * materialization); this formats it as labeled blocks the API consumer
 * can split on.
 */

import { debug } from "./debug.js";

export function renderFileSet(
  raw: Record<string, string> | unknown,
): string {
  const files = extractFileSet(raw);
  debug("finalfiles", `rendering ${Object.keys(files).length} files`);
  const parts: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    parts.push(`--- file: ${path} ---`);
    parts.push(content);
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

function extractFileSet(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object") {
    throw new Error("FINAL_FILES value must be an object");
  }
  if (raw instanceof Promise) {
    throw new Error(
      "FINAL_FILES value is a Promise — you forgot to `await` the result",
    );
  }
  // Accept a FinalizeReport shape ({ files, … }) by unwrapping .files.
  const candidate =
    "files" in raw &&
    typeof (raw as { files: unknown }).files === "object" &&
    (raw as { files: unknown }).files !== null
      ? (raw as { files: Record<string, unknown> }).files
      : (raw as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const k of Object.keys(candidate)) {
    if (!Object.hasOwn(candidate, k)) continue;
    const v = candidate[k];
    if (typeof v !== "string") {
      throw new Error(
        `FINAL_FILES value must map path → string; got ${typeof v} at "${k}"`,
      );
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    throw new Error("FINAL_FILES value is empty — no files to return");
  }
  return out;
}
