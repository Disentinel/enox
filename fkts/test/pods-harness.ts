// A federation of pods over a JS corpus, and its oracle (src/federation.ts):
// N pods, each an engine process settling its files by levels, the root
// engine beside a coordinator node that publishes its answers, a subscriber on
// the coordinator — and, beside them, the WHOLE WORLD: the corpus scanned anew
// and evaluated in one engine, which the subscriber's rows must equal after
// every step.
//
// The JS model and its scanner are those of the pinned @grafema/rofl; the
// engine of the pods, the root and the coordinator is ROFL_BIN (it needs
// `volumes`, Disentinel/rofl docs/cli.md, *The nodes as processes*).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoflPort } from '@grafema/rofl/port';
import { publish } from '../src/client.ts';
import { DEFAULT_ROFL_BIN } from '../src/engine.ts';
import { decodeCell, type Fact } from '../src/facts.ts';
import { bookOf } from '../src/identity.ts';
import { Answers, corpusText, decodeRule, EngineNode, podSize, splitFacts, WALLS, type Published } from '../src/federation.ts';
import { start, subscribe, tmpDir, type Clock, type Running, type Stream } from './helpers.ts';

const PKG = path.dirname(fileURLToPath(import.meta.resolve('@grafema/rofl/package.json')));
export const MODEL = path.join(PKG, 'rules/js.files');
const ROFL_CLI = path.join(PKG, 'npm/rofl.js');

/** The question: which function node each file offers under which name. */
export const QUESTION = 'exports_name(F, Name, File)';
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

export interface PodNode { name: string; engine: EngineNode; files: string[] }

export class Federation {
  readonly root: string;
  readonly coord: Running;
  pods: PodNode[];
  /** The root engine, the coordinator's: it settles what is over the pods and answers the question. */
  top: EngineNode;
  readonly sub: Stream;
  /** The core's facts, each with how many files' shares hold it: a fact no file holds any more leaves. */
  readonly core: Map<string, number>;
  /** Each file's share of the core. */
  private readonly shareOf: Map<string, Set<string>>;
  private readonly facts: Map<string, Set<string>>;
  /** The files in the engines' order: a file's place is its index, a pod's block a run of them. */
  private files: string[];
  private readonly n: number;
  private readonly answers: Answers;

  private constructor(root: string, coord: Running, sub: Stream, c: { core: Map<string, number>; shareOf: Map<string, Set<string>>; facts: Map<string, Set<string>>; files: string[]; n: number; answers: Answers; pods: PodNode[]; top: EngineNode }) {
    this.root = root; this.coord = coord; this.sub = sub;
    this.core = c.core; this.shareOf = c.shareOf; this.facts = c.facts; this.files = c.files; this.n = c.n; this.answers = c.answers; this.pods = c.pods; this.top = c.top;
  }

  /** The engines over the corpus as it is now: a pod per block of files, and the root. */
  private static async engines(files: string[], facts: Map<string, Set<string>>, core: Iterable<string>, n: number, budget?: number): Promise<{ pods: PodNode[]; top: EngineNode }> {
    const dir = tmpDir('pods-far');
    const corpus = path.join(dir, 'corpus.rofl');
    fs.writeFileSync(corpus, corpusText(core, files, facts));
    const size = podSize(files.length, n);
    const k = Math.ceil(files.length / size);
    const o = { program: MODEL, dir, size, ...(budget ? { budget } : {}) };
    // (every process stands up at once: a pod settles its layers with ids from the root, the root waits for the pods)
    const all = [EngineNode.start(o, 'root', corpus), ...Array.from({ length: k }, (_, i) => EngineNode.start(o, i, corpus))];
    // (one that refuses refuses them all: those standing are let go before the refusal is said)
    const done = await Promise.allSettled(all);
    // (and the refusal said is the cause, not a process that saw another go)
    const no = done.filter((d): d is PromiseRejectedResult => d.status === 'rejected').sort((a, b) => Number(/ went: /.test(String(a.reason))) - Number(/ went: /.test(String(b.reason))));
    if (no.length) {
      for (const d of done) if (d.status === 'fulfilled') await d.value.close().catch(() => {});
      throw no[0]!.reason;
    }
    const [top, ...engines] = done.map((d) => (d as PromiseFulfilledResult<EngineNode>).value);
    return { top: top!, pods: engines.map((engine, i) => ({ name: `pod-${i}`, engine, files: files.slice(i * size, (i + 1) * size) })) };
  }

