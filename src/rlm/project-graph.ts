/**
 * Accumulating project graph — tracks every code artifact the LLM has
 * produced across the run (sub-RLM returns + root FINAL(s)), and exposes
 * the combined structural facts so graph-level rules can fire on
 * adjacency instead of per-file.
 *
 * The "is this the first file" bootstrap check is the point: until the
 * first file lands, a function has nowhere to be an orphan relative to.
 * After that, every new file must connect (caller, callee, import, or
 * exports-to-known) to something already in the graph — otherwise it's a
 * floating island and we block it.
 */

import { extractStructuralFacts, type StructuralFacts } from "./structural-facts.js";
import type { FileSet } from "./envelopes.js";

export interface ProjectGraph {
  readonly size: number;
  isEmpty(): boolean;
  hasFile(path: string): boolean;
  snapshot(): FileSet;
  addOrUpdate(path: string, content: string): Promise<void>;
  getFacts(): Promise<StructuralFacts>;
}

export function createProjectGraph(): ProjectGraph {
  const files = new Map<string, string>();
  let cachedFacts: StructuralFacts | null = null;

  async function rebuildFacts(): Promise<StructuralFacts> {
    const entries = Array.from(files.entries()).map(([path, content]) => ({
      path,
      content,
    }));
    cachedFacts = await extractStructuralFacts(entries);
    return cachedFacts;
  }

  return {
    get size() {
      return files.size;
    },
    isEmpty() {
      return files.size === 0;
    },
    hasFile(path) {
      return files.has(path);
    },
    snapshot() {
      return Object.fromEntries(files);
    },
    async addOrUpdate(path, content) {
      files.set(path, content);
      cachedFacts = null;
    },
    async getFacts() {
      if (cachedFacts) return cachedFacts;
      return rebuildFacts();
    },
  };
}
