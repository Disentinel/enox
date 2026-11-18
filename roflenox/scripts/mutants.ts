// The mutation gate (r_mutation_gate): proof that the tests can say NO.
//
// Each mutant in scripts/mutants.json disables one check — a few exact text
// edits to one source file — and names the tests that must go RED under it.
// The gate applies every mutant to a private copy of the tree, runs just its
// named tests there, and FAILS if any of them still passes (the mutant
// survived) or if an edit's anchor no longer matches exactly once (the code
// moved and the mutant would silently test nothing). Survivors by design are
// listed with the reason and not run.
//
//   npm run mutants                         every mutant of test/, in shards (--shards auto)
//   npm run mutants:perf                    the mutants whose red tests are in test/perf
//   npm run hermetic5                       the mutants whose red tests are in test/hermetic5
//
// A BASELINE comes first: every red test the run names is run once on the
// unmutated tree, and one that fails (or does not run) there fails the gate
// as BASELINE — a test that is already red would make every mutant naming it
// a free kill.
//   npm run mutants -- --only M2,M14        some of them
//   npm run mutants -- --extra more.json    add mutants (same shape) — the gate's own test uses this
//   npm run mutants -- --workers 8
//   npm run mutants -- --shard 1/2         one shard: half of the mutants by their cost (read from the costs kept now)
//   npm run mutants -- --shards 2          every shard at once, each its own process (1 worker) with its own budget,
//                                          cut once here and each given its mutants by id
//   npm run mutants -- --shards 18 --plan P.json      the cut alone, written to P.json: each shard's mutant ids
//   npm run mutants -- --from P.json --job 2/6        the shards of P.json whose number is 2 modulo 6, at once as above:
//                                          one job of a CI matrix (.github/workflows/fkts.yml), every job the same cut
//
// A mutant with `on: ["linux"]` breaks what only that kernel shows; elsewhere
// it is listed as not judged here, with the reason, and not run.
//
// Budget: the whole run prints its duration and must stay under 300 s, and a
// shard under 120 s (the repo's limit on one run). `npm run mutants` runs the
// list as shards in parallel, cut by what each mutant COST the last time it
// ran (measured, kept in node_modules/.cache/roflenox-mutants/costs.json; a
// mutant never measured is estimated by its file's measured ones, else by
// COST below): a test file's mutants stay in one shard, so its setup is paid
// once, unless they weigh more than a shard's share, and then they are dealt
// out over the shards.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BUDGET_MS = 300_000;
/** One shard is one run: at most 120 s; auto cuts shards to about TARGET_MS of measured mutants each, the rest of
 *  the budget left to the shard's baseline (a pods shard's: ~40 s under load) and to load. */
const SHARD_BUDGET_MS = 120_000;
const TARGET_MS = 60_000;
/** What one ordinary mutant costs when nothing was measured (2026-09-27). */
const UNIT_MS = 1_700;
const COSTS = path.join(ROOT, 'node_modules', '.cache', 'roflenox-mutants', 'costs.json');
/** A shard tells the run that started it what each mutant cost, on its stdout, by this tag. */
const COST_TAG = 'mutant-cost ';

interface Mutant { id: string; title: string; file: string; edits: ([string, string] | [string, string, string])[]; red?: string[]; survivor?: string; on?: string[] }

function args(): { only: Set<string> | null; extra: string | null; workers: number; suite: string; shard: [number, number] | null; part: string | null; shards: number | 'auto' | null;
  plan: string | null; from: string | null; job: [number, number] | null } {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] ?? null : null; };
  const only = get('--only');
  const sh = get('--shard')?.split('/').map(Number);
  const jb = get('--job')?.split('/').map(Number);
  return { only: only !== null ? new Set(only.split(',').filter(Boolean)) : null, extra: get('--extra'), suite: a.includes('--perf') ? 'perf' : get('--suite') ?? 'test',
    workers: Number(get('--workers') ?? Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)))),
    part: get('--part'),
    shard: sh && sh.length === 2 && sh[0]! >= 1 && sh[0]! <= sh[1]! ? [sh[0]!, sh[1]!] : null,
    shards: get('--shards') === 'auto' ? 'auto' : get('--shards') !== null ? Number(get('--shards')) : null,
    plan: get('--plan'), from: get('--from'),
    job: jb && jb.length === 2 && jb[0]! >= 1 && jb[0]! <= jb[1]! ? [jb[0]!, jb[1]!] : null };
}

