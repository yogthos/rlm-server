/**
 * Detect whether an LLM response contains a code artifact that should be
 * structurally validated — as opposed to exploratory REPL code or prose.
 *
 * Returned `content` is the artifact only (the imagined file contents).
 * Returned `path` is extracted from a leading `// <path>` or `/* <path> *\/`
 * comment when present, otherwise undefined.
 */

export interface CodeArtifact {
  content: string;
  path?: string;
}

const FILE_FENCES = ["ts", "typescript", "tsx", "js", "javascript", "mjs"];

/** Matches any fenced code block: ``` LANG\n … \n``` */
const FENCE_RE = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;

/** A leading filename-in-comment hint: `// foo/bar.ts` or `/* foo/bar.ts *\/` */
const PATH_HINT_RE = /^\s*(?:\/\/\s*|\/\*\s*)([\w./-]+\.[a-zA-Z]+)(?:\s*\*\/)?\s*$/;

/** Heuristic: does a string look like TypeScript/JavaScript source code? */
function looksLikeCode(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  // Multiple strong markers reduce false-positives vs prose that happens to
  // mention `function` or `import`. Covers ESM AND CommonJS, async, classes
  // with inheritance, and common block shapes.
  const markers = [
    /\bimport\s+[\w{*\s,}]+\s+from\s+['"]/,
    /\bexport\s+(?:default\s+)?(?:function|const|class|interface|type)\b/,
    /\bmodule\.exports\s*=/,
    /\brequire\s*\(\s*['"]/,
    /\b(?:async\s+)?function\s*\*?\s*\w+\s*\(/,
    /\bconst\s+\w+\s*=/,
    /\blet\s+\w+\s*=/,
    /\b(?:class|interface|type)\s+\w+/,
    /\bextends\s+\w+/,
    /=>\s*\{/,
    /\)\s*\{/,          // function / method / block body
    /[=;]\s*$/m,
  ];
  let hits = 0;
  for (const re of markers) if (re.test(trimmed)) hits++;
  return hits >= 2;
}

function extractPathHint(content: string): string | undefined {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return undefined;
  const m = PATH_HINT_RE.exec(firstLine);
  return m?.[1];
}

export function detectCodeArtifact(raw: string): CodeArtifact | null {
  // 1. Prefer an explicit file-language fence anywhere in the response.
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(raw)) !== null) {
    const lang = match[1].toLowerCase();
    const body = match[2];
    if (FILE_FENCES.includes(lang) && looksLikeCode(body)) {
      return {
        content: body,
        path: extractPathHint(body),
      };
    }
  }

  // 2. FINAL(...) body that looks like code.
  //    EOL-anchored, matching extractCode's FINAL_RE — this guards against
  //    `console.log("FINAL(...)")`-style false positives where the ) is
  //    followed by more text on the same line rather than terminating it.
  const finalMatch = /FINAL\(([\s\S]*)\)\s*$/m.exec(raw);
  if (finalMatch) {
    const body = unwrapBodyWrappers(finalMatch[1]);
    if (looksLikeCode(body)) {
      return { content: body, path: extractPathHint(body) };
    }
  }

  return null;
}

/**
 * Peel off common wrappers from a FINAL body: triple-fence and
 * single-backtick template-literals the model sometimes adds around the
 * actual file content. Idempotent — applies until stable or neither
 * wrapper is visible.
 */
function unwrapBodyWrappers(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3; i++) {
    const fenceM = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/m.exec(s);
    if (fenceM) {
      s = fenceM[1].trim();
      continue;
    }
    if (s.length >= 2 && s.startsWith("`") && s.endsWith("`") && !s.startsWith("```")) {
      s = s.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return s;
}
