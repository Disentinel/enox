// Enox compatibility: the tool calls Enox clients made run unchanged, with
// answers of the same shape (smart-node/src/mcp, 2026-09-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpCaller } from '../src/client.ts';
import { importEnox } from '../src/import.ts';
import { get, start, tmpDir } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'enox-snapshot.jsonl');

/** The shape of a JSON value: object keys → shapes, arrays → the shape of their first element. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null' : typeof v;
}

// The call shapes (argument names) Enox clients used — 2026-09-26 first, then
// the rest of the recorded history — with synthetic values.
const CALLS: { name: string; args: Record<string, unknown>; json?: unknown; text?: RegExp }[] = [
  { name: 'graph_stats', args: {}, json: { by_domain: [{ cnt: 'number', domain: 'string', type: 'string' }], by_relation: [{ cnt: 'number', relation: 'string' }], total_edges: 'number', total_nodes: 'number' } },
  { name: 'list_shares', args: {}, json: { count: 'number', shares: [] } },
  { name: 'recall', args: { budget: 800, query: 'Ada' }, json: { budget_total: 'number', budget_used: 'number', edges: [{ asserted_by: 'string', confidence: 'number', context: 'string', relation: 'string', source: 'string', target: 'string' }],
    nodes: [{ description: 'string', name: 'string', score: 'number', source_ref: 'string', type: 'string' }], seeds: ['string'] } },
  ...['a', 'b', 'c'].map((k) => ({ name: 'remember', args: { asserted_by: `agent:test-${k}`, confidence: 0.8, domain: 'memory', fact: `Ada decided to write note ${k}.`, relation: 'about', subject: 'Ada' },
    json: { asserted_by: 'string', created: 'boolean', fact: { id: 'string', text: 'string' }, fact_id: 'string', relation: 'string', subject: { id: 'string', name: 'string' } } })),
  { name: 'remember', args: { confidence: 0.7, fact: 'Charles prefers brass.', relation: 'about', subject: 'Charles' },
    json: { asserted_by: 'string', created: 'boolean', fact: { id: 'string', text: 'string' }, fact_id: 'string', relation: 'string', subject: { id: 'string', name: 'string' } } },
  { name: 'semantic_search', args: { include_edges: true, query: 'engines', top_k: 5 }, json: { edges: [], index: 'string', message: 'string', nodes: [] } },
  { name: 'add_assertion', args: { asserted_by: 'agent:test', confidence: 0.9, context: 'fixture', relation: 'extends', source: 'Difference Engine', source_domain: 'example', source_type: 'artifact',
    target: 'Analytical Engine', target_domain: 'example', target_type: 'artifact' },
    json: { asserted_by: 'string', confidence: 'number', context: 'string', created: 'boolean', fact_id: 'string', proof_depth: 'number', relation: 'string', source: 'string', target: 'string', updated: 'boolean' } },
  { name: 'add_assertion', args: { asserted_by: 'agent:test', confidence: 1, context: 'x', relation: 'part_of', source: 'Mill', source_type: 'component', target: 'Analytical Engine', target_type: 'artifact' },
    json: { asserted_by: 'string', confidence: 'number', context: 'string', created: 'boolean', fact_id: 'string', proof_depth: 'number', relation: 'string', source: 'string', target: 'string', updated: 'boolean' } },
  { name: 'batch_assertions', args: { assertions: [{ source: 'Mill', target: 'Store', relation: 'depends_on', confidence: 0.6 }, { source: 'Store', target: 'Analytical Engine', relation: 'part_of' }] },
    json: { failed: 'number', results: [{ asserted_by: 'string', created: 'boolean', fact_id: 'string', ok: 'boolean', relation: 'string', source: 'string', target: 'string' }], succeeded: 'number' } },
  { name: 'explore', args: { entity: 'Ada' }, text: /^# Ada \(person, example\)\n> A synthetic person for the import test\nSource: fixture\nCreated: \S+ \| Updated: \S+\n\n## Outgoing \(\d+\)\n {2}Ada --\[[a-z_]+\]--> .+/ },
];

test('the tool calls an Enox client made on 2026-09-26 run unchanged against a node and get answers of the same shape', async () => {
  const a = await start(tmpDir('enox'), 'node-a');
  try {
    await importEnox(httpCaller(a.url, a.me, () => a.clock.t), a.me, fs.readFileSync(FIXTURE, 'utf8'), { now: () => a.clock.t });
    const token = a.node.operatorToken();
    let id = 0;
    const call = async (name: string, args: unknown, auth = token) => {
      const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      const j = await r.json() as { result: { content: { type: string; text: string }[]; isError?: boolean } };
      return { text: j.result.content[0]!.text, isError: j.result.isError === true };
    };
    const batches0 = (await get(a.url, '/health')).body.batches as number;
    for (const c of CALLS) {
      const r = await call(c.name, c.args);
      assert.equal(r.isError, false, `${c.name}: ${r.text}`);
      if (c.text) assert.match(r.text, c.text, c.name);
      else {
        assert.match(r.text, /^\{\n {2}"/, `${c.name}: Enox answers pretty JSON`);
        assert.deepEqual(shape(JSON.parse(r.text)), c.json, c.name);
      }
    }
    // What was written is there, and nothing was rewritten: the log only grew.
    const recall = JSON.parse((await call('recall', { query: 'Ada decided', budget: 800 })).text) as { nodes: { name: string }[] };
    assert.ok(recall.nodes.some((n) => n.name.startsWith('Ada decided to write note')));
    const q = JSON.parse((await call('query_graph', { query: 'Mill' })).text) as { id: string }[];
    const mill = JSON.parse((await call('query_graph', { node_id: q[0]!.id })).text) as { outgoing: { fact_id: string; relation: string; confidence: number }[] };
    const dep = mill.outgoing.find((e) => e.relation === 'depends_on')!;
    assert.equal(dep.confidence, 0.6);
    const up = JSON.parse((await call('update_assertion', { fact_id: dep.fact_id, confidence: 0.3 })).text) as { confidence: number };
    assert.equal(up.confidence, 0.3);
    assert.equal((await call('delete_assertion', { fact_id: dep.fact_id })).text, `Deleted assertion ${dep.fact_id}`);
    const after = JSON.parse((await call('query_graph', { node_id: q[0]!.id })).text) as { outgoing: { relation: string }[] };
    assert.ok(!after.outgoing.some((e) => e.relation === 'depends_on'), 'a deleted assertion is gone from reads');
    assert.equal((await call('delete_assertion', { fact_id: dep.fact_id })).text, `Assertion ${dep.fact_id} not found`);
    assert.ok(((await get(a.url, '/health')).body.batches as number) > batches0, 'every write was a new batch; none was removed');
    // Reads run inside the caller's access: an unsigned caller sees nothing
    // of an unexported book.
    const anonStats = JSON.parse((await call('graph_stats', {}, '')).text) as { total_nodes: number };
    assert.equal(anonStats.total_nodes, 0);
    // Not found is Enox's text; writes need the operator.
    assert.deepEqual(await call('explore', { entity: 'Nobody At All' }), { text: 'Entity "Nobody At All" not found', isError: true });
    const anon = await call('remember', { subject: 'x', fact: 'y' }, '');
    assert.equal(anon.isError, true);
    assert.match(anon.text, /not_operator/);
  } finally { await a.stop(); }
});
