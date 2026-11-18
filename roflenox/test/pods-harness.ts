// A federation of pods over a JS corpus, and its oracle (src/federation.ts):
// N pod nodes, each with an engine holding the JS model over its files only,
// a coordinator node following them with the model's cross-file rules, a
// subscriber on the coordinator — and, beside them, the WHOLE WORLD: the
// corpus scanned anew and evaluated in one engine, which the subscriber's
// rows must equal after every step.
//
// The JS model and its scanner are those of the pinned @grafema/rofl; the
// engine holding the pods' and the nodes' worlds is ROFL_BIN (it needs `watch`).
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoflPort } from '@grafema/rofl/port';
import { publish } from '../src/client.ts';
import { DEFAULT_ROFL_BIN } from '../src/engine.ts';
import { decodeCell, type Fact } from '../src/facts.ts';
import { cellsOf, coreDemand, CoreRouter, decodeRules, escapesOf, Pod, splitFacts, WALLS, type Escape, type Published } from '../src/federation.ts';
import { invitation, pull, start, subscribe, tmpDir, vouch, type Clock, type Running, type Stream } from './helpers.ts';

const PKG = path.dirname(fileURLToPath(import.meta.resolve('@grafema/rofl/package.json')));
export const MODEL = path.join(PKG, 'rules/js.files');
const ROFL_CLI = path.join(PKG, 'npm/rofl.js');
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** The question: which function node each file offers under which name. */
export const QUESTION = 'exports_name(F, Name, File)';
/** The JS model's rules of exports_name that read another file (its [surface] relations), as they stand in
 *  rules/js-dataflow.rofl and rules/js-surface.rofl of @grafema/rofl 1.5.0, books dropped: the coordinator's. */
export const RULES = [
  'exports_name(F, Name, File) :- ast_node(E, "export_all_declaration", File), module_target(E, Target), sx_export_node(Target, Name, F).',
  'exports_name(F, Ext, File) :- reexport_offers(File, Ext, T, Int), sx_export_node(T, Int, F).',
  'exports_name(F, Ext, File) :- reexport_offers(File, Ext, T, "default"), sx_default(T, F).',
  'sx_export_node(File, Name, F) :- exports_name(F, Name, File).',
  'sx_default(File, F) :- exports_default(F, File).',
];

/** What crosses: every relation the rules read, and the question's own relation. */
export const ESCAPES = escapesOf([...RULES, `question :- ${QUESTION}.`]);

const wall = (): Clock => ({ get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } }) as Clock;

/** The facts of a directory, as the scanner writes them. */
export function scan(root: string): string {
  const out = path.join(tmpDir('pods-out'), 'facts.rofl');
  execFileSync(process.execPath, [ROFL_CLI, 'scan', root, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 100_000 });
  return fs.readFileSync(out, 'utf8');
}

const { codeFacts } = await import(path.join(PKG, 'playground/host.js')) as { codeFacts: (files: Record<string, string>) => { facts: string[]; host: string[] } };

/** One file scanned alone, as `rofl scan DIR FILE` over a directory of that file scans it: its facts, and its share
 *  of the core (the listing of its path, its strings). The scanner keeps no state across files, so the corpus's
 *  core is the union of the files' shares; Federation.start holds that against the whole scan. */
export function scanOne(root: string, file: string): { facts: Set<string>; core: Set<string> } {
  const { facts, host } = codeFacts({ [file]: fs.readFileSync(path.join(root, file), 'utf8') });
  const one = splitFacts([...facts, ...host].join('\n') + '\n', [file]);
  return { facts: one.byFile.get(file)!, core: one.core };
}

/** The files a scan read, by their path from the root. */
export function filesOf(text: string, root: string): string[] {
  const r = fs.realpathSync(root);
  return text.split('\n').filter((l) => l.startsWith('-- reads: ')).map((l) => l.slice(10).trim())
    .filter((p) => fs.statSync(p).isFile()).map((p) => path.relative(r, fs.realpathSync(p))).sort();
}

const rowKey = (cells: unknown[]) => JSON.stringify(cells.map(String));

/** THE ORACLE'S SIDE: the corpus scanned anew and evaluated whole in one engine; the question's rows. */
export async function wholeWorld(root: string): Promise<{ rows: Set<string>; ms: number; rss: number; facts: number }> {
  const t0 = performance.now();
  const text = scan(root);
  const port = await RoflPort.start(DEFAULT_ROFL_BIN);
  try {
    const s = await port.fresh(WALLS.budget, { space: WALLS.space });
    for (const l of fs.readFileSync(MODEL, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('--'))) {
      await s.loadFile(path.resolve(path.dirname(MODEL), l));
    }
    await s.load(text);
    const ev = await s.evaluate();
    if (ev.partial) throw new Error(`the whole world stopped at a wall: ${JSON.stringify(ev).slice(0, 300)}`);
    const a = await s.ask(QUESTION);
    const rows = new Set(a.rows.map((r) => rowKey(r.map(decodeCell))));
    const facts = (await s.factCount()).facts;
    return { rows, ms: performance.now() - t0, rss: rssOf((port as unknown as { child: { pid: number } }).child.pid), facts };
  } finally { await port.stop(); }
}

