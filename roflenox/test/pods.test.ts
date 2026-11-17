// PODS (r_pods, src/federation.ts): two pods, each holding only its files of
// a JS corpus under the JS model, and a coordinator holding the model's
// cross-file rules of exports_name; a subscriber on the coordinator.
//
// THE ORACLE: after every step the subscriber's rows equal the whole world's
// answer (the corpus scanned anew and evaluated in one engine), row for row.
// Needs ROFL_BIN, a `rofl` with `watch`. The planted faults are mutants
// P1/P2 of scripts/mutants.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ask } from '../src/client.ts';
import { Federation, wholeWorld } from './pods-harness.ts';
import { tmpDir } from './helpers.ts';

const CORPUS: Record<string, string> = {
  'lib/a.ts': 'export function f() { return 1; }\nexport function g() { return 2; }\n',
  'lib/x.ts': 'export function x1() { return 0; }\n',
  'lib/b.ts': "export * from './a';\nexport function hb() { return 3; }\n",
  'app/c.ts': "export { f as cf } from '../lib/b';\nexport * from '../lib/b';\n",
  'app/d.ts': "import { cf } from './c';\nexport default function main() { return cf(); }\n",
};
/** Pod 0 holds lib/a.ts and lib/x.ts; pod 1 the rest: what c.ts and b.ts offer depends on a.ts, across pods. */
const POD = (f: string) => (f === 'lib/a.ts' || f === 'lib/x.ts' ? 0 : 1);

test('pods: the coordinator subscriber equals the whole world after a load, a local edit, a cross-file edit and a deletion', async () => {
  const root = tmpDir('pods-corpus');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const { fed } = await Federation.start(root, POD, 2);
  try {
    assert.deepEqual(fed.pods.map((p) => p.files), [['lib/a.ts', 'lib/x.ts'], ['app/c.ts', 'app/d.ts', 'lib/b.ts']]);
    const first = await fed.sub.next();
    assert.equal(first.kind, 'full');
    let want = (await wholeWorld(root)).rows;
    assert.ok(want.size >= 9, `the corpus exports through two re-export hops (${want.size} rows)`);
    await fed.converge(want, performance.now());

    // 1. An edit on pod 0 that moves only its own file's rows.
    let e = await fed.edit('lib/x.ts', 'export function x1() { return 0; }\nexport function x2() { return 1; }\n');
    assert.equal(e.pod.removed, 0);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok([...fed.rows()].some((r) => r.includes('"x2"') && r.includes('lib/x.ts')));

    // 2. An edit on pod 0 that moves conclusions about pod 1's files: g goes, h comes, through b.ts and c.ts.
    e = await fed.edit('lib/a.ts', 'export function f() { return 1; }\nexport function h() { return 2; }\n');
    assert.ok(e.pod.added > 0 && e.pod.removed > 0, JSON.stringify(e.pod));
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    for (const file of ['lib/b.ts', 'app/c.ts']) {
      assert.ok([...fed.rows()].some((r) => r.includes('"h"') && r.includes(file)), `h is offered by ${file}, on the other pod`);
      assert.ok(![...fed.rows()].some((r) => r.includes('"g"') && r.includes(file)), `g is no longer offered by ${file}`);
    }

    // why on the coordinator reaches the pod's signed batch.
    const row = [...fed.sub.rows.values()].find((r) => r.cells[1] === 'h' && r.cells[2] === 'app/c.ts')!;
    const text = JSON.stringify((await ask(fed.coord.url, { why: `exports_name(${row.cells.map((c) => JSON.stringify(c)).join(', ')})` }, fed.coord.me)).why);
    assert.match(text, /pod-0/, text);

    // 3. A deletion: a.ts goes; what b.ts and c.ts offered of it goes on the other pod.
    e = await fed.edit('lib/a.ts', null);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok(![...fed.rows()].some((r) => r.includes('"f"')));
  } finally { await fed.close(); }
});
