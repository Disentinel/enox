// recent_activity lists the newest writes first, in one order whatever the
// limit (r_recent_order). In the owner's session on 2026-10-03 the first rows
// changed with the limit, and the day's writes did not always come first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpCaller } from '../src/client.ts';
import { importEnox } from '../src/import.ts';
import { post, start, tmpDir, type Running } from './helpers.ts';

type Row = { source_name: string; relation: string; target_name: string; updated_at: string | null };

test('recent_activity with and without a limit agrees on its first rows, and a write made now comes first in both', async () => {
  const dir = tmpDir('recent');
  let a: Running = await start(dir, 'node-a');
  try {
    // An Enox snapshot: its updated_at are what the old store recorded — one
    // of them later than any write here (a claim, not when it was written
    // here), some absent, some equal.
    const E = (i: number) => `enox://example.org/graph/main/d/n${i}`;
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => ({ _type: 'node', id: E(i), node_type: 'concept', domain: 'd', label: `N${i}` })),
      ...Array.from({ length: 39 }, (_, i) => ({ _type: 'edge', from: E(i), to: E(i + 1), rel: `r${i % 3}`, confidence: 1, created_at: '2026-09-29T10:00:00.000Z',
        ...(i % 4 === 0 ? {} : { updated_at: i === 7 ? '2026-12-01T00:00:00.000Z' : `2026-09-${String(20 + (i % 9)).padStart(2, '0')}T10:00:00.000Z` }) })),
    ].map((x) => JSON.stringify(x)).join('\n');
    await importEnox(httpCaller(a.url, a.me, () => a.clock.t), a.me, lines, { now: () => a.clock.t });
    const op = async (name: string, args: Record<string, unknown>) => (await post(a.url, `/op/${name}`, args)).body as unknown;
    // Writes in one batch share their updated_at; then one more write, now.
    await op('batch_assertions', { assertions: [1, 2, 3, 4].map((i) => ({ source: 'Batch', target: `N${i}`, relation: 'touches' })) });
    await op('add_assertion', { source: 'Latest', target: 'N9', relation: 'made_now' });
    const key = (r: Row) => `${r.source_name} -${r.relation}-> ${r.target_name}`;
    const recent = async (limit?: number) => ((await op('recent_activity', limit === undefined ? {} : { limit })) as Row[]).map(key);

    const all = await recent();
    const six = await recent(6);
    assert.equal(all[0], 'Latest -made_now-> N9', `the write made now comes first: ${all.slice(0, 3).join(' | ')}`);
    assert.equal(six[0], 'Latest -made_now-> N9');
    assert.deepEqual(six, all.slice(0, 6), 'the first rows agree with and without a limit');
    assert.deepEqual(all.slice(1, 5).sort(), [1, 2, 3, 4].map((i) => `Batch -touches-> N${i}`), 'then the batch written before it');
    assert.deepEqual(await recent(1000), all.concat((await recent(1000)).slice(all.length)), 'a longer limit only extends the list');

    // The order survives a view rebuilt from the log (a restarted node).
    await a.stop();
    a = await start(dir, 'node-a');
    assert.deepEqual(await recent(6), six, 'the same first rows from a node rebuilt from its log');
    assert.deepEqual(await recent(), all);
  } finally { await a.stop(); }
});