/** Resident memory of a process, in MB (ps). */
export function rssOf(pid: number | undefined): number {
  if (!pid) return 0;
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024; } catch { return 0; }
}

export interface PodNode { name: string; node: Running; pod: Pod; files: string[] }

export interface Step { ms: number; frames: number; pod: Published | null }

export class Federation {
  readonly root: string;
  readonly coord: Running;
  readonly pods: PodNode[];
  readonly sub: Stream;
  /** The core's facts, each with how many files' shares hold it: a fact no file holds any more leaves. */
  readonly core: Map<string, number>;
  /** Each file's share of the core. */
  private readonly shareOf: Map<string, Set<string>>;
  readonly router: CoreRouter;
  private readonly follower: ChildProcess | null;
  /** The pod of each file. */
  private readonly home = new Map<string, PodNode>();
  private readonly facts: Map<string, Set<string>>;

  private constructor(root: string, coord: Running, pods: PodNode[], sub: Stream, c: { core: Map<string, number>; shareOf: Map<string, Set<string>>; router: CoreRouter; facts: Map<string, Set<string>> }, follower: ChildProcess | null) {
    this.root = root; this.coord = coord; this.pods = pods; this.sub = sub; this.follower = follower;
    this.core = c.core; this.shareOf = c.shareOf; this.router = c.router; this.facts = c.facts;
    for (const p of pods) for (const f of p.files) this.home.set(f, p);
  }