  /** Stand it up over the files of `root`, on `n` pods (as few as hold the files in whole leaves of the engine). */
  static async start(root: string, n: number, o: { budget?: number } = {}): Promise<{ fed: Federation; initial: { ms: number; pod: Published } }> {
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
    const rule: Fact = { source: 'answers', relation: 'fkts:rule', target: decodeRule('exports_name', 3, bookOf(coord.me.name)), perspective: 'rules', confidence: 1 };
    await publish(coord.url, coord.me, [rule]);
    const answers = new Answers('exports_name', async (f: Fact[]) => { await publish(coord.url, coord.me, f); });
    const { pods, top } = await Federation.engines(files, byFile, core.keys(), n, o.budget).catch(async (e: unknown) => { await coord.stop(); throw e; });
    const t1 = performance.now();
    const pod = await answers.step(await top.rows(QUESTION), t0, t1, 'anew');
    const sub = await subscribe(coord.url, `/subscribe?query=${encodeURIComponent(QUESTION)}`, { authorization: `Bearer ${coord.node.operatorToken()}` });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const fed = new Federation(root, coord, sub, { core, shareOf, facts: byFile, files, n, answers, pods, top });
    return { fed, initial: { ms: performance.now() - t0, pod } };
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
    }
  }

  /** Edit (or, with null, delete) one file in the corpus, as a person would. The root sends it to every pod and each
   *  settles again what it moved; a file that comes, or the core moving (the listing, the strings), stands the
   *  engines up anew over the corpus as it is now. Then the coordinator publishes the answers that moved. */
  async edit(file: string, content: string | null): Promise<{ t0: number; pod: Published; core: { in: number; out: number } }> {
    const at = path.join(this.root, file);
    const t0 = performance.now();
    let now: { facts: Set<string>; core: Set<string> } | null = null;
    if (content === null) {
      fs.rmSync(at);
    } else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
      now = scanOne(this.root, file);
    }
    const was = { core: this.shareOf.get(file) ?? new Set<string>() };
    const coreIn: string[] = [], coreOut: string[] = [];
    for (const l of was.core) if (!now?.core.has(l)) { const n = this.core.get(l)! - 1; if (n === 0) { this.core.delete(l); coreOut.push(l); } else this.core.set(l, n); }
    for (const l of now?.core ?? []) if (!was.core.has(l)) { const n = (this.core.get(l) ?? 0) + 1; this.core.set(l, n); if (n === 1) coreIn.push(l); }
    const place = this.files.indexOf(file);
    if (now) { this.facts.set(file, now.facts); this.shareOf.set(file, now.core); } else { this.facts.delete(file); this.shareOf.delete(file); }
    let by: Published['by'];
    if (place >= 0 && coreIn.length === 0 && coreOut.length === 0) {
      await this.top.edit([{ at: place, rofl: now ? `${[...now.facts].join('\n')}\n` : '' }]);
      by = 'levels';
    } else {
      await this.stop();
      this.files = [...this.facts.keys()].sort();
      ({ pods: this.pods, top: this.top } = await Federation.engines(this.files, this.facts, this.core.keys(), this.n));
      by = 'anew';
    }
    const t1 = performance.now();
    const pod = await this.answers.step(await this.top.rows(QUESTION), t0, t1, by);
    return { t0, pod, core: { in: coreIn.length, out: coreOut.length } };
  }

  /** The engines stopped: the root first, and each pod goes with it. */
  private async stop(): Promise<void> {
    await this.top.close();
    for (const p of this.pods) await p.engine.close();
  }

  async close(): Promise<void> {
    this.sub.close();
    await this.stop();
    await this.coord.stop();
  }
}
