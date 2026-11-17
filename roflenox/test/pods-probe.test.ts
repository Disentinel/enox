// PODS, attacked from outside the fixture of pods.test.ts: the chain crosses a pod at every hop, a new file re-exports another pod, export * turns into a renamed named re-export and the middle of the chain is deleted. Each step is held to the whole world (mutant P1 turns it red).
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Federation, wholeWorld } from './pods-harness.ts';
import { tmpDir } from './helpers.ts';

const CORPUS: Record<string, string> = {
  'lib/a.ts': 'export function f() { return 1; }\nexport function g() { return 2; }\n',
  'lib/b.ts': "export * from './a';\nexport function hb() { return 3; }\n",
  'app/c.ts': "export * from '../lib/b';\n",
  'app/d.ts': "export * from './c';\nexport const k = 1;\n",
};
// A: three pods, the chain a -> b -> c -> d crosses a pod at every hop.
const POD = (f: string) => ({ 'lib/a.ts': 0, 'lib/b.ts': 1, 'app/c.ts': 2, 'app/d.ts': 0 } as Record<string, number>)[f] ?? 0;

test('probe: chain over three pods; a new re-exporting file; a named re-export with rename; the middle of the chain deleted', async () => {
  const root = tmpDir('pods-probe');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const { fed } = await Federation.start(root, POD, 3);
  const step = async (name: string, t0: number) => {
    const want = (await wholeWorld(root)).rows;
    try { await fed.converge(want, t0, 40_000); console.log(`ok  ${name} (${want.size} rows)`); }
    catch (e) { console.log(`RED ${name}: want ${want.size} got ${[...fed.rows()].length} ${String(e).slice(0, 200)}`); process.exitCode = 1; }
  };
  try {
    await fed.sub.next();
    await step('A0 initial, chain over 3 pods', performance.now());
    let e = await fed.edit('lib/a.ts', 'export function f() { return 1; }\nexport function g2() { return 2; }\nexport class Z {}\n');
    await step(`A1 edit at the chain's head moves 3 pods' rows (${e.pod.by})`, e.t0);
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