  /** Stand it up: `assign` gives each file's pod (an index); `follow` is
   *  'pull' (the test pulls each feed after a step: one executor tick) or
   *  'executor' (the follow executor, every `intervalMs`). */
  static async start(root: string, assign: (file: string, i: number) => number, n: number,
    o: { follow?: 'pull' | 'executor'; intervalMs?: number; escapes?: Escape[]; wholeCore?: boolean } = {}): Promise<{ fed: Federation; initial: { ms: number; pods: Published[]; frameMs: number } }> {
    const t0 = performance.now();
    const text = scan(root);
    const files = filesOf(text, root);
    const whole = splitFacts(text, files);
    const byFile = new Map<string, Set<string>>();
    const shareOf = new Map<string, Set<string>>();
    const core = new Map<string, number>();
    for (const f of files) {
      const one = scanOne(root, f);
      byFile.set(f, one.facts);
      shareOf.set(f, one.core);
      for (const l of one.core) core.set(l, (core.get(l) ?? 0) + 1);
    }
    // The positive control of the shares: the files scanned alone are the corpus scanned whole.
    assert.deepEqual([...core.keys()].sort(), [...whole.core].sort(), 'the files\' shares of the core ≠ the whole scan\'s core');
    for (const f of files) assert.deepEqual([...byFile.get(f)!].sort(), [...whole.byFile.get(f)!].sort(), `${f} scanned alone ≠ scanned whole`);
    const coord = await start(tmpDir('pods-coord'), 'coordinator', { clock: wall() });
    const escapes = o.escapes ?? ESCAPES;
    const router = new CoreRouter(o.wholeCore ? null : await coreDemand(MODEL, escapes.map((e) => e.rel), new Set([...core.keys()].map((l) => cellsOf(l).rel))));
    router.core(core.keys(), []);
    const mineOf = files.map((f, k) => assign(f, k));
    for (let i = 0; i < n; i++) router.files(i, files.filter((_f, k) => mineOf[k] === i).flatMap((f) => [...byFile.get(f)!]), []);
    router.route();
    const pods: PodNode[] = [];
    const published: Published[] = [];
    for (let i = 0; i < n; i++) {
      const name = `pod-${i}`;
      const node = await start(tmpDir(`pods-${i}`), name, { clock: wall() });
      const mine = files.filter((_f, k) => mineOf[k] === i);
      // The pod's operator knows the coordinator, and lets it read the pod's book.
      await vouch(node, coord.me);
      await publish(node.url, node.me, [{ source: 'coordinator', relation: 'roflenox:grant', target: '2100-01-01T00:00:00.000Z', perspective: 'policy', confidence: 1 }]);
      const { pod, published: p } = await Pod.start({ program: MODEL, escapes, publish: async (f: Fact[]) => { await publish(node.url, node.me, f); } },
        router.share(i), new Map(mine.map((f) => [f, byFile.get(f)!])));
      pods.push({ name, node, pod, files: mine });
      published.push(p);
    }
    const rule = (text: string, i: number): Fact => ({ source: `pods-${i}`, relation: 'roflenox:rule', target: text, perspective: 'rules', confidence: 1 });
    await publish(coord.url, coord.me, [...[...RULES, ...decodeRules(escapes)].map(rule),
      ...pods.map((p) => ({ source: p.name, relation: 'roflenox:follow', target: invitation(p.node), perspective: 'follows', confidence: 1 }))]);
    let follower: ChildProcess | null = null;
    if (o.follow === 'executor') {
      follower = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'follow', '--interval_ms', String(o.intervalMs ?? 50), '--data', coord.dir, '--url', coord.url], { stdio: 'ignore' });
    } else {
      for (const p of pods) await pull(coord, invitation(p.node), p.name, coord.me);
    }
    const t1 = performance.now();
    const sub = await subscribe(coord.url, `/subscribe?query=${encodeURIComponent(QUESTION)}`, { authorization: `Bearer ${coord.node.operatorToken()}` });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const fed = new Federation(root, coord, pods, sub, { core, shareOf, router, facts: byFile }, follower);
    return { fed, initial: { ms: t1 - t0, pods: published, frameMs: 0 } };
  }

  /** The subscriber's rows, as the oracle compares them. */
  rows(): Set<string> { return new Set([...this.sub.rows.values()].map((r) => rowKey(r.cells))); }

  /** Take frames until the subscriber holds `want` (the whole world's rows), or say how it differs. */
  async converge(want: Set<string>, since: number, ms = 15_000): Promise<{ ms: number; frames: number }> {
    let frames = 0;
    const t0 = Date.now();
    for (;;) {
      const have = this.rows();
      if (have.size === want.size && [...want].every((r) => have.has(r))) return { ms: performance.now() - since, frames };
      const left = ms - (Date.now() - t0);
      if (left <= 0) {
        assert.deepEqual([...have].sort(), [...want].sort(), 'the coordinator\'s subscriber ≠ the whole world');
      }
      try { await this.sub.next(Math.max(left, 1)); frames++; } catch { /* timed out: the next turn compares and says how */ }
      if (!this.follower) for (const p of this.pods) await pull(this.coord, p.node.url, p.name, this.coord.me);
    }
  }

  /** Edit (or, with null, delete) one file in the corpus, as a person would; its pod takes the delta, and the core
   *  facts that came and went reach only the pods whose share they move (`others`). */
  async edit(file: string, content: string | null): Promise<{ t0: number; pod: Published; others: Published[]; core: { in: number; out: number } }> {
    const at = path.join(this.root, file);
    const owner = this.home.get(file) ?? this.pods[0]!;
    const t0 = performance.now();
    let now: { facts: Set<string>; core: Set<string> } | null = null;
    if (content === null) {
      fs.rmSync(at);
      this.home.delete(file);
    } else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
      now = scanOne(this.root, file);
      this.home.set(file, owner);
    }
    const was = { facts: this.facts.get(file) ?? new Set<string>(), core: this.shareOf.get(file) ?? new Set<string>() };
    const coreIn: string[] = [], coreOut: string[] = [];
    for (const l of was.core) if (!now?.core.has(l)) { const n = this.core.get(l)! - 1; if (n === 0) { this.core.delete(l); coreOut.push(l); } else this.core.set(l, n); }
    for (const l of now?.core ?? []) if (!was.core.has(l)) { const n = (this.core.get(l) ?? 0) + 1; this.core.set(l, n); if (n === 1) coreIn.push(l); }
    if (now) { this.facts.set(file, now.facts); this.shareOf.set(file, now.core); } else { this.facts.delete(file); this.shareOf.delete(file); }
    const i = this.pods.indexOf(owner);
    this.router.core(coreIn, coreOut);
    this.router.files(i, [...now?.facts ?? []].filter((l) => !was.facts.has(l)), [...was.facts].filter((l) => !now?.facts.has(l)));
    const moved = this.router.route();
    const pod = await owner.pod.edit(file, now?.facts ?? null, this.router.share(i));
    const others: Published[] = [];
    for (const [k, share] of moved) if (k !== i) others.push(await this.pods[k]!.pod.edit('', null, share));
    if (!this.follower) for (const p of this.pods) await pull(this.coord, p.node.url, p.name, this.coord.me);
    return { t0, pod, others, core: { in: coreIn.length, out: coreOut.length } };
  }

  async close(): Promise<void> {
    this.sub.close();
    if (this.follower && this.follower.exitCode === null) {
      const exited = new Promise((r) => this.follower!.once('exit', r));
      this.follower.kill('SIGTERM');
      await exited;
    }
    for (const p of this.pods) { await p.pod.close(); await p.node.stop(); }
    await this.coord.stop();
  }
}
