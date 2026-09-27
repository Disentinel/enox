// The runner's own list of the test cases in each file: every file is imported
// under the shim (node --import ./register.mjs list.mjs <file>...), so the
// test() calls that module loading makes are recorded exactly as they happen —
// loops, generated names and all — and no test body runs. Prints JSON
// {file: [names]}; a file that fails to load is {file: {error}}.
import { pathToFileURL } from 'node:url';

const out = {};
for (const f of process.argv.slice(2)) {
  const before = (globalThis.__testList ??= []).length;
  try {
    await import(pathToFileURL(f).href);
    out[f] = globalThis.__testList.slice(before);
  } catch (e) {
    out[f] = { error: String(e?.message ?? e).split('\n')[0] };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
