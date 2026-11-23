// A federation of pods over a JS corpus, and its oracle: the code's world (src/code.ts) split over N pods, each an
// engine process settling its files by levels, the root engine beside a coordinator node that publishes its
// answers, a subscriber on the coordinator — and, beside them, the WHOLE WORLD: the corpus scanned anew and
// evaluated in one engine, which the subscriber's rows must equal after every step.
//
// The engine is ROFL_BIN (it needs `volumes`, Disentinel/rofl docs/cli.md, *The nodes as processes*); the JS model
// and its scanner are those of its own source (sourceOf).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RoflPort } from '@grafema/rofl/port';
import { publish } from '../src/client.ts';
import { CodeWorld, sourceOf, type PodNode } from '../src/code.ts';
import { DEFAULT_ROFL_BIN } from '../src/engine.ts';
import { decodeCell, type Fact } from '../src/facts.ts';
import { bookOf } from '../src/identity.ts';
import { programFiles, WALLS, type Published } from '../src/federation.ts';
import { start, subscribe, tmpDir, type Clock, type Running, type Stream } from './helpers.ts';

export const SOURCE = await sourceOf();

/** The question: which function node each file offers under which name. */
export const QUESTION = 'exports_name(F, Name, File)';
const wall = (): Clock => ({ get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } }) as Clock;

const rowKey = (cells: unknown[]) => JSON.stringify(cells.map(String));

/** THE ORACLE'S SIDE: the corpus scanned anew and evaluated whole in one engine; the question's rows. */
export async function wholeWorld(root: string): Promise<{ rows: Set<string>; ms: number; rss: number; facts: number }> {
  const t0 = performance.now();
  const text = await SOURCE.scan([root]);
  const port = await RoflPort.start(DEFAULT_ROFL_BIN);
  try {
    const s = await port.fresh(WALLS.budget, { space: WALLS.space });
    for (const f of programFiles(SOURCE.model)) await s.loadFile(f);
    await s.load('asks(exports_name).\n');
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

export class Federation {
  readonly root: string;
  readonly coord: Running;
  readonly sub: Stream;
  readonly world: CodeWorld;

  private constructor(root: string, coord: Running, sub: Stream, world: CodeWorld) { this.root = root; this.coord = coord; this.sub = sub; this.world = world; }

  get pods(): PodNode[] { return this.world.pods; }
  /** The root engine, the coordinator's: it settles what is over the pods and answers the question. */
  get top() { return this.world.top; }

  /** Stand it up over the files of `root`, on `n` pods (as few as hold the files in whole leaves of the engine). */
  static async start(root: string, n: number, o: { budget?: number } = {}): Promise<{ fed: Federation; initial: { ms: number; pod: Published } }> {
    const t0 = performance.now();
    const coord = await start(tmpDir('pods-coord'), 'coordinator', { clock: wall() });
    const { world, published } = await CodeWorld.start(root, {
      asks: [QUESTION], pods: n, source: SOURCE, book: bookOf(coord.me.name), ...(o.budget ? { budget: o.budget } : {}),
      publish: async (f: Fact[]) => { await publish(coord.url, coord.me, f); },
    }).catch(async (e: unknown) => { await coord.stop(); throw e; });
    const sub = await subscribe(coord.url, `/subscribe?query=${encodeURIComponent(QUESTION)}`, { authorization: `Bearer ${coord.node.operatorToken()}` });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    return { fed: new Federation(root, coord, sub, world), initial: { ms: performance.now() - t0, pod: published[0]! } };
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

  /** Edit (or, with null, delete) one file in the corpus, as a person would, and let the world take it. */
  async edit(file: string, content: string | null): Promise<{ t0: number; pod: Published; core: { in: number; out: number } }> {
    const at = path.join(this.root, file);
    if (content === null) fs.rmSync(at);
    else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, content); }
    const r = await this.world.edit(file);
    return { t0: r.t0, pod: r.published[0]!, core: r.core };
  }

  async close(): Promise<void> {
    this.sub.close();
    await this.world.close();
    await this.coord.stop();
  }
}
