/**
 * Phase H3 — package.json repair loop.
 *
 * When `npm install` fails (bad JSON, 404'd package, missing registry
 * entry, syntax error), we ask the architect to rewrite `package.json`
 * given the install error. The revised file is stored on the graph
 * via `setAsset("package.json", …)` (and mirrored into
 * projectConfig.packageJson when that field was populated at phase 0).
 * The caller retries the install after a successful repair.
 */

import type { DesignGraph } from "./design-graph.js";
import { extractTaggedFence } from "./design-plan.js";
import { renderDecisionsBlock } from "./decisions-prompt.js";
import { debug } from "./debug.js";

export interface PackageJsonRepairOptions {
  chat: (prompt: string) => Promise<string>;
  /** Parse retries before giving up. Default 1 (i.e. 2 total chat
   *  calls). The outer install loop handles "tried fix still doesn't
   *  install" — this is purely about getting parseable JSON back. */
  maxRetries?: number;
}

export interface PackageJsonRepairResult {
  ok: boolean;
  error?: string;
}

function buildPrompt(
  graph: DesignGraph,
  installError: string,
  lastAttemptError: string | null,
): string {
  const current =
    graph.getAsset("package.json") ??
    graph.getProjectConfig()?.packageJson ??
    "(no package.json stored yet — write one from scratch)";
  const pm = graph.getProjectConfig()?.packageManager ?? "npm";
  const installCmd = pm === "npm" ? "npm install" : `${pm} install`;
  const retryNudge = lastAttemptError
    ? [
        "",
        "Your previous repair attempt was rejected:",
        "```",
        lastAttemptError,
        "```",
        "Fix the shape this time.",
      ]
    : [];
  return [
    `The project's \`${installCmd}\` failed. Something in the current`,
    "`package.json` is wrong — malformed JSON, a 404'd package name,",
    "a bad version range, or a missing field. REWRITE the file so",
    `that \`${installCmd}\` succeeds.`,
    ...renderDecisionsBlock(graph),
    "",
    "Current package.json:",
    "```json",
    current,
    "```",
    "",
    "Install error (stderr + stdout from `npm install`):",
    "```",
    installError.slice(-2000),
    "```",
    "",
    "Rules:",
    "- Emit the COMPLETE revised package.json — the harness writes it",
    "  verbatim, overwriting the old one.",
    "- Do NOT invent dependencies the task doesn't need. If the error",
    "  is a 404 on a package name, pick the correct spelling / a real",
    "  replacement (e.g. `better-sqlite3` not `sqlite3-better`).",
    "- Preserve fields the install loop depends on (`name`, `type`,",
    "  `scripts.test`) unless they're the cause of the error.",
    ...retryNudge,
    "",
    "OUTPUT — emit ONE fenced block:",
    "",
    "```file:package.json",
    "<the full revised package.json>",
    "```",
  ].join("\n");
}

export async function repairPackageJson(
  graph: DesignGraph,
  installError: string,
  options: PackageJsonRepairOptions,
): Promise<PackageJsonRepairResult> {
  const maxRetries = options.maxRetries ?? 1;
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt = buildPrompt(graph, installError, lastError);
    let response: string;
    try {
      response = await options.chat(prompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debug("pkg-repair", `chat error (attempt ${attempt + 1}): ${msg}`);
      return { ok: false, error: `chat failed: ${msg}` };
    }
    const revised = extractTaggedFence(response, "file:package.json");
    if (!revised) {
      lastError = "no file:package.json fence in response";
      debug(
        "pkg-repair",
        `attempt ${attempt + 1} rejected — ${lastError}`,
      );
      continue;
    }
    try {
      JSON.parse(revised);
    } catch (e) {
      lastError = `revised package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
      debug(
        "pkg-repair",
        `attempt ${attempt + 1} rejected — ${lastError}`,
      );
      continue;
    }
    // Accepted — store on the graph + mirror into projectConfig.
    graph.setAsset("package.json", revised);
    const cfg = graph.getProjectConfig();
    if (cfg?.packageJson) {
      graph.setProjectConfig({ ...cfg, packageJson: revised });
    }
    debug(
      "pkg-repair",
      `repaired package.json on attempt ${attempt + 1} (${revised.length} chars)`,
    );
    return { ok: true };
  }
  return { ok: false, error: lastError ?? "(no attempt made)" };
}
