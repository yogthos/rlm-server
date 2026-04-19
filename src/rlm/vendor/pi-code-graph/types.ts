/**
 * Vendored slice of pi-code-graph (MIT). Only the types referenced by
 * the tree-sitter layer are kept. See ./LICENSE.
 */

import type { Parser, Language, Query } from "web-tree-sitter";
import { SupportedLanguage } from "./constants.js";

export interface LanguageSpec {
  language: SupportedLanguage;
  extensions: readonly string[];
  functionNodeTypes: readonly string[];
  classNodeTypes: readonly string[];
  callNodeTypes: readonly string[];
  importNodeTypes: readonly string[];
  moduleNodeTypes: readonly string[];
  indexFiles: readonly string[];
  packageIndicators: readonly string[];
  functionsQuery?: string;
  classesQuery?: string;
  callsQuery?: string;
  importsQuery?: string;
  localsQuery?: string;
}

export interface LanguageQueries {
  functions: Query | null;
  classes: Query | null;
  calls: Query | null;
  imports: Query | null;
  locals: Query | null;
  config: LanguageSpec;
  language: Language;
  parser: Parser;
}
