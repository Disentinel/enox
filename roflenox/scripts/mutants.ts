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
//   npm run mutants -- --shard 1/2         one shard: the mutants whose red tests live in half of the test files
//   npm run mutants -- --shards 2          every shard at once, each its own process (1 worker) with its own budget
//
// Budget: the whole run prints its duration and must stay under 300 s. As the
// list grows, `npm run mutants` runs it as shards in parallel (by test file,
// so each file's setup is paid in one shard), and each shard keeps the budget.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BUDGET_MS = 300_000;

interface Mutant { id: string; title: string; file: string; edits: ([string, string] | [string, string, string])[]; red?: string[]; survivor?: string }

function args(): { only: Set<string> | null; extra: string | null; workers: number; suite: string; shard: [number, number] | null; shards: number | 'auto' | null } {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] ?? null : null; };
  const only = get('--only');
  const sh = get('--shard')?.split('/').map(Number);
  return { only: only ? new Set(only.split(',')) : null, extra: get('--extra'), suite: a.includes('--perf') ? 'perf' : get('--suite') ?? 'test',
    workers: Number(get('--workers') ?? Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)))),
    shard: sh && sh.length === 2 && sh[0]! >= 1 && sh[0]! <= sh[1]! ? [sh[0]!, sh[1]!] : null,
    shards: get('--shards') === 'auto' ? 'auto' : get('--shards') !== null ? Number(get('--shards')) : null };
}

/** Split mutants into `n` shards by the test file of their first red test:
 *  files largest-first onto the lightest shard, so shards come out even and
 *  deterministic. */
/** What one mutant of a file costs, in ordinary mutants (~1.7 s), as measured
 *  2026-09-27: the durability file kills and restarts child processes. (The
 *  whole-suite nested runs are the hermetic5 gate's.) */
const COST: Record<string, number> = { 'test/durability.test.ts': 3 };

function shardOf(list: Mutant[], n: number): Map<Mutant, number> {
  const byFile = new Map<string, Mutant[]>();
  for (const m of list) {
    const f = filesFor(ROOT, (m.red ?? []).slice(0, 1))[0] ?? '';
    byFile.set(f, [...(byFile.get(f) ?? []), m]);
  }
  const weight = Array.from({ length: n }, () => 0);
  const out = new Map<Mutant, number>();
  const cost = ([f, ms]: [string, Mutant[]]) => ms.length * (COST[f] ?? 1);
  for (const [f, ms] of [...byFile].sort((x, y) => cost(y) - cost(x) || (x[0] < y[0] ? -1 : 1))) {
    const k = weight.indexOf(Math.min(...weight));
    weight[k] += cost([f, ms]);
    for (const m of ms) out.set(m, k + 1);
  }
  return out;
}

/** Every shard as its own process, in parallel; fails if any shard fails. */
async function runShards(n: number, passOn: string[]): Promise<number> {
  const codes = await Promise.all(Array.from({ length: n }, (_, i) => new Promise<number>((ok) => {
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts', 'mutants.ts'),
      ...passOn, '--shard', `${i + 1}/${n}`, '--workers', '1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => { process.stdout.write(`${out.replace(/\n+$/, '').replace(/^/gm, `[shard ${i + 1}/${n}] `)}\n`); ok(code ?? 1); });
  })));
  const bad = codes.filter((c) => c !== 0).length;
  process.stdout.write(`\n${n - bad}/${n} shards passed\n`);
  return bad === 0 ? 0 : 1;
}

function load(extra: string | null): Mutant[] {
  const list = (JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'mutants.json'), 'utf8')) as { mutants: Mutant[] }).mutants;
  if (extra) list.push(...(JSON.parse(fs.readFileSync(extra, 'utf8')) as { mutants: Mutant[] }).mutants);
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
  const { only, extra, workers, suite, shard, shards } = args();
  // One gate per suite, each within the budget: the mutants whose red tests
  // live in test/perf (a 200 000-fact log), in test/hermetic5 (five nested
  // runs), and everything else.
  let all = load(extra).filter((m) => (only ? only.has(m.id) : suiteOfRed(m.red ?? []) === suite));
  if (shards !== null && shard === null) {
    // auto: enough shards that each stays well inside the budget at the
    // measured ~1.7 s a mutant (up to 4 s under load), plus its share of the
    // baseline: 50 a shard.
    const n = shards === 'auto' ? Math.max(2, Math.ceil(all.filter((m) => !m.survivor).length / 50)) : shards;
    return runShards(n, process.argv.slice(2).filter((x, i, a) => x !== '--shards' && a[i - 1] !== '--shards'));
  }
  if (shard) { const of = shardOf(all, shard[1]); all = all.filter((m) => of.get(m) === shard[0]); }
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
  const trees: string[] = [];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, queue.length)) }, async () => {
    const tree = copyTree();
    trees.push(tree);
    for (let m = queue.shift(); m; m = queue.shift()) {
      const v = await judge(tree, m);
      verdicts.push(v);
      process.stdout.write(`${v.line}\n`);
    }
  }));
  for (const t of trees) fs.rmSync(t, { recursive: true, force: true });
  for (const s of survivors) process.stdout.write(`survivor-by-design ${s.id} ${s.title}: ${s.survivor}\n`);
  const bad = verdicts.filter((v) => !v.ok);
  const ms = Date.now() - t0;
  process.stdout.write(`\n${verdicts.length - bad.length}/${verdicts.length} mutants killed, ${survivors.length} survivors by design, ${bad.length} failing; ${(ms / 1000).toFixed(1)} s\n`);
  if (ms > BUDGET_MS) process.stdout.write(`\n*** GATE OVER BUDGET: ${(ms / 1000).toFixed(1)} s > ${BUDGET_MS / 1000} s — the gate FAILS ***\n`);
  return bad.length === 0 && ms <= BUDGET_MS ? 0 : 1;
}

main().then((c) => process.exit(c), (e: Error) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
