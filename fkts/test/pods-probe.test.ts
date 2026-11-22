// PODS, attacked from outside the fixture of pods.test.ts: a chain of re-exports, a new file re-exports another, export * turns into a renamed named re-export and the middle of the chain is deleted. Each step is held to the whole world.
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Federation, wholeWorld } from './pods-harness.ts';
import { tmpDir } from './helpers.ts';

const CORPUS: Record<string, string> = {
  'lib/a.ts': 'export function f() { return 1; }\nexport function g() { return 2; }\n',
  'lib/b.ts': "export * from './a';\nexport function hb() { return 3; }\n",
  'app/c.ts': "export * from '../lib/b.js';\n",
  'app/d.ts': "export * from './c';\nexport const k = 1;\n",
};
// A: the chain a -> b -> c -> d over the pods the engine's leaves make of it.

test('probe: chain over three pods; a new re-exporting file; a named re-export with rename; the middle of the chain deleted', async () => {
  const root = tmpDir('pods-probe');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const { fed } = await Federation.start(root, 3);
  const step = async (name: string, t0: number) => {
    const want = (await wholeWorld(root)).rows;
    try { await fed.converge(want, t0, 40_000); console.log(`ok  ${name} (${want.size} rows)`); }
    catch (e) { console.log(`RED ${name}: want ${want.size} got ${[...fed.rows()].length} ${String(e).slice(0, 200)}`); process.exitCode = 1; }
  };
  try {
    await fed.sub.next();
    await step('A0 initial, the chain', performance.now());
    let e = await fed.edit('lib/a.ts', 'export function f() { return 1; }\nexport function g2() { return 2; }\nexport class Z {}\n');
    await step(`A1 edit at the chain's head moves the rows down it (${e.pod.by})`, e.t0);
    // B: a new file appears that re-exports a file of another pod
    e = await fed.edit('lib/e.ts', "export * from '../app/d';\nexport function ee() { return 0; }\n");
    await step(`B1 a new file re-exporting another pod (${e.pod.by})`, e.t0);
    // C: named re-export with rename replaces export *
    e = await fed.edit('lib/b.ts', "export { f as ff, Z } from './a';\nexport function hb() { return 3; }\n");
    await step(`C1 export * -> named re-export with rename (${e.pod.by})`, e.t0);
    e = await fed.edit('lib/b.ts', null);
    await step(`C2 the middle of the chain deleted (${e.pod.by})`, e.t0);
  } finally { await fed.close(); }
});
