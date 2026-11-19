// THE CORE ROUTED BY KEY (src/federation.ts coreDemand, CoreRouter), with no engine: a value a pod holds at one key
// of a relation does not open another. app/index.ts holds the string "z.ts" (a value of the strings' keys, not of
// the names of the listing's files) and the name index.ts, which the JS model reads by name (last_ext: is there a file
// called so? its own is the witness); other/ holds an index.ts too, and nothing walks from app/ into other/, so the
// pod of app/ holds none of other/'s listing, and does hold lib/'s, which it walks into. The planted faults are
// mutants P8 (values shared across keys), P9 (no witness: every fact of a name read) and P10 (a derived relation's
// sources dropped: too little laid, which the engine oracles of pods.test.ts and pods-probe.test.ts also turn red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cellsOf, coreDemand, CoreRouter, type Demand, type Key } from '../src/federation.ts';
import { ESCAPES, MODEL, scanOne } from './pods-harness.ts';
import { tmpDir } from './helpers.ts';

const CORPUS: Record<string, string> = {
  'app/index.ts': "export * from '../lib/a';\nexport const s = \"z.ts\";\n",
  'lib/a.ts': 'export function f() { return 1; }\n',
  'lib/index.ts': "export * from './a';\n",
  'other/index.ts': "export * from './z';\n",
  'other/z.ts': 'export const z = 1;\n',
};
const POD = (f: string) => (f.startsWith('app/') ? 1 : f.startsWith('lib/') ? 0 : 2);

test('core routed by key: a name held at one key of the listing does not open the directories holding it', async () => {
  const root = tmpDir('core-router');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const files = Object.keys(CORPUS).sort();
  const scans = new Map(files.map((f) => [f, scanOne(root, f)]));
  const core = new Set([...scans.values()].flatMap((s) => [...s.core]));
  const d = await coreDemand(MODEL, ESCAPES.map((e) => e.rel), new Set([...core].map((l) => cellsOf(l).rel)));
  assert.ok(d, 'the JS model is analysed');
  const r = new CoreRouter(d);
  r.core(core, []);
  for (const f of files) r.files(POD(f), scans.get(f)!.facts, []);
  r.route();
  const app = [...r.share(1)];
  const names = (file: string) => app.filter((l) => l.includes(JSON.stringify(file)));
  assert.ok(names('lib/a.ts').length > 0, 'app/ walks into lib/ and holds its listing');
  assert.deepEqual(names('other/z.ts'), [], 'the pod of app/ holds no listing of other/z.ts');
  assert.deepEqual(names('other/index.ts'), [], 'nor of other/index.ts: its own index.ts is the name\'s witness');
  assert.ok(app.length < core.size, `${app.length} of the core's ${core.size}`);
});

