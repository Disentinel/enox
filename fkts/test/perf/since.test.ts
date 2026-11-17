// ask since a batch on a book the size of the owner's (r_ask_since): it walks
// only the batches after the one named, so it costs what the new facts cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post, start, tmpDir, type Clock } from '../helpers.ts';
import { generateLog } from './gen.ts';
import { publish } from '../../src/client.ts';

const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;
const median = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

test('ask since a digest answers only the facts admitted after it, and its cost on an owner-sized book grows with the new facts, not the log', async (t) => {
  const dir = tmpDir('perf-since');
  const me = generateLog(dir, { facts: 200_000, batch: 2000, t0: Date.now() - 3_600_000 });
  const a = await start(dir, me.name, { clock: wall });
  try {
    const timed = async (body: Record<string, unknown>) => {
      const s = performance.now();
      const r = await post(a.url, '/ask', body);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { rows: (r.body as { rows: { cells: unknown[] }[] }).rows, ms: performance.now() - s };
    };
    const head = ((await post(a.url, '/op/chain', { identity: me.name, limit: 1, cursor: undefined })).body as { head: string }).head;
    await publish(a.url, me, Array.from({ length: 5 }, (_, i) => ({ source: `new-${i}`, relation: 'rel1', target: `x${i}`, perspective: 'perf', confidence: 1 })), () => wall.t);
    const sinceMs: number[] = [], wholeMs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const s = await timed({ query: 'edge(F, S, "rel1", T)', since: head });
      assert.deepEqual(s.rows.map((r) => r.cells[1]).sort(), ['new-0', 'new-1', 'new-2', 'new-3', 'new-4']);
      sinceMs.push(s.ms);
      const w = await timed({ query: 'edge(F, S, "rel1", T)', limit: 10_000 });
      assert.ok(w.rows.length > 2000, 'the whole relation is large');
      wholeMs.push(w.ms);
    }
    // Only the facts after the batch named, by perspective, within what the reader may see.
    const claim = (src: string, c = 1, p = 'zz_coord') => ({ source: src, relation: 'zz_claim', target: 'task', perspective: p, confidence: c });
    await publish(a.url, me, [claim('session-1'), claim('session-2')], () => wall.t);
    const r1 = ((await post(a.url, '/op/chain', { identity: me.name, limit: 1 })).body as { head: string }).head;
    await publish(a.url, me, [claim('session-3'), claim('session-4', 1, 'zz_other')], () => wall.t);
    await publish(a.url, me, [claim('session-1', 0)], () => wall.t);
    const names = async (query: string, digest: string, o: Record<string, unknown> = {}) =>
      ((await post(a.url, '/ask', { query, since: digest, ...o })).body as { rows: { cells: unknown[] }[] }).rows.map((r) => r.cells[1]).sort();
    assert.deepEqual(await names('edge(F, S, "zz_claim", T)', head), ['session-1', 'session-2', 'session-3', 'session-4']);
    assert.deepEqual(await names('edge(F, S, "zz_claim", T)', r1), ['session-1', 'session-3', 'session-4']);
    assert.deepEqual(await names('live(F, S, "zz_claim", T)', head), ['session-2', 'session-3', 'session-4'], 'live: the retracted claim is not');
    assert.deepEqual(await names('edge(F, S, "zz_claim", T)', head, { perspective: 'zz_other' }), ['session-4']);
    assert.deepEqual(((await post(a.url, '/ask', { query: 'edge(F, S, R, T)', since: head }, { as: null })).body as { rows: unknown[] }).rows, [], 'a stranger sees nothing');
    assert.equal((await post(a.url, '/ask', { query: 'edge(F, S, R, T)', since: 'cd'.repeat(32) })).status, 404);
    assert.equal((await post(a.url, '/ask', { query: 'grant(R, U)', since: head })).status, 400);

    // A thousand more new facts: since grows with them.
    await publish(a.url, me, Array.from({ length: 1000 }, (_, i) => ({ source: `more-${i}`, relation: 'rel1', target: `y${i}`, perspective: 'perf', confidence: 1 })), () => wall.t);
    const more = await timed({ query: 'edge(F, S, "rel1", T)', since: head, limit: 10_000 });
    assert.equal(more.rows.length, 1005, 'the 5 and the 1000 new rel1 facts');
    t.diagnostic(`since 5 new facts: ${sinceMs.map((x) => x.toFixed(0)).join(', ')} ms; 1005 new: ${more.ms.toFixed(0)} ms; the whole relation: ${wholeMs.map((x) => x.toFixed(0)).join(', ')} ms`);
    assert.ok(median(sinceMs) < 50, `since over 5 new facts: ${median(sinceMs).toFixed(0)} ms (median)`);
    assert.ok(median(sinceMs) < median(wholeMs), 'since costs less than the whole relation');
  } finally { await a.stop(); }
});
