/**
 * Injectable DesignGraph bridge for the VM sandbox.
 *
 * Requires `__designBridge` (object with methods) in the VM context.
 * Exposes:
 *   design_module(path)
 *   design_function(module, name, signature, description?)
 *   design_import(toModule, symbol, fromModule)
 *   design_test(module, name, { name, code })
 *   design_implement(module, name, source)
 *   design_set_test_status(module, name, status, output?)
 *   design_query()               — returns the DesignGraphSnapshot
 *   design_consistency()         — returns the ConsistencyReport
 *   design_dispatch(module, name) — spawn a child Implementer for a declared function
 *   design_finalize(options?)    — materialize + run full tests (+ optional typecheck)
 *   design_build()               — mechanical end-to-end: consistency + topo dispatch + finalize
 *   design_load(path)            — read an existing file into the graph (signatures + bodies)
 *   design_plan(task)            — full pipeline: multi-turn design + mechanical build
 */
export const DESIGN_IMPL = `
function design_module(path) {
  return __designBridge.module(path);
}
function design_function(module, name, signature, description) {
  return __designBridge.function(module, name, signature, description);
}
function design_import(toModule, symbol, fromModule) {
  return __designBridge.import(toModule, symbol, fromModule);
}
function design_test(module, name, test) {
  return __designBridge.test(module, name, test);
}
function design_implement(module, name, source) {
  return __designBridge.implement(module, name, source);
}
function design_set_test_status(module, name, status, output) {
  return __designBridge.setTestStatus(module, name, status, output);
}
function design_query() {
  return __designBridge.query();
}
function design_consistency() {
  return __designBridge.consistency();
}
async function design_dispatch(module, name) {
  return await __designDispatchBridge(module, name);
}
async function design_finalize(options) {
  return await __designFinalizeBridge(options);
}
async function design_build() {
  return await __designBuildBridge();
}
async function design_load(path) {
  return await __designLoadBridge(path);
}
async function design_plan(task) {
  return await __designPlanBridge(task);
}
`;
