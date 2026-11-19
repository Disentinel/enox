// A FEDERATION OVER A CORPUS LARGER THAN THE MACHINE HOLDS AT ONCE (src/federation.ts, test/pods-harness.ts):
//
//   node --experimental-strip-types --no-warnings scripts/pods-big.ts ROOT PER [--at-once K] [--oracle] [--out F.json]
//
// Every code file under ROOT (tests left out, unless --tests or --oracle: the oracle scans them), in path order, is cut into pods of PER files. The core is routed for
// all of them first; then the pods run K at a time: each is a node of its own with an engine over its files and its
// share of the core, publishes its escaping rows as a signed batch, the coordinator pulls the feed, and the pod is
// closed (its batch stays with the coordinator). One pod is kept open to the end and one of its files is edited.
// So the peak is K pods and the coordinator, whatever the corpus. Prints one JSON object; with --out, the answer's
// rows too (to hold two cuts of the same corpus against each other). --oracle evaluates ROOT whole in one engine
// and holds the answer against it: only where one engine holds the corpus.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import type { Fact } from '../src/facts.ts';
import { cellsOf, coreDemand, CoreRouter, decodeRules, Pod, type Published } from '../src/federation.ts';
import { ESCAPES, MODEL, QUESTION, RULES, rssOf, scanOne, wholeWorld } from '../test/pods-harness.ts';
import { invitation, pull, start, subscribe, tmpDir, vouch, type Clock } from '../test/helpers.ts';

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const [root, perArg] = argv.filter((a, i) => !a.startsWith('--') && !['--at-once', '--out', '--rule-budget'].includes(argv[i - 1] ?? ''));
if (!root || !perArg) { console.error('usage: scripts/pods-big.ts ROOT PER [--at-once K] [--oracle] [--out F.json]'); process.exit(1); }
const per = Number(perArg), atOnce = Number(flag('--at-once') ?? 3), out = flag('--out'), oracle = argv.includes('--oracle'), ruleBudget = flag('--rule-budget') ? Number(flag('--rule-budget')) : undefined, follows = !argv.includes('--no-follows'), tests = oracle || argv.includes('--tests');

