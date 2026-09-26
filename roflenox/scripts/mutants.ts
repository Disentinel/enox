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
//   npm run mutants                         every mutant, 2 workers (or cpus/4, if fewer)
//   npm run mutants -- --only M2,M14        some of them
//   npm run mutants -- --extra more.json    add mutants (same shape) — the gate's own test uses this
//   npm run mutants -- --workers 8
//
// Budget: the whole run prints its duration and must stay under 300 s.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BUDGET_MS = 300_000;

interface Mutant { id: string; title: string; file: string; edits: ([string, string] | [string, string, string])[]; red?: string[]; survivor?: string }

function args(): { only: Set<string> | null; extra: string | null; workers: number } {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] ?? null : null; };
  const only = get('--only');
  return { only: only ? new Set(only.split(',')) : null, extra: get('--extra'), workers: Number(get('--workers') ?? Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)))) };
}

function load(extra: string | null): Mutant[] {
  const list = (JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'mutants.json'), 'utf8')) as { mutants: Mutant[] }).mutants;
  if (extra) list.push(...(JSON.parse(fs.readFileSync(extra, 'utf8')) as { mutants: Mutant[] }).mutants);
  return list;
}

/** A private copy of the tree for one worker; mutants never touch ROOT. */
function copyTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roflenox-mutant-'));
  for (const d of ['src', 'test', 'vendor', 'scripts']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Test files that define each named test. */
function filesFor(tree: string, names: string[]): string[] {
  const files = ['test', 'test/perf'].flatMap((d) => fs.existsSync(path.join(tree, d))
    ? fs.readdirSync(path.join(tree, d)).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(d, f)) : []);
  return files.filter((f) => names.some((n) => fs.readFileSync(path.join(tree, f), 'utf8').includes(n)));
}

function run(tree: string, names: string[]): Promise<{ failed: Set<string>; passed: Set<string>; out: string }> {
  const files = filesFor(tree, names);
  const argv = ['--experimental-strip-types', '--no-warnings', '--test', '--test-concurrency=4', '--test-timeout=90000',
    '--test-force-exit', ...names.map((n) => `--test-name-pattern=^${escape(n)}$`), ...files];
  return new Promise((ok) => {
    // A run started from inside `node --test` inherits NODE_TEST_CONTEXT and
    // would report to that parent instead of printing TAP: drop it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, argv, { cwd: tree, env });
    // A run that does not finish is cut off: its tests count as not run.
    const wall = setTimeout(() => c.kill('SIGKILL'), 240_000);
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
    const r = await run(tree, red);
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
  const { only, extra, workers } = args();
  const all = load(extra).filter((m) => !only || only.has(m.id));
  const survivors = all.filter((m) => m.survivor);
  const queue = all.filter((m) => !m.survivor);
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
  if (ms > BUDGET_MS) process.stdout.write(`OVER BUDGET: ${(ms / 1000).toFixed(1)} s > ${BUDGET_MS / 1000} s\n`);
  return bad.length === 0 && ms <= BUDGET_MS ? 0 : 1;
}

main().then((c) => process.exit(c), (e: Error) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
