/**
 * Test fixtures for the post-wrapper-kill design graph.
 *
 * Since Phase 3, `fn.implementation` holds the COMPLETE file the
 * implementer emitted (imports + signature + body), not just body
 * statements. Existing tests that used body-only strings need a
 * helper to construct valid full files.
 *
 * Keep this small and boring — it's a test-only wrapper. Not exported
 * from the main package.
 */

import type {
  DesignGraph,
  FunctionNode,
  ProjectDecisions,
  Signature,
  TestSpec,
} from "../../src/rlm/design-graph.js";

/**
 * Default ProjectDecisions for test fixtures. Tests that don't care
 * about decisions content get a plausible vitest+esm+node baseline.
 * Merge overrides for framework-specific tests.
 */
export function defaultDecisions(
  overrides?: Partial<ProjectDecisions>,
): ProjectDecisions {
  return {
    runtime: "node",
    moduleSystem: "esm",
    testFramework: "vitest",
    testCommand: "npx vitest run --reporter=json",
    testImports: `import { describe, it, expect, vi } from "vitest";`,
    packageManager: "npm",
    ...overrides,
  };
}

/** Build a full TypeScript file for a function. Used to migrate tests
 *  that previously passed body-only strings to setImplementation.
 *  Post Phase N2 — no ctx injection; params are the declared ones only. */
export function stubFunctionFile(
  name: string,
  body: string,
  signature: Signature = { params: [], returnType: "void" },
): string {
  const paramList = signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const asyncKw = signature.isAsync ? "async " : "";
  return [
    `export default ${asyncKw}function ${name}(${paramList}): ${signature.returnType} {`,
    ...body.split("\n").map((l) => `  ${l}`),
    `}`,
    "",
  ].join("\n");
}

/**
 * Test-only helper — build a unit test file the way the old
 * `renderFunctionTestFile` wrapper used to, so pre-wrapper-kill
 * fixtures (`graph.addTest(...)`) keep working. Production code never
 * constructs test files; the model emits them via `unit-test-file`
 * fences. This helper lives in the test fixtures exclusively.
 */
export function buildUnitTestFileFromSpecs(
  target: FunctionNode,
  allFns: readonly FunctionNode[],
  tests: readonly TestSpec[],
): string {
  if (tests.length === 0) return "";
  const siblings = allFns.filter((f) => f.name !== target.name);
  const lines: string[] = [];
  lines.push(`import { describe, it, expect, vi } from "vitest";`);
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  lines.push(`import ${target.name} from "./${target.name}.js";`);
  for (const f of siblings) {
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  const fnEntries = [target.name, ...siblings.map((f) => f.name)];
  lines.push(
    `let ctx: any = { fns: { ${fnEntries.join(", ")} }, state: {}, t: null };`,
  );
  lines.push("");
  lines.push(`describe(${JSON.stringify(target.name)}, () => {`);
  for (const t of tests) {
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) lines.push(`    ${row}`);
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

export function buildIntegrationTestFileFromSpecs(
  target: FunctionNode,
  allFns: readonly FunctionNode[],
  tests: readonly TestSpec[],
): string {
  if (tests.length === 0 || target.children.length === 0) return "";
  const siblings = allFns.filter((f) => f.name !== target.name);
  const lines: string[] = [];
  lines.push(`import { describe, it, expect, vi } from "vitest";`);
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  lines.push(`import ${target.name} from "./${target.name}.js";`);
  for (const f of siblings) {
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  const fnEntries = [target.name, ...siblings.map((f) => f.name)];
  lines.push(
    `const ctx: any = { fns: { ${fnEntries.join(", ")} }, state: {}, t: null };`,
  );
  lines.push("");
  lines.push(`describe(${JSON.stringify(`${target.name} (integration)`)}, () => {`);
  for (const t of tests) {
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) lines.push(`    ${row}`);
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

export function buildProjectTestFileFromSpecs(
  allFns: readonly FunctionNode[],
  tests: readonly TestSpec[],
): string {
  if (tests.length === 0 || allFns.length === 0) return "";
  const lines: string[] = [];
  lines.push(`import { describe, it, expect, vi } from "vitest";`);
  lines.push(`import * as fs from "node:fs";`);
  lines.push(`import * as path from "node:path";`);
  lines.push(`import * as http from "node:http";`);
  for (const f of allFns) {
    lines.push(`import ${f.name} from "./${f.name}.js";`);
  }
  lines.push("");
  lines.push(
    `const ctx: any = { fns: { ${allFns.map((f) => f.name).join(", ")} }, state: {}, t: null };`,
  );
  lines.push("");
  lines.push(`describe("project integration", () => {`);
  for (const t of tests) {
    lines.push(`  it(${JSON.stringify(t.name)}, async () => {`);
    for (const row of t.code.split("\n")) lines.push(`    ${row}`);
    lines.push(`  });`);
  }
  lines.push(`});`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Convenience — for fixtures that call `addTest` then materialize,
 * mirror the unit tests into `unitTestFile` so the new wrapper-kill
 * materialize path emits a test file. Call right before materialize.
 */
export function mirrorTestsToFiles(graph: DesignGraph): void {
  const all = graph.listFunctions();
  for (const fn of all) {
    if (fn.tests.length > 0 && fn.unitTestFile === null) {
      graph.setUnitTestFile(
        fn.module,
        fn.name,
        buildUnitTestFileFromSpecs(fn, all, fn.tests),
      );
    }
    if (
      fn.integrationTests.length > 0 &&
      fn.children.length > 0 &&
      fn.integrationTestFile === null
    ) {
      graph.setIntegrationTestFile(
        fn.module,
        fn.name,
        buildIntegrationTestFileFromSpecs(fn, all, fn.integrationTests),
      );
    }
  }
  const projectTests = graph.listProjectTests();
  if (projectTests.length > 0 && graph.getProjectTestFile() === null) {
    graph.setProjectTestFile(buildProjectTestFileFromSpecs(all, projectTests));
  }
}
