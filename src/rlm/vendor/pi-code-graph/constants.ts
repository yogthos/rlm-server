/**
 * Vendored slice of pi-code-graph (MIT). Only the constants referenced by
 * the tree-sitter layer are included here. See ./LICENSE for upstream
 * copyright notice. Do not add unrelated constants — if you need more,
 * either vendor them or reach for your own module.
 */

export enum SupportedLanguage {
  PYTHON = "python",
  JS = "javascript",
  TS = "typescript",
  RUST = "rust",
  GO = "go",
  SCALA = "scala",
  JAVA = "java",
  C = "c",
  CPP = "cpp",
  CSHARP = "c-sharp",
  PHP = "php",
  LUA = "lua",
}

// File extensions — one extension per language, grouped for use in
// LanguageSpec.extensions fields.
const EXT_PY = ".py";
const EXT_JS = ".js";
const EXT_JSX = ".jsx";
const EXT_TS = ".ts";
const EXT_TSX = ".tsx";
const EXT_RS = ".rs";
const EXT_GO = ".go";
const EXT_SCALA = ".scala";
const EXT_SC = ".sc";
const EXT_JAVA = ".java";
const EXT_C = ".c";
const EXT_H = ".h";
const EXT_CPP = ".cpp";
const EXT_CC = ".cc";
const EXT_CXX = ".cxx";
const EXT_HPP = ".hpp";
const EXT_HXX = ".hxx";
const EXT_CS = ".cs";
const EXT_PHP = ".php";
const EXT_LUA = ".lua";

export const PY_EXTENSIONS = [EXT_PY] as const;
export const JS_EXTENSIONS = [EXT_JS, EXT_JSX] as const;
export const TS_EXTENSIONS = [EXT_TS, EXT_TSX] as const;
export const RS_EXTENSIONS = [EXT_RS] as const;
export const GO_EXTENSIONS = [EXT_GO] as const;
export const SCALA_EXTENSIONS = [EXT_SCALA, EXT_SC] as const;
export const JAVA_EXTENSIONS = [EXT_JAVA] as const;
export const C_EXTENSIONS = [EXT_C, EXT_H] as const;
export const CPP_EXTENSIONS = [
  EXT_CPP,
  EXT_CC,
  EXT_CXX,
  EXT_HPP,
  EXT_HXX,
] as const;
export const CS_EXTENSIONS = [EXT_CS] as const;
export const PHP_EXTENSIONS = [EXT_PHP] as const;
export const LUA_EXTENSIONS = [EXT_LUA] as const;

export const INIT_PY = "__init__.py";
export const PKG_INIT_PY = "__init__.py";
export const PKG_CARGO_TOML = "Cargo.toml";
export const PKG_CMAKE_LISTS = "CMakeLists.txt";
export const PKG_MAKEFILE = "Makefile";
