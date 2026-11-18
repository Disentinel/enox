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
import { cellsOf, coreDemand, CoreRouter } from '../src/federation.ts';
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
