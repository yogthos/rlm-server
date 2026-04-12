export type {
  CodeGraph,
  DefinesFact,
  CallsFact,
  ImportsFact,
  ExportsFact,
  ContainsFact,
  SymbolKind,
  LanguageAdapter,
} from "./types.js";

export { extractGraph } from "./extractor.js";
export { getLanguageForFile, getSupportedExtensions, parseSourceAsync } from "./parser.js";
export { registerAdapter, discoverAdapters } from "./adapter-registry.js";
export { graphToProlog } from "./facts.js";

export {
  runAnalysis,
  runAnalysisFromGraph,
  buildFactsResult,
  DEFAULT_FACTS_MAX_BYTES,
} from "./analyses.js";
export type { AnalysisType, AnalysisRequest, AnalysisResult, FactsOversizeError } from "./analyses.js";

export {
  cycles,
  reachability,
  path,
  impact,
  deadCode,
  callers,
  callees,
} from "./native-analyses.js";
