/**
 * Injectable test runner bridge for VM sandbox.
 *
 * Requires `__testRunBridge` (async function) in the VM context.
 * Exposes `test_run(module, name, body)` which runs the tests declared in
 * the DesignGraph against the candidate body and returns `{ok, passed,
 * failed, output}`.
 */
export const TEST_RUN_IMPL = `
async function test_run(module, name, body) {
  return await __testRunBridge(module, name, body);
}
`;
