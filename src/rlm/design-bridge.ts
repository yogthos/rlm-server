/**
 * Host-side bridge that backs the sandbox's `design_*` builtins.
 * See src/builtins/design-bridge.ts for the VM side.
 */

import type {
  DesignGraph,
  Signature,
  TestSpec,
  FunctionStatus,
  DesignGraphSnapshot,
  ConsistencyReport,
} from "./design-graph.js";

export interface DesignBridge {
  module(path: string): { path: string };
  function(
    module: string,
    name: string,
    signature: Signature,
    description?: string,
  ): { module: string; name: string };
  import(toModule: string, symbol: string, fromModule: string): void;
  test(module: string, name: string, test: TestSpec): void;
  implement(module: string, name: string, source: string): void;
  setTestStatus(
    module: string,
    name: string,
    status: FunctionStatus,
    output?: string,
  ): void;
  query(): DesignGraphSnapshot;
  consistency(): ConsistencyReport;
}

/**
 * Wrap a DesignGraph in the narrow bridge surface exposed to the sandbox.
 * Returns plain-data responses where possible so the LLM can inspect
 * results without holding live references.
 */
export function createDesignBridge(graph: DesignGraph): DesignBridge {
  return {
    module(path) {
      const node = graph.addModule(path);
      return { path: node.path };
    },
    function(module, name, signature, description) {
      const node = graph.addFunction(module, name, signature, description);
      return { module: node.module, name: node.name };
    },
    import(toModule, symbol, fromModule) {
      graph.addImport(toModule, symbol, fromModule);
    },
    test(module, name, test) {
      graph.addTest(module, name, test);
    },
    implement(module, name, source) {
      graph.setImplementation(module, name, source);
    },
    setTestStatus(module, name, status, output) {
      graph.setTestStatus(module, name, status, output);
    },
    query() {
      return graph.snapshot();
    },
    consistency() {
      return graph.consistency();
    },
  };
}