/** What one mutant of a file costs, in ordinary mutants, where none of the
 *  file's mutants was ever measured (a fresh clone): the durability file kills
 *  and restarts child processes (2026-09-27); a pods mutant stands up a
 *  federation of engines and waits out the oracle's 15 s (2026-11-18). */
const COST: Record<string, number> = { 'test/durability.test.ts': 3, 'test/pods.test.ts': 15, 'test/pods-probe.test.ts': 15 };

function readCosts(): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(COSTS, 'utf8')) as Record<string, number>; } catch { return {}; }
}
function writeCosts(measured: Map<string, number>): void {
  if (measured.size === 0) return;
  // Smoothed: a run on a loaded machine measures every mutant slower, and taken whole it would cut more shards,
  // which load the machine more.
  const all = readCosts();
  for (const [id, ms] of measured) all[id] = all[id] === undefined ? ms : Math.round((all[id] + ms) / 2);
  fs.mkdirSync(path.dirname(COSTS), { recursive: true });
  const tmp = `${COSTS}.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 1)}\n`);
  fs.renameSync(tmp, COSTS);
}

/** Each mutant's cost in ms: as measured, else the mean of its file's measured mutants, else its file's COST. */
function costsOf(list: Mutant[], byFile: Map<string, Mutant[]>): Map<Mutant, number> {
  const measured = readCosts();
  const out = new Map<Mutant, number>();
  for (const [f, ms] of byFile) {
    const known = ms.map((m) => measured[m.id]).filter((x): x is number => typeof x === 'number');
    const guess = known.length ? known.reduce((a, b) => a + b, 0) / known.length : (COST[f] ?? 1) * UNIT_MS;
    for (const m of ms) out.set(m, measured[m.id] ?? guess);
  }
  return new Map(list.map((m) => [m, out.get(m)!]));
}

function byFileOf(list: Mutant[]): Map<string, Mutant[]> {
  const byFile = new Map<string, Mutant[]>();
  for (const m of list) {
    const f = filesFor(ROOT, (m.red ?? []).slice(0, 1))[0] ?? '';
    byFile.set(f, [...(byFile.get(f) ?? []), m]);
  }
  return byFile;
}

/** Split mutants into `n` shards by the test file of their first red test: heaviest first onto the lightest shard,
 *  so shards come out even and deterministic. A file whose mutants weigh more than a shard's share is dealt out
 *  mutant by mutant. */
function shardOf(list: Mutant[], n: number): Map<Mutant, number> {
  const byFile = byFileOf(list);
  const cost = costsOf(list, byFile);
  const share = [...cost.values()].reduce((a, b) => a + b, 0) / n;
  const units: [string, Mutant[], number][] = [];
  for (const [f, ms] of byFile) {
    const w = ms.reduce((a, m) => a + cost.get(m)!, 0);
    if (w <= share) units.push([f, ms, w]); else for (const m of ms) units.push([`${f}#${m.id}`, [m], cost.get(m)!]);
  }
  const weight = Array.from({ length: n }, () => 0);
  const out = new Map<Mutant, number>();
  for (const [, ms, w] of units.sort((x, y) => y[2] - x[2] || (x[0] < y[0] ? -1 : 1))) {
    const k = weight.indexOf(Math.min(...weight));
    weight[k] += w;
    for (const m of ms) out.set(m, k + 1);
  }
  return out;
}

/** Every shard as its own process, in parallel, each given its mutants by id (cut here once, so every shard reads
 *  the same costs); fails if any shard fails. */
async function runShards(parts: Mutant[][], passOn: string[], numbers = parts.map((_, i) => i), n = parts.length): Promise<number> {
  const measured = new Map<string, number>();
  const codes = await Promise.all(parts.map((part, k) => new Promise<number>((ok) => {
    const i = numbers[k]!;
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts', 'mutants.ts'),
      ...passOn, '--only', part.map((m) => m.id).join(','), '--part', `${i + 1}/${n}`, '--workers', '1', '--tell-costs'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => {
      const lines = out.replace(/\n+$/, '').split('\n');
      for (const l of lines.filter((x) => x.startsWith(COST_TAG))) { const [id, ms] = l.slice(COST_TAG.length).split(' '); measured.set(id!, Number(ms)); }
      process.stdout.write(`${lines.filter((x) => !x.startsWith(COST_TAG)).map((x) => `[shard ${i + 1}/${n}] ${x}`).join('\n')}\n`);
      ok(code ?? 1);
    });
  })));
  writeCosts(measured);
  const bad = codes.filter((c) => c !== 0).length;
  process.stdout.write(`\n${parts.length - bad}/${parts.length} shards passed\n`);
  return bad === 0 ? 0 : 1;
}

