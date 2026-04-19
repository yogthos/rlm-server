/**
 * Shim that maps pi-code-graph's logger calls onto rlm-sandbox's
 * categorized `debug` stream. Keeps the vendored tree-sitter files
 * unmodified except for their import path.
 */

import { debug } from "../../debug.js";

function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}

export const logger = {
  debug: (...args: unknown[]) => debug("tree-sitter", fmt(args)),
  info: (...args: unknown[]) => debug("tree-sitter", fmt(args)),
  warn: (...args: unknown[]) => debug("tree-sitter", `WARN ${fmt(args)}`),
  error: (...args: unknown[]) => debug("tree-sitter", `ERROR ${fmt(args)}`),
};