// A DIRECTORY OF MANY FILES, ONE OF THEM IMPORTED: the JS model finds a file by its stem (file_stem, its name less
// the last extension, computed by str_sub), and the router keys that position through the rule's builtins, run
// forward on the listing's names and on the pod's import segments. The pod of app/ holds the listing of the two
// files it imports, `../big/f3` (by stem) and `../big/f5.js` (by the stem of `f5.js`), and none of the other ten.
// The planted fault is mutant P11 (the stem's position not keyed: the directory laid whole).
test('core routed by key: a pod importing one file of a large directory holds that file\'s listing, not the directory\'s', async () => {
  const root = tmpDir('core-router-big');
  const corpus: Record<string, string> = { 'app/main.ts': "export * from '../big/f3';\nexport * from '../big/f5.js';\n" };
  for (let i = 0; i < 12; i++) corpus[`big/f${i}.ts`] = `export const v${i} = ${i};\n`;
  for (const [f, t] of Object.entries(corpus)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const files = Object.keys(corpus).sort();
  const scans = new Map(files.map((f) => [f, scanOne(root, f)]));
  const core = new Set([...scans.values()].flatMap((s) => [...s.core]));
  const d = await coreDemand(MODEL, ESCAPES.map((e) => e.rel), new Set([...core].map((l) => cellsOf(l).rel)));
  assert.ok(d, 'the JS model is analysed');
  const r = new CoreRouter(d);
  r.core(core, []);
  for (const f of files) r.files(f.startsWith('app/') ? 1 : 0, scans.get(f)!.facts, []);
  r.route();
  const app = [...r.share(1)].filter((l) => cellsOf(l).rel === 'fs_file_in');
  const listed = app.map((l) => cellsOf(l).cells[2]!.slice(1)).filter((f) => f.startsWith('big/')).sort();
  assert.deepEqual(listed, ['big/f3.ts', 'big/f5.ts'], `the pod of app/ lists of big/ ${listed.join(', ')}`);
});

// THE ROUTER'S INDEX AGAINST A ROUTER WITH NONE: the reference below holds values per source (not per group of
// sources), indexes nothing, and sweeps every core fact until nothing more is laid. The router indexes a fact only at
// the key positions its constants do not hold, and holds a value's groups as bits of a word: a fact it never
// reconsiders, or a group's bit it drops, is a share smaller than the reference's. The planted faults are mutants
// P14 (a fact indexed at one open position of its key only) and P15 (a value's bits in one word lost when its groups
// cross into the next); the core and the files edited between routes would turn a stale index entry red too.
const NODE = /^an[0-9a-f]{16}_/;
function reference(d: Demand, core: Iterable<string>, files: Iterable<string>): Set<string> {
  const facts = [...core].map((l) => ({ l, ...cellsOf(l.replace(/\.$/, '')) })).sort((a, b) => (a.l < b.l ? -1 : 1));
  const at = new Map<string, Set<string>>();
  const add = (s: string, v: string) => {
    const h = at.get(s) ?? new Set<string>();
    at.set(s, h);
    if (h.has(v)) return;
    h.add(v);
    for (const [x, { calc, input }] of d.calc) if (input.has(s)) for (const w of calc.fn(v)) add(x, w);
  };
  for (const l of files) { const { rel, cells } = cellsOf(l.replace(/\.$/, '')); cells.forEach((c, j) => { if (!NODE.test(c) && d.sources.has(`${rel}#${j}`)) add(`${rel}#${j}`, c); }); }
  const keyHolds = (k: Key, f: { cells: string[] }) => k.at.every((j, i) => (k.calc?.[i] ? k.calc[i]!.fn(f.cells[j]!) : [f.cells[j]!])
    .some((v) => k.from[i]!.values.has(v) || [...k.from[i]!.sources].some((s) => at.get(s)?.has(v))));
  const laid = new Set<string>(), witness = new Set<string>();
  const tuple = (ki: number, k: Key, f: { rel: string; cells: string[] }) => `${f.rel}\0${ki}\0${k.at.map((j) => f.cells[j]).join('\0')}`;
  const lay = (f: { l: string; rel: string; cells: string[] }) => {
    laid.add(f.l);
    (d.keys.get(f.rel) ?? []).forEach((k, ki) => { if (k.exists) witness.add(tuple(ki, k, f)); });
    f.cells.forEach((c, j) => add(`${f.rel}#${j}`, c));
  };
  for (let more = true; more;) {
    more = false;
    for (let grew = true; grew;) {
      grew = false;
      for (const f of facts) if (!laid.has(f.l) && (d.keys.get(f.rel) ?? []).some((k) => !k.exists && keyHolds(k, f))) { lay(f); grew = true; }
    }
    const want = new Map<string, (typeof facts)[number]>();
    for (const f of facts) {
      if (laid.has(f.l)) continue;
      (d.keys.get(f.rel) ?? []).forEach((k, ki) => { const t = tuple(ki, k, f); if (k.exists && !witness.has(t) && !want.has(t) && keyHolds(k, f)) want.set(t, f); });
    }
    for (const [t, f] of want) if (!witness.has(t) && !laid.has(f.l)) { lay(f); more = true; }
  }
  return laid;
}
const sameAsReference = (r: CoreRouter, d: Demand, core: Set<string>, pods: Map<number, Set<string>>, step: string) => {
  for (const [p, files] of pods) assert.deepEqual([...r.share(p)].sort(), [...reference(d, core, files)].sort(), `${step}: pod ${p}`);
};

test('core routed by key: the router lays what a router with no index lays, through edits of the core and the files', async () => {
  const root = tmpDir('core-router-ref');
  const corpus: Record<string, string> = { ...CORPUS, 'app/main.ts': "import { v3 } from '../big/f3';\nexport * from '../lib/index.js';\nexport const t = v3;\n" };
  for (let i = 0; i < 6; i++) corpus[`big/f${i}.ts`] = `export const v${i} = "s${i}";\n`;
  for (const [f, t] of Object.entries(corpus)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const files = Object.keys(corpus).sort();
  const scans = new Map(files.map((f) => [f, scanOne(root, f)]));
  const core = new Set([...scans.values()].flatMap((s) => [...s.core]));
  const d = (await coreDemand(MODEL, ESCAPES.map((e) => e.rel), new Set([...core].map((l) => cellsOf(l).rel))))!;
  assert.ok(d && d.calc.size > 0, 'the JS model is analysed, a computed position among its keys');
  const r = new CoreRouter(d);
  const pods = new Map<number, Set<string>>();
  r.core(core, []);
  for (const f of files) {
    const p = f.startsWith('app/') ? 1 : f.startsWith('big/') ? 2 : 0;
    pods.set(p, new Set([...pods.get(p) ?? [], ...scans.get(f)!.facts]));
    r.files(p, scans.get(f)!.facts, []);
  }
  r.route();
  sameAsReference(r, d, core, pods, 'loaded');
  const gone = [...r.share(1)].filter((l) => cellsOf(l).rel === 'fs_file_in').sort()[0]!;
  const s = '"core-router-ref-probe"';
  const probe = [`str_segs[code](${s}, 1).`, `str_char0[code](${s}, "c").`, `str_seg[code](${s}, 0, ${s}).`];
  r.core(probe, [gone]);
  core.delete(gone);
  for (const l of probe) core.add(l);
  r.route();
  sameAsReference(r, d, core, pods, 'a listing fact out, a string in');
  const main = scans.get('app/main.ts')!.facts;
  r.files(1, [], main);
  pods.set(1, new Set([...pods.get(1)!].filter((l) => !main.has(l))));
  r.route();
  sameAsReference(r, d, core, pods, 'app/main.ts out');
  r.files(1, main, []);
  pods.set(1, new Set([...pods.get(1)!, ...main]));
  r.route();
  sameAsReference(r, d, core, pods, 'app/main.ts back');
});

// A PROGRAM OF MORE GROUPS THAN ONE WORD HOLDS: a chain c0 -> c1 -> ... -> c39, each link keyed by the one before (40
// groups); `cross` keyed by c5's values beside c0's, numbered after the chain, so a value of c5 is held at a group of
// each word; `pair` keyed at two open positions, the second held last; `num` at a constant (i0) beside an open one;
// `one` by existence. The pod holds only `seed("v0")`.
test('core routed by key: a program of more groups than one word of bits, keys of two open positions and a constant', () => {
  const N = 40, src = (s: string[], v: string[] = []) => ({ sources: new Set(s), values: new Set(v) });
  const keys = new Map<string, Key[]>();
  for (let i = 0; i < N; i++) keys.set(`c${i}`, [{ at: [0], from: [src([i === 0 ? 'seed#0' : `c${i - 1}#1`])], exists: false }]);
  keys.set('cross', [{ at: [0], from: [src(['c5#1', 'c0#1'])], exists: false }]);
  keys.set('pair', [{ at: [0, 1], from: [src(['c5#1']), src(['c35#1'])], exists: false }]);
  keys.set('num', [{ at: [0, 1], from: [src(['c10#1']), src([], ['i0'])], exists: false }]);
  keys.set('one', [{ at: [0], from: [src(['c20#1'])], exists: true }]);
  const d: Demand = { keys, sources: new Set(['seed#0']), values: new Set(['i0']), calc: new Map() };
  const core = new Set<string>();
  for (let i = 0; i < N; i++) { core.add(`c${i}("v${i}", "v${i + 1}").`); core.add(`c${i}("w${i}", "w${i + 1}").`); }
  for (const l of ['cross("v6", "x").', 'cross("w6", "x").', 'pair("v6", "v36").', 'pair("v6", "w36").', 'num("v11", 0).', 'num("v11", 1).',
    'num("w11", 0).', 'one("v21", "b").', 'one("v21", "a").', 'one("w21", "a").']) core.add(l);
  const r = new CoreRouter(d);
  r.core(core, []);
  const pod = new Set(['seed("v0").']);
  r.files(0, pod, []);
  r.route();
  const laid = [...r.share(0)].sort();
  assert.ok(laid.includes(`c${N - 1}("v${N - 1}", "v${N}").`), 'the chain is laid to its end');
  for (const l of ['cross("v6", "x").', 'pair("v6", "v36").', 'num("v11", 0).', 'one("v21", "a").']) assert.ok(laid.includes(l), `${l} is laid`);
  for (const l of ['pair("v6", "w36").', 'num("v11", 1).', 'one("v21", "b").', 'c0("w0", "w1").']) assert.ok(!laid.includes(l), `${l} is not`);
  sameAsReference(r, d, core, new Map([[0, pod]]), 'one word and more');
});
