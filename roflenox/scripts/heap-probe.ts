// Where the heap goes on an owner-sized book (r_heap_headroom): run with
//   node --expose-gc --max-old-space-size=4096 --experimental-strip-types --no-warnings scripts/heap-probe.ts
// It builds the book, opens a node in this process, and measures heapUsed
// after each structure is built, and after each is dropped.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { RoflenoxNode } from '../src/node.ts';
import { callOp, type Ctx } from '../src/ops.ts';
import { generateEnoxBook } from '../test/perf/gen.ts';
import { textsOf } from '../executors/embedder/embedder.ts';

const gc = (globalThis as { gc?: () => void }).gc!;
const mb = () => { gc(); gc(); return process.memoryUsage().heapUsed / 2 ** 20; };
const line = (what: string, before: number, after: number) => console.log(`${what.padEnd(46)} ${after.toFixed(0).padStart(6)} MB  (${(after - before >= 0 ? '+' : '')}${(after - before).toFixed(0)})`);
const vec = (text: string) => createHash('sha512').update(text).digest().toString('base64url').repeat(6).slice(0, 518);   // a 384-d int8 vector, base64url

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-probe-'));
const exDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-probe-e-'));
try {
  const t0 = Date.now() - 3 * 86_400_000;
  const m0 = mb();
  const { owner } = generateEnoxBook(dir, exDir, { entities: 22_000, assertions: 12_000, t0,
    embed: { texts: textsOf, key: (x) => `embedding:${createHash('sha256').update(x).digest('hex').slice(0, 32)}`, vector: vec, perspective: 'e5-small' } });
  const m1 = mb();
  line('generated (book on disk)', m0, m1);
  const s0 = performance.now();
  const n = await RoflenoxNode.open({ dataDir: dir });
  const m2 = mb();
  line(`opened (${((performance.now() - s0) / 1000).toFixed(1)} s, ${(n.health() as { facts: number }).facts} facts)`, m1, m2);
  const ctx: Ctx = { node: n, caller: owner.name, dataDir: null, now: () => Date.now(), call: async () => null };
  for (const k of [1, 2]) {
    const s = performance.now();
    await callOp('graph_stats', {}, ctx, 'network');
    const m = mb();
    line(`graph_stats #${k} (${(performance.now() - s).toFixed(0)} ms)`, m2, m);
  }
  const m3 = mb();
  const s1 = performance.now();
  const r = await n.ask('edge(F, S, R, T)', owner.name);
  line(`ask edge(F, S, R, T) held (${r.rows.length} rows, ${(performance.now() - s1).toFixed(0)} ms)`, m3, mb());
  (r as { rows: unknown[] }).rows = [];
  const m4 = mb();
  // Each structure's share: dropped one by one.
  const x = n as unknown as Record<string, unknown>;
  let prev = m4;
  for (const [name, drop] of [
    ['programs (each batch as ROFL text)', () => (x.programs as Map<string, unknown>).clear()],
    ['recent (admissions remembered)', () => { (x.recent as unknown[]).length = 0; }],
    ['values (per-book values by place)', () => (x.values as Map<string, unknown>).clear()],
    ['assertions (current assertion per fact)', () => { const a = x.assertions as Record<string, Map<string, unknown>>; a.by!.clear(); a.values!.clear(); a.grants!.clear(); }],
    ['results (executor results as ROFL)', () => (x.results as Map<string, unknown>).clear()],
  ] as [string, () => void][]) {
    drop();
    const m = mb();
    line(`  dropped ${name}`, prev, m);
    prev = m;
  }
  const u = process.memoryUsage();
  console.log(`rss ${(u.rss / 2 ** 20).toFixed(0)} MB, external ${(u.external / 2 ** 20).toFixed(0)} MB`);
  await n.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(exDir, { recursive: true, force: true });
}
