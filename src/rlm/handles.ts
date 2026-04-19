/**
 * In-memory descriptive handle store.
 *
 * Results from sandbox execution are stored server-side. The LLM sees only
 * compact stubs like `$grep_error: Array(1000) ["ERROR: timeout...", ...]`.
 * This achieves ~97% token savings on large result sets.
 */

import type { Handle, HandleStore } from "./types.js";

const MAX_PREVIEW_CHARS = 60;
const MAX_PREVIEW_ITEMS = 3;

/**
 * Convert a code snippet to a descriptive slug for the handle name.
 *
 * Examples:
 *   grep("ERROR")           → grep_error
 *   fuzzy_search("timeout") → fuzzy_search_timeout
 *   context.slice(0, 1000)  → context_slice
 *   z3("(declare-const...") → z3_declare_const
 */
export function commandToSlug(code: string): string {
  // Prefer the assigned variable name when the code is a declaration.
  // That matches the model's intuition: after `const serverSource = ...`,
  // the model will naturally write `FINAL_VAR(serverSource)` and expects
  // it to resolve. Falls through to the existing patterns otherwise.
  const assignMatch = code.match(/^\s*(?:const|let|var)\s+(\w+)\s*=/);
  if (assignMatch) {
    return assignMatch[1].toLowerCase();
  }

  // Try to match property access: obj.method(...) — check before plain function call
  const propMatch = code.match(/(\w+)\.(\w+)\s*\(/);
  if (propMatch) {
    return `${propMatch[1]}_${propMatch[2]}`.toLowerCase();
  }

  // Try to match function call: name("string_arg"...)
  const funcMatch = code.match(
    /(\w+)\s*\(\s*(?:["'`]([^"'`]{0,40})["'`])?/,
  );
  if (funcMatch) {
    const name = funcMatch[1];
    const arg = funcMatch[2];
    if (arg) {
      // Extract meaningful words from the argument
      const words = arg
        .replace(/[^a-zA-Z0-9\s_-]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .slice(0, 3);
      if (words.length > 0) {
        return `${name}_${words.join("_")}`.toLowerCase();
      }
    }
    return name.toLowerCase();
  }

  // Fallback: take first meaningful word
  const words = code
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 2);
  return words.length > 0 ? words.join("_").toLowerCase() : "result";
}

/** Create a compact stub representation of data for the LLM. */
export function createStub(name: string, data: unknown): string {
  if (data === null || data === undefined) {
    return `${name}: ${String(data)}`;
  }

  if (Array.isArray(data)) {
    const count = data.length;
    if (count === 0) return `${name}: Array(0) []`;
    const previews = data
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((item) => {
        const s =
          typeof item === "string"
            ? item
            : typeof item === "object"
              ? JSON.stringify(item)
              : String(item);
        return `"${s.slice(0, MAX_PREVIEW_CHARS)}${s.length > MAX_PREVIEW_CHARS ? "..." : ""}"`;
      });
    const suffix = count > MAX_PREVIEW_ITEMS ? ", ..." : "";
    return `${name}: Array(${count}) [${previews.join(", ")}${suffix}]`;
  }

  if (typeof data === "string") {
    const preview = data.slice(0, 100);
    return `${name}: String(${data.length}) "${preview}${data.length > 100 ? "..." : ""}"`;
  }

  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    const keyPreview = keys.slice(0, 5).join(", ");
    const suffix = keys.length > 5 ? ", ..." : "";
    return `${name}: Object {${keyPreview}${suffix}}`;
  }

  // Primitives: show directly
  return `${name}: ${String(data)}`;
}

/** Create a handle store with LRU eviction. */
export function createHandleStore(maxHandles = 200): HandleStore {
  const handles = new Map<string, Handle>();
  const slugCounts = new Map<string, number>();
  let resultsHandle: string | null = null;

  function makeUniqueName(slug: string): string {
    const count = (slugCounts.get(slug) ?? 0) + 1;
    slugCounts.set(slug, count);
    return count === 1 ? `$${slug}` : `$${slug}_${count}`;
  }

  function evictOldest(): void {
    if (handles.size < maxHandles) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, handle] of handles) {
      // Don't evict the current RESULTS handle
      if (key === resultsHandle) continue;
      if (handle.createdAt < oldestTime) {
        oldestTime = handle.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      handles.delete(oldestKey);
    }
  }

  return {
    set(data: unknown, code?: string): Handle {
      const slug = code ? commandToSlug(code) : "result";
      const name = makeUniqueName(slug);

      evictOldest();

      const handle: Handle = {
        name,
        data,
        stub: createStub(name, data),
        createdAt: Date.now(),
      };

      handles.set(name, handle);
      resultsHandle = name;
      return handle;
    },

    get(name: string): Handle | undefined {
      return handles.get(name);
    },

    resolve(name: string): unknown {
      if (name === "RESULTS" && resultsHandle) {
        return handles.get(resultsHandle)?.data;
      }
      // Slug generation normalizes variable names to lowercase (so `serverJs`
      // is stored at `$serverjs`). Fall back to the normalized key so the
      // model's camelCase / uppercase input still resolves.
      const direct = handles.get(name);
      if (direct) return direct.data;
      return handles.get(name.toLowerCase())?.data;
    },

    getResults(): Handle | undefined {
      return resultsHandle ? handles.get(resultsHandle) : undefined;
    },

    buildContext(): string {
      if (handles.size === 0) return "";

      const lines: string[] = ["## Variable Bindings"];
      for (const handle of handles.values()) {
        lines.push(handle.stub);
      }
      if (resultsHandle) {
        lines.push(`RESULTS → ${resultsHandle}`);
      }
      return lines.join("\n");
    },

    clear(): void {
      handles.clear();
      slugCounts.clear();
      resultsHandle = null;
    },

    get size(): number {
      return handles.size;
    },
  };
}
