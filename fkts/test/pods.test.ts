// PODS (r_pods, src/federation.ts): two pods, each an engine process settling
// its files of a JS corpus under the JS model by levels, the root engine
// beside the coordinator, which publishes its answers; a subscriber on the
// coordinator.
//
// THE ORACLE: after every step the subscriber's rows equal the whole world's
// answer (the corpus scanned anew and evaluated in one engine), row for row.
// Needs ROFL_BIN, a `rofl` with `volumes`. The planted faults are the P
// mutants of scripts/mutants.json.
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
  'app/e.ts': 'export const e1 = 1;\n',
  'app/f.ts': 'export const f1 = 1;\n',
};
/** A pod settles whole leaves of the engine (4 files, in path order): pod 0 holds app/, pod 1 lib/, and what c.ts
 *  offers depends on a.ts, across pods. */

test('pods: the coordinator subscriber equals the whole world after a load, a local edit, a cross-file edit and a deletion', async () => {
  const root = tmpDir('pods-corpus');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const { fed } = await Federation.start(root, 2);
  try {
    assert.deepEqual(fed.pods.map((p) => p.files), [['app/c.ts', 'app/d.ts', 'app/e.ts', 'app/f.ts'], ['lib/a.ts', 'lib/b.ts', 'lib/x.ts']]);
    const first = await fed.sub.next();
    assert.equal(first.kind, 'full');
    let want = (await wholeWorld(root)).rows;
    assert.ok(want.size >= 9, `the corpus exports through two re-export hops (${want.size} rows)`);
    await fed.converge(want, performance.now());

    // 1. An edit on pod 1 that moves only its own file's rows.
    const by: string[] = [];
    let e = await fed.edit('lib/x.ts', 'export function x1() { return 0; }\nexport function x2() { return 1; }\n');
    assert.equal(e.pod.removed, 0);
    by.push(e.pod.by);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok([...fed.rows()].some((r) => r.includes('"x2"') && r.includes('lib/x.ts')));

    // 2. An edit on pod 1 that moves conclusions about pod 0's files: g goes, h comes, through b.ts and c.ts.
    e = await fed.edit('lib/a.ts', 'export function f() { return 1; }\nexport function h() { return 2; }\n');
    assert.ok(e.pod.added > 0 && e.pod.removed > 0, JSON.stringify(e.pod));
    by.push(e.pod.by);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    for (const file of ['lib/b.ts', 'app/c.ts']) {
      assert.ok([...fed.rows()].some((r) => r.includes('"h"') && r.includes(file)), `h is offered by ${file}`);
      assert.ok(![...fed.rows()].some((r) => r.includes('"g"') && r.includes(file)), `g is no longer offered by ${file}`);
    }
    assert.deepEqual(by, ['levels', 'levels'], 'an edit that moves no core is taken by levels, each pod settling again what it moved');

    // why on the coordinator reaches its signed answers; the root's proof goes down into the pods' units.
    const row = [...fed.sub.rows.values()].find((r) => r.cells[1] === 'h' && r.cells[2] === 'app/c.ts')!;
    const q = `exports_name(${row.cells.map((c) => JSON.stringify(c)).join(', ')})`;
    const text = JSON.stringify((await ask(fed.coord.url, { why: q }, fed.coord.me)).why);
    assert.match(text, /coordinator/, text);
    const proof = await fed.top.why(`exports_name[code](${row.cells[0]}, ${JSON.stringify(row.cells[1])}, ${JSON.stringify(row.cells[2])})`);
    assert.match(proof, /export_all_declaration|reexport/, proof);

    // 3. A deletion: a.ts goes (its facts and its share of the listing are its own: it is settled again empty, by
    // levels); what b.ts and c.ts offered of it goes.
    e = await fed.edit('lib/a.ts', null);
    assert.equal(e.pod.by, 'levels');
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok(![...fed.rows()].some((r) => r.includes('"f"')));

    // 4. A file that comes: anew, and what it re-exports is offered.
    e = await fed.edit('lib/n.ts', "export * from './x';\n");
    assert.equal(e.pod.by, 'anew');
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok([...fed.rows()].some((r) => r.includes('"x2"') && r.includes('lib/n.ts')));
  } finally { await fed.close(); }
});

test('pods: a pod that reaches its wall refuses, and the federation refuses to stand up, saying the wall', async () => {
  const root = tmpDir('pods-wall');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const t0 = performance.now();
  await assert.rejects(Federation.start(root, 2, { budget: 20 }), /budget_exhausted/);
  assert.ok(performance.now() - t0 < 30_000, 'it refuses at once, nobody waits for a unit that will not come');
});
