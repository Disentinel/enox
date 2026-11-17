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
import { decodeRules, escapesOf, Pod, splitFacts, WALLS, type Escape, type Published } from '../src/federation.ts';
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

/** The facts of a directory, as the scanner writes them. With `only`, that one file alone, at its path. */
export function scan(root: string, only?: string): string {
  let dir = root;
  if (only) {
    dir = tmpDir('pods-scan');
    fs.mkdirSync(path.dirname(path.join(dir, only)), { recursive: true });
    fs.copyFileSync(path.join(root, only), path.join(dir, only));
  }
  const out = path.join(tmpDir('pods-out'), 'facts.rofl');
  execFileSync(process.execPath, [ROFL_CLI, 'scan', dir, '--out', out], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 100_000 });
  return fs.readFileSync(out, 'utf8');
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
  core: Set<string>;
  private readonly follower: ChildProcess | null;
  /** The pod of each file. */
  private readonly home = new Map<string, PodNode>();

  private constructor(root: string, coord: Running, pods: PodNode[], sub: Stream, core: Set<string>, follower: ChildProcess | null) {
    this.root = root; this.coord = coord; this.pods = pods; this.sub = sub; this.core = core; this.follower = follower;
    for (const p of pods) for (const f of p.files) this.home.set(f, p);
  }

  /** Stand it up: `assign` gives each file's pod (an index); `follow` is
   *  'pull' (the test pulls each feed after a step: one executor tick) or
   *  'executor' (the follow executor, every `intervalMs`). */
  static async start(root: string, assign: (file: string, i: number) => number, n: number,
    o: { follow?: 'pull' | 'executor'; intervalMs?: number; escapes?: Escape[] } = {}): Promise<{ fed: Federation; initial: { ms: number; pods: Published[]; frameMs: number } }> {
    const t0 = performance.now();
    const text = scan(root);
    const files = filesOf(text, root);
    const { core, byFile } = splitFacts(text, files);
    const coord = await start(tmpDir('pods-coord'), 'coordinator', { clock: wall() });
    const escapes = o.escapes ?? ESCAPES;
    const pods: PodNode[] = [];
    const published: Published[] = [];
    for (let i = 0; i < n; i++) {
      const name = `pod-${i}`;
      const node = await start(tmpDir(`pods-${i}`), name, { clock: wall() });
      const mine = files.filter((f, k) => assign(f, k) === i);
      // The pod's operator knows the coordinator, and lets it read the pod's book.
      await vouch(node, coord.me);
      await publish(node.url, node.me, [{ source: 'coordinator', relation: 'roflenox:grant', target: '2100-01-01T00:00:00.000Z', perspective: 'policy', confidence: 1 }]);
      const { pod, published: p } = await Pod.start({ program: MODEL, escapes, publish: async (f: Fact[]) => { await publish(node.url, node.me, f); } },
        core, new Map(mine.map((f) => [f, byFile.get(f)!])));
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
    const fed = new Federation(root, coord, pods, sub, core, follower);
    return { fed, initial: { ms: t1 - t0, pods: published, frameMs: 0 } };
  }

  /** The subscriber's rows, as the oracle compares them. */
  rows(): Set<string> { return new Set([...this.sub.rows.values()].map((r) => rowKey(r.cells))); }

  /** Take frames until the subscriber holds `want` (the whole world's rows), or say how it differs. */
  async converge(want: Set<string>, since: number, ms = 30_000): Promise<{ ms: number; frames: number }> {
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

  /** Edit (or, with null, delete) one file in the corpus, as a person would; its pod takes the delta. */
  async edit(file: string, content: string | null): Promise<{ t0: number; pod: Published; others: Published[] }> {
    const at = path.join(this.root, file);
    const owner = this.home.get(file) ?? this.pods[0]!;
    const t0 = performance.now();
    let facts: Set<string> | null = null;
    let core = this.core;
    if (content === null) {
      fs.rmSync(at);
      // The listing's facts that name the file go with it.
      const named = JSON.stringify(file);
      core = new Set([...this.core].filter((l) => !l.includes(named)));
      this.home.delete(file);
    } else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
      const one = splitFacts(scan(this.root, file), [file]);
      facts = one.byFile.get(file)!;
      core = new Set([...this.core, ...one.core]);
      this.home.set(file, owner);
    }
    const moved = core.size !== this.core.size || [...core].some((l) => !this.core.has(l));
    this.core = core;
    const pod = await owner.pod.edit(file, facts, core);
    // Every other pod holds the core too.
    const others: Published[] = [];
    if (moved) for (const p of this.pods) if (p !== owner) others.push(await p.pod.edit('', null, core));
    if (!this.follower) for (const p of this.pods) await pull(this.coord, p.node.url, p.name, this.coord.me);
    return { t0, pod, others };
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