const CODE = /\.(js|ts|tsx|mjs|cjs|jsx|mts|cts)$/, NOT_CODE = /\.d\.[mc]?ts$|\.min\.js$/;
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && (tests || e.name !== 'test') && !e.name.startsWith('.')) walk(rel); } else if (CODE.test(e.name) && !NOT_CODE.test(e.name)) files.push(rel);
  }
};
walk('');
const n = Math.ceil(files.length / per);
const podOf = (k: number) => Math.floor(k / per);
const ms = (x: number) => Math.round(x), mb = (x: number) => Math.round(x);
const wall = (): Clock => ({ get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } }) as Clock;
const avail = () => Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.existsSync('/proc/meminfo') ? fs.readFileSync('/proc/meminfo', 'utf8') : '')?.[1] ?? 0) / 1024);
let leastAvail = Infinity, peakSelf = 0;
const say = (s: string) => { const a = avail(), me = Math.round(process.memoryUsage().rss / 1048576); leastAvail = Math.min(leastAvail, a); peakSelf = Math.max(peakSelf, me); process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${s} [this process ${me} MB, the machine has ${a} MB left]\n`); };
const rowKey = (cells: unknown[]) => JSON.stringify(cells.map(String));

// The core, then the routing: two passes, so that no file's facts are held.
const t0 = performance.now();
const core = new Map<string, number>();
const shareOf = new Map<string, Set<string>>();
for (const f of files) for (const l of scanOne(root, f).core) core.set(l, (core.get(l) ?? 0) + 1);
const router = new CoreRouter(await coreDemand(MODEL, ESCAPES.map((e) => e.rel), new Set([...core.keys()].map((l) => cellsOf(l).rel))));
router.core(core.keys(), []);
let fileFacts = 0;
files.forEach((f, k) => { const one = scanOne(root, f); fileFacts += one.facts.size; router.files(podOf(k), one.facts, []); });
const scanMs = performance.now() - t0;
const t1 = performance.now();
router.route();
const routeMs = performance.now() - t1;
const shares = Array.from({ length: n }, (_, i) => router.share(i).size);
say(`${files.length} files, ${n} pods of ${per}; core ${core.size}; scanned twice in ${ms(scanMs)} ms, routed in ${ms(routeMs)} ms`);

const coord = await start(tmpDir('big-coord'), 'coordinator', { clock: wall(), ...(ruleBudget ? { ruleBudget } : {}) });
const rule = (text: string, i: number): Fact => ({ source: `pods-${i}`, relation: 'fkts:rule', target: text, perspective: 'rules', confidence: 1 });
await publish(coord.url, coord.me, [...RULES, ...decodeRules(ESCAPES)].map(rule));
const sub = await subscribe(coord.url, `/subscribe?query=${encodeURIComponent(QUESTION)}`, { authorization: `Bearer ${coord.node.operatorToken()}` });
if (sub.status !== 200) throw new Error(JSON.stringify(sub.body));
/** The frames that came are taken (the stream adds a frame's rows up when it is taken), until none comes for `quiet` ms. */
const odd: string[] = [];
const frames: Record<string, number> = {};
let saidUnknown = false;
const drain = async (quiet: number) => {
  for (;;) {
    let f;
    try { f = await sub.next(quiet); } catch (e) { if (!String(e).includes('no frame within')) { odd.push(String(e).slice(0, 200)); say(`the stream: ${String(e).slice(0, 200)}`); } return; }
    const k = f as unknown as { kind: string; cause?: string; rows?: unknown[]; reason?: string; unknown?: unknown; by?: string; why?: string };
    frames[k.kind + (k.by ? ` by ${k.by}` : '')] = (frames[k.kind + (k.by ? ` by ${k.by}` : '')] ?? 0) + 1;
    if (k.unknown || (k.kind !== 'delta' && k.cause !== 'start')) { const t = `${k.kind} ${k.by ?? ''} ${k.why ?? ''} ${k.rows?.length ?? '-'} rows${k.unknown ? ` UNKNOWN ${JSON.stringify(k.unknown).slice(0, 300)}` : ''}`; if (odd.length < 40) odd.push(`after ${ran.length} pods: ${t}`); if (odd.length < 12 || k.unknown && !saidUnknown) say(`a frame: ${t}`); if (k.unknown) saidUnknown = true; }
  }
};
const coordEngine = () => rssOf((coord.node as unknown as { engine: { port: { child: { pid: number } } } }).engine.port.child.pid);

interface Ran { pod: number; files: number; core: number; file_facts: number; rows: number; facts: number; engine_ms: number; engine_mb: number; follow_ms: number; pull_ms: number }
const ran: Ran[] = [];
let chain: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(f: () => Promise<T>): Promise<T> => { const r = chain.then(f); chain = r.catch(() => {}); return r; };
let kept: { pod: Pod; node: Awaited<ReturnType<typeof start>>; name: string; i: number; facts: Map<string, Set<string>> } | null = null;
let peakCoord = 0;

const walls: { pod: number; files: number; bytes: number; largest: string; core: number; file_facts: number; alone: boolean; said: string }[] = [];
const again: number[] = [];

async function runPod(i: number, alone = false): Promise<void> {
  const mine = files.filter((_f, k) => podOf(k) === i);
  const facts = new Map<string, Set<string>>();
  for (const f of mine) { const one = scanOne(root, f); facts.set(f, one.facts); if (i === 0) shareOf.set(f, one.core); }
  const name = `pod-${i}`;
  const node = await start(tmpDir(`big-${i}`), name, { clock: wall() });
  await vouch(node, coord.me);
  await publish(node.url, node.me, [{ source: 'coordinator', relation: 'fkts:grant', target: '2100-01-01T00:00:00.000Z', perspective: 'policy', confidence: 1 }]);
  let started: Awaited<ReturnType<typeof Pod.start>>;
  try {
    started = await Pod.start({ program: MODEL, escapes: ESCAPES, publish: async (f: Fact[]) => { await publish(node.url, node.me, f); } }, router.share(i), facts);
  } catch (e) {
    // A pod that stops at a wall says so and publishes nothing: it is run again alone, and if it stops again it is told.
    await node.stop();
    const sizes = mine.map((f) => [f, fs.statSync(path.join(root, f)).size] as const).sort((a, b) => b[1] - a[1]);
    say(`pod ${i} stopped${alone ? ' alone' : ''}: ${String(e).slice(0, 160)}`);
    if (!alone) { again.push(i); return; }
    walls.push({ pod: i, files: mine.length, bytes: sizes.reduce((a, s) => a + s[1], 0), largest: `${sizes[0]![0]} (${sizes[0]![1]} bytes)`, core: shares[i]!, file_facts: [...facts.values()].reduce((a, s) => a + s.size, 0), alone, said: String(e).slice(0, 300) });
    return;
  }
  const { pod, published: p } = started;
  const engineMb = rssOf((pod as unknown as { port: { child: { pid: number } } }).port.child.pid);
  let followMs = 0;
  const pullMs = await oneAtATime(async () => {
    const t = performance.now();
    // The pod is written down as followed: without it the coordinator's rules do not read the pod's book. That batch
    // moves access, and the rule world is built anew for it (--no-follows: the control, an empty answer).
    if (follows) await publish(coord.url, coord.me, [{ source: name, relation: 'fkts:follow', target: invitation(node), perspective: 'follows', confidence: 1 }]);
    followMs = performance.now() - t;
    await pull(coord, invitation(node), name, coord.me);
    peakCoord = Math.max(peakCoord, coordEngine());
    return performance.now() - t - followMs;
  });
  ran.push({ pod: i, files: mine.length, core: shares[i]!, file_facts: [...facts.values()].reduce((a, s) => a + s.size, 0), rows: p.added, facts: p.facts, engine_ms: ms(p.ms.engine), engine_mb: mb(engineMb), follow_ms: ms(followMs), pull_ms: ms(pullMs) });
  if (out) fs.appendFileSync(`${out}.pods.tsv`, `${Object.values(ran[ran.length - 1]!).join('\t')}\t${new Date().toISOString().slice(11, 19)}\n`);
  if (i === 0 && !kept) kept = { pod, node, name, i, facts }; else { await pod.close(); await node.stop(); }
  if (ran.length % 10 === 0 || alone) await oneAtATime(() => drain(0));
  if (ran.length % 10 === 0 || alone) say(`${ran.length}/${n} pods; the coordinator's engine ${mb(coordEngine())} MB, ${sub.rows.size} rows at the subscriber`);
}

