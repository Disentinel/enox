// THE CORE A POD HOLDS, at scale, with no engine (src/federation.ts CoreRouter):
//
//   node --experimental-strip-types --no-warnings scripts/core-scale.ts ROOT PODS [PREFIX...]
//
// Every code file under ROOT (those under a PREFIX, when given; tests left out) is scanned alone, as the pods
// harness scans them; the files, in path order, are cut into PODS contiguous ranges; the router routes the core by
// the JS model's keys. Prints, as JSON: files, the corpus's core, each pod's share, and the share by relation of the
// largest; then, for one file of pod 0 edited by a string of its own, how many pods the core's change reaches.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cellsOf, coreDemand, CoreRouter } from '../src/federation.ts';
import { ESCAPES, MODEL, scanOne } from '../test/pods-harness.ts';

const [root, n = '4', ...prefixes] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!root) { console.error('usage: scripts/core-scale.ts ROOT PODS [PREFIX...]'); process.exit(1); }
const CODE = /\.(js|ts|tsx|mjs|cjs|jsx|mts|cts)$/, NOT_CODE = /\.d\.[mc]?ts$|\.min\.js$/;
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test' && !e.name.startsWith('.')) walk(rel); } else if (CODE.test(e.name) && !NOT_CODE.test(e.name)) files.push(rel);
  }
};
walk('');
const mine = files.filter((f) => prefixes.length === 0 || prefixes.some((p) => f.startsWith(p)));
const pods = Number(n), per = Math.ceil(mine.length / pods);
const t0 = performance.now();
// Two passes, so that no file's facts are held: the core first (the program's keys are read against its relations),
// then each file's facts counted into its pod.
const core = new Map<string, number>();
for (const f of mine) for (const l of scanOne(root, f).core) core.set(l, (core.get(l) ?? 0) + 1);
const d = await coreDemand(MODEL, ESCAPES.map((e) => e.rel), new Set([...core.keys()].map((l) => cellsOf(l).rel)));
const r = new CoreRouter(d);
r.core(core.keys(), []);
mine.forEach((f, k) => r.files(Math.floor(k / per), scanOne(root, f).facts, []));
const scanMs = performance.now() - t0;
const t1 = performance.now();
r.route();
const routeMs = performance.now() - t1;
const sizes = Array.from({ length: pods }, (_, i) => r.share(i).size);
const big = sizes.indexOf(Math.max(...sizes));
const by: Record<string, number> = {}, all: Record<string, number> = {};
for (const l of r.share(big)) { const k = cellsOf(l).rel; by[k] = (by[k] ?? 0) + 1; }
for (const l of core.keys()) { const k = cellsOf(l).rel; all[k] = (all[k] ?? 0) + 1; }
// One file of pod 0 gains a string no other file holds: the core's change, routed.
const s = '"pods-core-scale-probe"';
const probe = [`str_segs[code](${s}, 1).`, `str_char0[code](${s}, "p").`, `str_seg[code](${s}, 0, ${s}).`];
r.core(probe, []);
r.files(0, [`ast_attr[code](n0000000000000000_1, value, ${s}).`], []);
const touched = r.route().size;
console.log(JSON.stringify({ root, prefixes, files: mine.length, pods, scan_ms: Math.round(scanMs), route_ms: Math.round(routeMs), corpus_core: core.size,
  core_by_relation: all, share_per_pod: sizes, largest_share_by_relation: by, a_new_string_reaches_pods: touched }, null, 1));
