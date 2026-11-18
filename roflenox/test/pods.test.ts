// PODS (r_pods, src/federation.ts): two pods, each holding only its files of
// a JS corpus under the JS model, and a coordinator holding the model's
// cross-file rules of exports_name; a subscriber on the coordinator.
//
// THE ORACLE: after every step the subscriber's rows equal the whole world's
// answer (the corpus scanned anew and evaluated in one engine), row for row.
// Needs ROFL_BIN, a `rofl` with `watch`. The planted faults are mutants
// P1-P4 of scripts/mutants.json.
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
    const by = new Set<string>();
    let e = await fed.edit('lib/x.ts', 'export function x1() { return 0; }\nexport function x2() { return 1; }\n');
    assert.equal(e.pod.removed, 0);
    by.add(e.pod.by);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok([...fed.rows()].some((r) => r.includes('"x2"') && r.includes('lib/x.ts')));

    // 2. An edit on pod 0 that moves conclusions about pod 1's files: g goes, h comes, through b.ts and c.ts.
    e = await fed.edit('lib/a.ts', 'export function f() { return 1; }\nexport function h() { return 2; }\n');
    assert.ok(e.pod.added > 0 && e.pod.removed > 0, JSON.stringify(e.pod));
    assert.equal(e.pod.by, 'delta', 'a rename behind export * is taken by the engine\'s delta, not anew');
    by.add(e.pod.by);
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
    by.add(e.pod.by);
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
    assert.ok(![...fed.rows()].some((r) => r.includes('"f"')));
    assert.deepEqual([...by], ['delta'], 'every edit by delta');

    // 4. An edit the engine refuses (a fact the pod holds for x.ts was taken out behind it): the pod evaluates anew.
    const pod0 = fed.pods[0]!.pod as unknown as { s: { retract(q: string): Promise<void> }; files: Map<string, Set<string>> };
    await pod0.s.retract([...pod0.files.get('lib/x.ts')!].find((l) => l.includes('"x2"'))!.replace(/\.$/, ''));
    e = await fed.edit('lib/x.ts', 'export function x3() { return 0; }\n');
    assert.equal(e.pod.by, 'anew', JSON.stringify(e.pod));
    want = (await wholeWorld(root)).rows;
    await fed.converge(want, e.t0);
  } finally { await fed.close(); }
});

// THE CORE ROUTED (CoreRouter): each pod holds only the core its files reach by the model's keys. Pod 0 holds lib/,
// pod 1 app/; both import into lib/, so the listing of lib/ is needed on both, a string of one file on its pod alone.
const ROUTED: Record<string, string> = {
  'lib/a.ts': 'export function f() { return 1; }\n',
  'lib/x.ts': "export * from './a';\nexport function x1() { return 0; }\n",
  'lib/b.ts': "export * from './h';\n",
  'app/c.ts': "export * from '../lib/a';\nexport * from '../lib/h';\n",
  'app/d.ts': 'export const k = 1;\n',
};
const strFacts = (fed: Federation, s: string) => [...fed.core.keys()].filter((l) => l.includes(`(${JSON.stringify(s)},`));
const held = (fed: Federation, i: number) => (fed.pods[i]!.pod as unknown as { core: Set<string> }).core;

test('pods: a pod holds the core its files reach; a core change reaches only the pods it moves; a string no file holds leaves', async () => {
  const root = tmpDir('pods-routed');
  for (const [f, t] of Object.entries(ROUTED)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const { fed } = await Federation.start(root, (f) => (f.startsWith('lib/') ? 0 : 1), 2);
  try {
    await fed.sub.next();
    await fed.converge((await wholeWorld(root)).rows, performance.now());
    for (const i of [0, 1]) assert.deepEqual([...held(fed, i)].sort(), [...fed.router.share(i)].sort(), `pod ${i} holds its share`);
    assert.ok(strFacts(fed, './a').length > 0 && strFacts(fed, './a').every((l) => held(fed, 0).has(l) && !held(fed, 1).has(l)), 'the string ./a of lib/x.ts is on pod 0 alone');
    assert.ok(held(fed, 1).size < fed.core.size, `pod 1 holds ${held(fed, 1).size} of the core's ${fed.core.size}`);

    // 1. A string only pod 1's file holds comes: the core moves on pod 1 alone.
    let e = await fed.edit('app/d.ts', 'export const k = 1;\nexport const s = "only-d";\n');
    assert.ok(e.core.in > 0, JSON.stringify(e.core));
    assert.equal(e.others.length, 0, 'pod 0 is not sent a string none of its files reaches');
    assert.ok(strFacts(fed, 'only-d').every((l) => held(fed, 1).has(l) && !held(fed, 0).has(l)));
    await fed.converge((await wholeWorld(root)).rows, e.t0);

    // 2. A core fact two pods need changes: lib/h.ts appears, its listing reached from lib/b.ts (pod 0) and app/c.ts (pod 1).
    e = await fed.edit('lib/h.ts', 'export function hh() { return 2; }\n');
    assert.equal(e.others.length, 1, 'pod 1 is sent the listing of lib/h.ts');
    const listing = [...fed.core.keys()].filter((l) => l.includes('"lib/h.ts"'));
    assert.ok(listing.some((l) => held(fed, 0).has(l)), 'pod 0 holds the listing of lib/h.ts');
    assert.ok(listing.some((l) => held(fed, 1).has(l)), 'pod 1 holds the listing of lib/h.ts it resolves into');
    await fed.converge((await wholeWorld(root)).rows, e.t0);
    assert.ok([...fed.rows()].some((r) => r.includes('"hh"') && r.includes('app/c.ts')), 'hh is offered by app/c.ts, on pod 1');

    // 3. The string leaves the corpus: no file holds it, the core and pod 1 let it go.
    e = await fed.edit('app/d.ts', 'export const k = 1;\n');
    assert.ok(e.core.out > 0, JSON.stringify(e.core));
    assert.deepEqual(strFacts(fed, 'only-d'), [], 'the core holds no fact of a string no file holds');
    assert.ok(![...held(fed, 1)].some((l) => l.includes('"only-d"')), 'pod 1 let the string go');
    assert.equal(e.others.length, 0);
    await fed.converge((await wholeWorld(root)).rows, e.t0);

    // 4. lib/h.ts deleted: its listing leaves both pods.
    e = await fed.edit('lib/h.ts', null);
    assert.equal(e.others.length, 1, 'pod 1 is sent the listing\'s going');
    assert.ok(![...held(fed, 1)].some((l) => l.includes('"lib/h.ts"')));
    await fed.converge((await wholeWorld(root)).rows, e.t0);
  } finally { await fed.close(); }
});