const t2 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: Math.min(atOnce, n) }, async () => { while (next < n) await runPod(next++); }));
for (const i of again) await runPod(i, true);
await oneAtATime(() => drain(3000));
const podsMs = performance.now() - t2;
const rows = [...sub.rows.values()].map((r) => rowKey(r.cells)).sort();
const digest = createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
say(`all pods in ${ms(podsMs)} ms; ${rows.length} rows, ${digest}`);

// One file of the pod kept open gains an export: its pod takes the delta, the coordinator pulls, the subscriber is told.
let edit: Record<string, unknown> = {};
let restore: (() => void) | null = null;
if (out) fs.writeFileSync(out, JSON.stringify({ before_the_edit: true, pods: ran, rows }, null, 1));
if (kept) try {
  const k = kept as NonNullable<typeof kept>;
  const file = [...k.facts.keys()].find((f) => /\.ts$/.test(f))!;
  const before = sub.rows.size;
  const te = performance.now();
  const original = fs.readFileSync(path.join(root, file), 'utf8');
  if (!oracle) restore = () => fs.writeFileSync(path.join(root, file), original);   // the corpus is left as it was
  fs.appendFileSync(path.join(root, file), '\nexport function fktsBigRunProbe(): number { return 1; }\n');
  const now = scanOne(root, file), was = { facts: k.facts.get(file)!, core: shareOf.get(file)! };
  const coreIn = [...now.core].filter((l) => !was.core.has(l) && !core.has(l));
  router.core(coreIn, []);
  router.files(0, [...now.facts].filter((l) => !was.facts.has(l)), [...was.facts].filter((l) => !now.facts.has(l)));
  const moved = router.route();
  const p: Published = await k.pod.edit(file, now.facts, router.share(0));
  await pull(coord, invitation(k.node), k.name, coord.me);
  while (sub.rows.size === before) await sub.next(60_000);
  await drain(500);
  edit = { file, core_in: coreIn.length, pods_the_core_change_reaches: moved.size, by: p.by, pod_engine_ms: ms(p.ms.engine), rows_added: p.added, frame_ms_after_the_edit: ms(performance.now() - te), rows_after: sub.rows.size };
  await k.pod.close(); await k.node.stop();
} catch (e) { edit = { failed: String(e).slice(0, 300) }; } finally { restore?.(); }

const stat = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum: s.reduce((a, b) => a + b, 0) }; };
const result: Record<string, unknown> = {
  root, files: files.length, pods: n, per, at_once: atOnce,
  scan_twice_ms: ms(scanMs), route_ms: ms(routeMs), corpus_core: core.size, file_facts: fileFacts,
  core_per_pod: stat(shares), pod_engine_ms: stat(ran.map((r) => r.engine_ms)), pod_engine_mb: stat(ran.map((r) => r.engine_mb)),
  pod_rows_published: stat(ran.map((r) => r.rows)), follow_ms: stat(ran.map((r) => r.follow_ms)), pull_ms: stat(ran.map((r) => r.pull_ms)),
  follow_and_pull_ms_first_and_last_ten: { first: ran.slice(0, 10).map((r) => [r.follow_ms, r.pull_ms]), last: ran.slice(-10).map((r) => [r.follow_ms, r.pull_ms]) },
  all_pods_wall_ms: ms(podsMs), coordinator_engine_mb: { peak: mb(peakCoord), end: mb(coordEngine()) }, this_process_mb: { peak_seen: peakSelf, end: mb(process.memoryUsage().rss / 1048576) }, machine_mb_left_least_seen: leastAvail,
  rule_budget: ruleBudget ?? 'default (50 000 steps)', follows_published: follows, frames, frames_full_or_unknown: odd, pods_run_again_alone: again, pods_stopped_at_a_wall: walls,
  answer_rows: rows.length, answer_digest: digest, edit,
};
if (oracle) {
  const w = await wholeWorld(root);   // after the edit: the corpus as it now stands
  const have = new Set([...sub.rows.values()].map((r) => rowKey(r.cells)));
  result.whole = { ms: ms(w.ms), engine_mb: mb(w.rss), facts: w.facts, rows: w.rows.size, equal: have.size === w.rows.size && [...w.rows].every((r) => have.has(r)),
    only_whole: [...w.rows].filter((r) => !have.has(r)).slice(0, 5), only_pods: [...have].filter((r) => !w.rows.has(r)).slice(0, 5) };
}
if (out) fs.writeFileSync(out, JSON.stringify({ result, pods: ran.sort((a, b) => a.pod - b.pod), rows }, null, 1));
console.log(JSON.stringify(result, null, 1));
sub.close();
await coord.stop();
process.exit(0);
