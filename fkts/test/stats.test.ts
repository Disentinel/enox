// graph_stats is bounded by default (r_stats_bounded): on the owner's book its
// answer ran to ~39 KB — hundreds of domain/type buckets. By default it gives
// totals, every relation and the twenty largest buckets with a count of the
// rest; full: true is still Enox's whole breakdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import type { Fact } from '../src/facts.ts';
import { start, tmpDir } from './helpers.ts';

test('graph_stats by default stays under 4 KB on the owner\'s book and its full form still matches the Enox breakdown', async (t) => {
  const a = await start(tmpDir('stats'), 'node-a');
  try {
    // Owner-shaped: Enox's answer on it was ~39 KB. 120 domains × 3 types =
    // 360 buckets of uneven size, and 110 relations; names longer than most
    // (17 characters), so the bound holds with room.
    const TYPES = ['concept', 'decision', 'project'];
    const f = (source: string, relation: string, target: string): Fact => ({ source, relation, target, perspective: 'enox', confidence: 1 });
    const facts: Fact[] = [];
    const want = { buckets: new Map<string, number>(), relations: new Map<string, number>() };
    const ids: string[] = [];
    for (let d = 0; d < 120; d++) {
      for (const [t, type] of TYPES.entries()) {
        const n = 1 + ((d * 3 + t) % 7);
        want.buckets.set(`domain_of_kind_${d}\u0000${type}`, n);
        for (let k = 0; k < n; k++) {
          const id = `enox://example.org/graph/main/domain_of_kind_${d}/${type}_${k}`;
          ids.push(id);
          facts.push(f(id, 'enox:type', type), f(id, 'enox:domain', `domain_of_kind_${d}`), f(id, 'enox:label', `${type} ${d}.${k}`));
        }
      }
    }
    for (let r = 0; r < 110; r++) {
      const rel = `relates_by_way_${r}`;
      const n = 1 + (r % 3);
      want.relations.set(rel, n);
      for (let k = 0; k < n; k++) facts.push(f(ids[(r * 17 + k) % ids.length]!, rel, ids[(r * 31 + k * 7 + 1) % ids.length]!));
    }
    for (let i = 0; i < facts.length; i += 2000) await publish(a.url, a.me, facts.slice(i, i + 2000), () => a.clock.t);

    const stats = async (args: Record<string, unknown>) => {
      const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_stats', arguments: args } }) });
      return ((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    };
    type Bucket = { domain: string; type: string; cnt: number };

    // The whole breakdown, as Enox gave it.
    const fullText = await stats({ full: true });
    const full = JSON.parse(fullText) as { total_nodes: number; total_edges: number; by_domain: Bucket[]; by_relation: { relation: string; cnt: number }[] };
    assert.ok(fullText.length > 20_000, `the full form is the long one (${fullText.length} bytes)`);
    assert.deepEqual(new Map(full.by_domain.map((b) => [`${b.domain}\u0000${b.type}`, b.cnt])), want.buckets);
    assert.deepEqual(new Map(full.by_relation.map((x) => [x.relation, x.cnt])), want.relations);
    assert.equal(full.total_nodes, ids.length);
    assert.equal(full.total_edges, [...want.relations.values()].reduce((s, n) => s + n, 0));

    // By default: under 4 KB, with the same totals and every relation…
    const text = await stats({});
    t.diagnostic(`full: ${fullText.length} bytes; by default: ${Buffer.byteLength(text)} bytes`);
    assert.ok(Buffer.byteLength(text) < 4096, `graph_stats by default: ${Buffer.byteLength(text)} bytes`);
    const short = JSON.parse(text) as { total_nodes: number; total_edges: number; by_domain: Bucket[]; by_domain_rest: { buckets: number; nodes: number };
      by_relation: Record<string, number>; full: string };
    assert.deepEqual([short.total_nodes, short.total_edges], [full.total_nodes, full.total_edges]);
    assert.deepEqual(new Map(Object.entries(short.by_relation)), want.relations, 'every relation');
    // … the twenty largest buckets, and a count of the rest.
    const sizes = [...want.buckets.values()].sort((x, y) => y - x);
    assert.equal(short.by_domain.length, 20);
    assert.deepEqual(short.by_domain.map((b) => b.cnt), sizes.slice(0, 20), 'the largest first');
    for (const b of short.by_domain) assert.equal(want.buckets.get(`${b.domain}\u0000${b.type}`), b.cnt);
    assert.deepEqual(short.by_domain_rest, { buckets: 360 - 20, nodes: sizes.slice(20).reduce((s, n) => s + n, 0) });
    assert.match(short.full, /20 largest of 360 .*full: true/);
  } finally { await a.stop(); }
});
