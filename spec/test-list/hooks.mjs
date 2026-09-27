// Loader hook for the test lister: every import of node:test except the shim's
// own resolves to the shim, which records test names instead of running tests.
export async function resolve(specifier, context, next) {
  if (specifier === 'node:test' && !context.parentURL?.endsWith('/test-list/shim.mjs')) {
    return { url: new URL('./shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
