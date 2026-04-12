/**
 * Debug logging — enabled via DEBUG env var.
 *
 * DEBUG=*           → all categories
 * DEBUG=rlm,queue   → specific categories
 * DEBUG unset       → silent
 */

const enabled = parseEnabled();
const startTime = Date.now();

function parseEnabled(): Set<string> | "all" | null {
  const env = process.env.DEBUG;
  if (!env) return null;
  if (env === "*" || env === "1" || env === "true") return "all";
  return new Set(env.split(",").map((s) => s.trim()).filter(Boolean));
}

export function debug(category: string, ...args: unknown[]): void {
  if (!enabled) return;
  if (enabled !== "all" && !enabled.has(category)) return;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const prefix = `[${elapsed}s ${category}]`;

  const formatted = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  // Use stderr so it doesn't mix with normal server output
  process.stderr.write(`${prefix} ${formatted}\n`);
}

/** Returns true if any debug category is enabled. */
export function isDebugEnabled(): boolean {
  return enabled !== null;
}