function load(extra: string | null): Mutant[] {
  const list = (JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'mutants.json'), 'utf8')) as { mutants: Mutant[] }).mutants;
  if (extra) list.push(...(JSON.parse(fs.readFileSync(extra, 'utf8')) as { mutants: Mutant[] }).mutants);
  for (const m of list) if (m.on && !m.on.includes(process.platform)) m.survivor ??= `not judged on ${process.platform}: judged on ${m.on.join(', ')} only`;
  return list;
}

/** The suites with gates of their own: a directory under test/ each. */
const SUITES = ['perf', 'hermetic5'];
/** How long one red test of a suite may take (the five nested runs take ~150 s). */
const SLOW: Record<string, number> = { hermetic5: 270_000 };

let suiteNames: Map<string, Set<string>> | null = null;
/** The suite a mutant belongs to, by where its red tests live. */
function suiteOfRed(red: string[]): string {
  suiteNames ??= new Map(SUITES.map((x) => [x, suiteTestNames(x)]));
  return SUITES.find((x) => red.some((n) => suiteNames!.get(x)!.has(n))) ?? 'test';
}

/** Names of the tests defined under test/<suite>. */
function suiteTestNames(suite: string): Set<string> {
  const dir = path.join(ROOT, 'test', suite);
  const names = new Set<string>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.test.ts')) : []) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*test\('((?:[^'\\]|\\.)*)'/gm)) names.add(m[1]!.replace(/\\'/g, "'"));
  }
  return names;
}

/** A private copy of the tree for one worker; mutants never touch ROOT. */
function copyTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roflenox-mutant-'));
  // An executor's installed dependencies and model cache are not source: they
  // are linked, not copied (hundreds of MB), and no mutant edits them.
  const heavy = (p: string) => /[\\/](node_modules|\.models)$/.test(p);
  for (const d of ['src', 'test', 'scripts', 'executors']) {
    fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true, filter: (p) => !heavy(p) });
  }
  for (const ex of fs.readdirSync(path.join(ROOT, 'executors'))) {
    for (const h of ['node_modules', '.models']) {
      const from = path.join(ROOT, 'executors', ex, h);
      if (fs.existsSync(from)) fs.symlinkSync(from, path.join(dir, 'executors', ex, h));
    }
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Test files that define each named test. */
function filesFor(tree: string, names: string[]): string[] {
  const executorTests = fs.existsSync(path.join(tree, 'executors'))
    ? fs.readdirSync(path.join(tree, 'executors')).map((ex) => `executors/${ex}/test`) : [];
  const files = ['test', ...SUITES.map((s) => `test/${s}`), ...executorTests].flatMap((d) => fs.existsSync(path.join(tree, d))
    ? fs.readdirSync(path.join(tree, d)).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(d, f)) : []);
  // A name is found as written, or with its quotes escaped as in a '…' literal;
  // a name found nowhere (a generated one) sends the run to every file.
  const text = new Map(files.map((f) => [f, fs.readFileSync(path.join(tree, f), 'utf8')]));
  const has = (f: string, n: string) => text.get(f)!.includes(n) || text.get(f)!.includes(n.replace(/'/g, "\\'"));
  if (names.some((n) => !files.some((f) => has(f, n)))) return files;
  return files.filter((f) => names.some((n) => has(f, n)));
}

function run(tree: string, names: string[], timeoutMs = 90_000): Promise<{ failed: Set<string>; passed: Set<string>; out: string }> {
  const files = filesFor(tree, names);
  // In-process (isolation none): Node 22's runner can spin forever parsing a
  // child's output when a multi-byte character straddles two chunks — seen
  // here on a mutant whose failure diff carried an em dash (~15% of runs).
  const argv = ['--experimental-strip-types', '--no-warnings', '--test', '--experimental-test-isolation=none', '--test-concurrency=4', `--test-timeout=${timeoutMs}`,
    '--test-force-exit', ...names.map((n) => `--test-name-pattern=^${escape(n)}$`), ...files];
  return new Promise((ok) => {
    // A run started from inside `node --test` inherits NODE_TEST_CONTEXT and
    // would report to that parent instead of printing TAP: drop it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, argv, { cwd: tree, env });
    // A run that does not finish is cut off: its tests count as not run.
    const wall = setTimeout(() => c.kill('SIGKILL'), timeoutMs + 30_000);
    c.on('exit', () => clearTimeout(wall));
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', () => {
      const failed = new Set([...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]!.trim()));
      const passed = new Set([...out.matchAll(/^ok \d+ - (.*)$/gm)].map((m) => m[1]!.trim()));
      ok({ failed, passed, out });
    });
  });
}

