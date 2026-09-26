// Writes at scale (npm run perf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoflenoxNode } from '../../src/node.ts';
import { callOp, type Ctx } from '../../src/ops.ts';
import { newSalt, toJsonl } from '../../src/facts.ts';
import { T0, tmpDir } from '../helpers.ts';
import { generateLog } from './gen.ts';

async function big(tag: string) {
  const dir = tmpDir(tag);
  const me = generateLog(dir, { facts: 200_000, batch: 2000, t0: T0 });
  const clock = { t: T0 + 3_600_000 };
  const n = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t });
  return { n, me, clock };
}

const batchOf = (k: number) => Array.from({ length: 2000 }, (_, i) => ({ source: `new${k}-${i}`, relation: 'rel1', target: `t${i}`, perspective: 'perf', confidence: 0.5 }));

test('a batch of 2000 facts is admitted within one second with 200000 facts held', async (t) => {
  const { n, me, clock } = await big('perf-write');
  try {
    await n.ask('edge(F, "x", R, T)', me.name);           // the world is settled before we time a write
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const jsonl = toJsonl(batchOf(k));
      const salt = newSalt();
      clock.t += 1000;
      const manifest = me.signBatch(jsonl, n.head(me.name), new Date(clock.t).toISOString(), salt);
      const t0 = performance.now();
      await n.admit({ manifest, jsonl, salt, identity: me.identityChain() });
      times.push(performance.now() - t0);
    }
    t.diagnostic(`admissions: ${times.map((x) => x.toFixed(0)).join(', ')} ms`);
    for (const x of times) assert.ok(x < 1000, `a 2000-fact batch took ${x.toFixed(0)} ms`);
    // And what was admitted answers.
    assert.equal((await n.ask('edge(F, "new2-1999", R, T)', me.name)).rows.length, 1);
    assert.equal((n.health() as { facts: number }).facts, 206_000);
  } finally { await n.close(); }
});

test('an Enox read right after a write answers within one second with 200000 facts held', async (t) => {
  const { n, me, clock } = await big('perf-enox');
  const ctx: Ctx = { node: n, caller: me.name, dataDir: null, now: () => clock.t, call: async () => null };
  try {
    await callOp('graph_stats', {}, ctx, 'network');       // the view exists (built once, at the first read)
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      clock.t += 1000;
      await callOp('add_assertion', { source: `Perf source ${k}`, target: `Perf target ${k}`, relation: 'related_to', confidence: 0.7 }, ctx, 'network');
      const t0 = performance.now();
      const r = await callOp('query_graph', { query: `Perf source ${k}` }, ctx, 'network') as { name: string }[];
      times.push(performance.now() - t0);
      assert.deepEqual(r.map((x) => x.name), [`Perf source ${k}`], 'the read sees the write');
    }
    t.diagnostic(`enox reads after writes: ${times.map((x) => x.toFixed(0)).join(', ')} ms`);
    for (const x of times) assert.ok(x < 1000, `an Enox read after a write took ${x.toFixed(0)} ms`);
  } finally { await n.close(); }
});
