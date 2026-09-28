// Enox writes stay fast on a held book while writes keep arriving
// (r_compat_parity; npm run perf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoflenoxNode } from '../../src/node.ts';
import { callOp, type Ctx } from '../../src/ops.ts';
import { Graph } from '../../src/enox.ts';
import { T0, tmpDir } from '../helpers.ts';
import { generateLog } from './gen.ts';

const FACTS = 50_000;
const WRITE_GAP_MS = 10;
// Each bound holds for the median of SAMPLES answers: the tail is the disk's
// (one admission is two file fsyncs, a directory fsync and an index fsync;
// single fsyncs of 100 ms were measured on a shared machine), and every
// answer is still held under 1 s.
const SAMPLES = 9;
const median = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

test('update_assertion and delete_assertion answer within 100 ms and a read after a write within one second while writes keep arriving', async (t) => {
  const dir = tmpDir('perf-compat');
  const me = generateLog(dir, { facts: FACTS, batch: 2000, t0: T0, labels: true });
  const clock = { t: T0 + 3_600_000 };
  const n = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t });
  const ctx: Ctx = { node: n, caller: me.name, dataDir: null, now: () => clock.t, call: async () => null };
  const op = (name: string, a: Record<string, unknown>) => callOp(name, a, ctx, 'network');
  const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t0 = performance.now(); const r = await f(); return [r, performance.now() - t0]; };
  let writing = true;
  let written = 0;
  try {
    await op('graph_stats', {});                                     // the view exists (built once, at the first read)
    const ids: string[] = [];
    for (let k = 0; k < 2 * SAMPLES; k++) ids.push((await op('add_assertion', { source: `Entity ${k * 4}`, target: `Entity ${k * 4 + 400}`, relation: 'cites', confidence: 0.8 }) as { fact_id: string }).fact_id);

    // Writes keep arriving: another client adds an assertion every WRITE_GAP_MS
    // after its last one answered — some 25 writes a second.
    const writer = (async () => {
      for (let k = 0; writing; k++) {
        clock.t += 10;
        await op('add_assertion', { source: `Writer ${k}`, target: `Entity ${(k * 4) % FACTS}`, relation: 'mentions', confidence: 0.5 });
        written++;
        await new Promise((r) => setTimeout(r, WRITE_GAP_MS));
      }
    })();

    const updates: number[] = [], deletes: number[] = [], reads: number[] = [];
    for (let k = 0; k < SAMPLES; k++) {
      await new Promise((r) => setTimeout(r, 3));                    // land anywhere in the writer's cycle
      updates.push((await timed(() => op('update_assertion', { fact_id: ids[k]!, confidence: 0.3, context: `updated ${k}` })))[1]);
      deletes.push((await timed(() => op('delete_assertion', { fact_id: ids[k + SAMPLES]! })))[1]);
      // A read after a write: the new assertion is there.
      const t0 = performance.now();
      await op('add_assertion', { source: `Reader ${k}`, target: `Entity ${k * 8}`, relation: 'reads', confidence: 0.9 });
      const r = await op('query_graph', { query: `Reader ${k}` }) as { name: string }[];
      reads.push(performance.now() - t0);
      assert.deepEqual(r.map((x) => x.name), [`Reader ${k}`], 'the read sees the write');
    }
    writing = false;
    await writer;
    const ms = (xs: number[]) => xs.map((x) => x.toFixed(0)).join(', ');
    t.diagnostic(`under ${written} concurrent writes — updates: ${ms(updates)} ms; deletes: ${ms(deletes)} ms; reads after writes: ${ms(reads)} ms`);
    assert.ok(written >= 10, `writes kept arriving (${written})`);
    assert.ok(median(updates) < 100, `update_assertion took ${median(updates).toFixed(0)} ms (median)`);
    assert.ok(median(deletes) < 100, `delete_assertion took ${median(deletes).toFixed(0)} ms (median)`);
    assert.ok(median(reads) < 1000, `a read after a write took ${median(reads).toFixed(0)} ms (median)`);
    for (const x of [...updates, ...deletes, ...reads]) assert.ok(x < 1000, `one answer took ${x.toFixed(0)} ms`);

    // What was updated and deleted reads back so, and the view kept by applying
    // writes is the view built from scratch.
    const mill = await op('query_graph', { node_id: 'enox://example.org/graph/main/d0/e0' }) as { outgoing: { fact_id: string; confidence: number; context: string }[] };
    assert.deepEqual(mill.outgoing.filter((e) => e.fact_id === ids[0]).map((e) => [e.confidence, e.context]), [[0.3, 'updated 0']]);
    // (A kept view meets facts in admission order, a fresh one in answer
    // order: the same content, compared in one order.)
    const fresh = await Graph.load(n, me.name);
    const byKey = <T>(xs: T[]) => xs.map((x) => JSON.stringify(x)).sort();
    assert.deepEqual(byKey(await op('query_graph', {}) as unknown[]), byKey([...fresh.nodes.values()].map((x) => fresh.record(x))), 'the same entities');
    const rows = fresh.edges.map((e) => ({ source_name: fresh.nodes.get(e.source)!.name, source_id: e.source, relation: e.relation, target_name: fresh.nodes.get(e.target)!.name,
      target_id: e.target, confidence: e.confidence, context: e.context, created_at: e.created_at, updated_at: e.updated_at }));
    assert.deepEqual(byKey(await op('recent_activity', { limit: 1_000_000 }) as unknown[]), byKey(rows), 'the same assertions');
  } finally {
    writing = false;
    await n.close();
  }
});