type Verdict = { id: string; ok: boolean; line: string };

async function judge(tree: string, m: Mutant): Promise<Verdict> {
  // An edit may name its own file ([from, to, file]); by default the mutant's.
  const byFile = new Map<string, [string, string][]>();
  for (const [from, to, file] of m.edits as [string, string, string?][]) {
    const f = file ?? m.file;
    byFile.set(f, [...(byFile.get(f) ?? []), [from, to]]);
  }
  const pristine = new Map<string, string>();
  for (const [f, edits] of byFile) {
    const orig = fs.readFileSync(path.join(ROOT, f), 'utf8');
    let text = orig;
    for (const [from, to] of edits) {
      const n = text.split(from).length - 1;
      if (n !== 1) {
        for (const [pf, pt] of pristine) fs.writeFileSync(path.join(tree, pf), pt);
        return { id: m.id, ok: false, line: `ANCHOR  ${m.id} ${m.title}: an edit matches ${n} times in ${f}, not once — re-anchor it` };
      }
      text = text.replace(from, to);
    }
    pristine.set(f, orig);
    fs.writeFileSync(path.join(tree, f), text);
  }
  try {
    const red = m.red ?? [];
    if (red.length === 0) return { id: m.id, ok: false, line: `EMPTY   ${m.id}: no tests are named to go red` };
    const r = await run(tree, red, SLOW[suiteOfRed(red)] ?? 90_000);
    const missing = red.filter((n) => !r.failed.has(n) && !r.passed.has(n));
    const alive = red.filter((n) => r.passed.has(n));
    if (missing.length) return { id: m.id, ok: false, line: `NOTRUN  ${m.id} ${m.title}: ${missing.map((n) => `"${n}"`).join(', ')} did not run` };
    if (alive.length) return { id: m.id, ok: false, line: `SURVIVED ${m.id} ${m.title}: still green: ${alive.map((n) => `"${n}"`).join(', ')}` };
    return { id: m.id, ok: true, line: `killed  ${m.id} ${m.title} (${red.length} red)` };
  } finally {
    for (const [f, t] of pristine) fs.writeFileSync(path.join(tree, f), t);
  }
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const { only, extra, workers, suite, shard, part, shards, plan, from, job } = args();
  const cut = new Set(['--shards', '--only', '--plan', '--from', '--job']);
  const passOn = process.argv.slice(2).filter((x, i, a) => !cut.has(x) && !cut.has(a[i - 1]!));
  if (from) {
    if (!job) throw new Error('--from needs --job J/N');
    const ids = (JSON.parse(fs.readFileSync(from, 'utf8')) as { shards: string[][] }).shards;
    const byId = new Map(load(extra).map((m) => [m.id, m]));
    const mine = ids.map((_, i) => i).filter((i) => i % job[1] === job[0] - 1);
    // A shard naming a mutant the list no longer has was cut from another tree: it would test nothing.
    const parts = mine.map((i) => ids[i]!.map((id) => byId.get(id) ?? (() => { throw new Error(`${from} names ${id}, which scripts/mutants.json does not have`); })()));
    return runShards(parts, passOn, mine, ids.length);
  }
  // One gate per suite, each within the budget: the mutants whose red tests
  // live in test/perf (a 200 000-fact log), in test/hermetic5 (five nested
  // runs), and everything else.
  let all = load(extra).filter((m) => (only ? only.has(m.id) : suiteOfRed(m.red ?? []) === suite));
  if (shards !== null && shard === null) {
    // auto: enough shards that each holds about TARGET_MS of what its mutants
    // cost when last measured, leaving the rest of a shard's budget to its
    // baseline and to load.
    const live = all.filter((m) => !m.survivor);
    const total = [...costsOf(live, byFileOf(live)).values()].reduce((a, b) => a + b, 0);
    // More shards than twice the cores only slow each other down.
    const n = shards === 'auto' ? Math.max(2, Math.min(2 * os.cpus().length, Math.ceil(total / TARGET_MS))) : shards;
    const of = shardOf(live, n);
    const parts = Array.from({ length: n }, (_, k) => live.filter((m) => of.get(m) === k + 1));
    parts[0]!.push(...all.filter((m) => m.survivor));
    if (plan) {
      fs.writeFileSync(plan, `${JSON.stringify({ shards: parts.map((p) => p.map((m) => m.id)) })}\n`);
      const cost = costsOf(live, byFileOf(live));
      const w = parts.map((p) => p.reduce((a, m) => a + (cost.get(m) ?? 0), 0) / 1000);
      process.stdout.write(`${all.length} mutants in ${n} shards, written to ${plan}; by the kept costs ${Math.min(...w).toFixed(0)}–${Math.max(...w).toFixed(0)} s each\n`);
      return 0;
    }
    return runShards(parts, passOn);
  }
  if (shard) { const of = shardOf(all.filter((m) => !m.survivor), shard[1]); all = all.filter((m) => (of.get(m) ?? 1) === shard[0]); }
  const survivors = all.filter((m) => m.survivor);
  const queue = all.filter((m) => !m.survivor);
  // The baseline: every named red test, once, on the unmutated tree — and in
  // a suite with a gate of its own, every test of that suite (its gate is the
  // only place those tests run).
  const own = suite !== 'test' && !only && !shard ? [...suiteTestNames(suite)] : [];
  const reds = [...new Set([...queue.flatMap((m) => m.red ?? []), ...own])];
  if (reds.length) {
    const tree = copyTree();
    const b = await run(tree, reds, SLOW[suite] ?? 90_000);
    fs.rmSync(tree, { recursive: true, force: true });
    const broken = reds.filter((n) => !b.passed.has(n));
    for (const n of broken) process.stdout.write(`BASELINE "${n}" ${b.failed.has(n) ? 'fails' : 'does not run'} on the unmutated tree: no mutant naming it can count as killed\n`);
    if (broken.length) {
      // The run's own words, so the cause is read here, not guessed.
      const tail = b.out.split('\n').filter((l) => /^\s*(not ok|error:|# (tests|pass|fail|cancelled))|Error|timed out/.test(l)).slice(0, 40);
      process.stdout.write(`${tail.map((l) => `  | ${l}`).join('\n')}\n`);
      process.stdout.write(`\n0/${queue.length} mutants judged, ${broken.length} broken baseline; ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
      return 1;
    }
    process.stdout.write(`baseline: ${reds.length} red tests pass on the unmutated tree; ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  }
  const verdicts: Verdict[] = [];
  const costs = new Map<string, number>();
  const trees: string[] = [];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, queue.length)) }, async () => {
    const tree = copyTree();
    trees.push(tree);
    for (let m = queue.shift(); m; m = queue.shift()) {
      const t = Date.now();
      const v = await judge(tree, m);
      if (v.ok) costs.set(m.id, Date.now() - t);
      verdicts.push(v);
      process.stdout.write(`${v.line}\n`);
    }
  }));
  for (const t of trees) fs.rmSync(t, { recursive: true, force: true });
  // What each mutant cost, for the next run's shards: told to the run that started this shard, or kept here.
  if (process.argv.includes('--tell-costs')) for (const [id, c] of costs) process.stdout.write(`${COST_TAG}${id} ${c}\n`);
  else writeCosts(costs);
  for (const s of survivors) process.stdout.write(`survivor-by-design ${s.id} ${s.title}: ${s.survivor}\n`);
  const bad = verdicts.filter((v) => !v.ok);
  const ms = Date.now() - t0;
  process.stdout.write(`\n${verdicts.length - bad.length}/${verdicts.length} mutants killed, ${survivors.length} survivors by design, ${bad.length} failing; ${(ms / 1000).toFixed(1)} s\n`);
  // A shard of the main suite is one run, held to the repo's limit; the perf and hermetic5 gates keep the whole budget.
  const one = (shard || part) && suite === 'test';
  const budget = one ? SHARD_BUDGET_MS : BUDGET_MS;
  if (ms > budget) process.stdout.write(`\n*** ${one ? 'SHARD' : 'GATE'} OVER BUDGET: ${(ms / 1000).toFixed(1)} s > ${budget / 1000} s — the gate FAILS ***\n`);
  return bad.length === 0 && ms <= budget ? 0 : 1;
}

main().then((c) => process.exit(c), (e: Error) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
