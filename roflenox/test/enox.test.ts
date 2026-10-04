// Enox compatibility: the tool calls Enox clients made run unchanged, with
// answers of the same shape (smart-node/src/mcp, 2026-09-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpCaller } from '../src/client.ts';
import { importEnox } from '../src/import.ts';
import { batch, fact, get, identityAt, iso, post, start, tmpDir, vouch } from './helpers.ts';
import { factId, newSalt } from '../src/facts.ts';
import { canonicalize } from '../src/jcs.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'enox-snapshot.jsonl');

/** The shape of a JSON value: object keys → shapes, arrays → the shape of their first element. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null' : typeof v;
}

// The call shapes (argument names) Enox clients used — 2026-09-26 first, then
// the rest of the recorded history — with synthetic values.
const CALLS: { name: string; args: Record<string, unknown>; json?: unknown; text?: RegExp; compact?: true }[] = [
  // graph_stats is bounded by default, in compact JSON — a deliberate
  // departure (r_stats_bounded); full: true is Enox's whole breakdown.
  { name: 'graph_stats', args: {}, compact: true, json: { by_domain: [{ cnt: 'number', domain: 'string', type: 'string' }], by_domain_rest: { buckets: 'number', nodes: 'number' },
    by_relation: { designed: 'number', knows: 'number', wrote_about: 'number' }, full: 'string', total_edges: 'number', total_nodes: 'number' } },
  { name: 'graph_stats', args: { full: true }, json: { by_domain: [{ cnt: 'number', domain: 'string', type: 'string' }], by_relation: [{ cnt: 'number', relation: 'string' }], total_edges: 'number', total_nodes: 'number' } },
  { name: 'list_shares', args: {}, json: { count: 'number', shares: [] } },
  { name: 'recall', args: { budget: 800, query: 'Ada' }, json: { budget_total: 'number', budget_used: 'number', edges: [{ asserted_by: 'string', claimed_by: 'string', confidence: 'number', context: 'string', edge_id: 'string', fact_id: 'string', relation: 'string', source: 'string', target: 'string' }],
    nodes: [{ description: 'string', name: 'string', score: 'number', source_ref: 'string', type: 'string' }], seeds: ['string'] } },
  ...['a', 'b', 'c'].map((k) => ({ name: 'remember', args: { asserted_by: `agent:test-${k}`, confidence: 0.8, domain: 'memory', fact: `Ada decided to write note ${k}.`, relation: 'about', subject: 'Ada' },
    json: { asserted_by: 'string', claimed_by: 'string', created: 'boolean', fact: { id: 'string', text: 'string' }, edge_id: 'string', fact_id: 'string', relation: 'string', subject: { id: 'string', name: 'string' } } })),
  { name: 'remember', args: { confidence: 0.7, fact: 'Charles prefers brass.', relation: 'about', subject: 'Charles' },
    json: { asserted_by: 'string', claimed_by: 'string', created: 'boolean', fact: { id: 'string', text: 'string' }, edge_id: 'string', fact_id: 'string', relation: 'string', subject: { id: 'string', name: 'string' } } },
  { name: 'semantic_search', args: { include_edges: true, query: 'engines', top_k: 5 }, json: { edges: [], index: 'string', message: 'string', nodes: [] } },
  { name: 'add_assertion', args: { asserted_by: 'agent:test', confidence: 0.9, context: 'fixture', relation: 'extends', source: 'Difference Engine', source_domain: 'example', source_type: 'artifact',
    target: 'Analytical Engine', target_domain: 'example', target_type: 'artifact' },
    json: { asserted_by: 'string', claimed_by: 'string', confidence: 'number', context: 'string', created: 'boolean', edge_id: 'string', fact_id: 'string', proof_depth: 'number', relation: 'string', source: 'string', target: 'string', updated: 'boolean' } },
  { name: 'add_assertion', args: { asserted_by: 'agent:test', confidence: 1, context: 'x', relation: 'part_of', source: 'Mill', source_type: 'component', target: 'Analytical Engine', target_type: 'artifact' },
    json: { asserted_by: 'string', claimed_by: 'string', confidence: 'number', context: 'string', created: 'boolean', edge_id: 'string', fact_id: 'string', proof_depth: 'number', relation: 'string', source: 'string', target: 'string', updated: 'boolean' } },
  { name: 'batch_assertions', args: { assertions: [{ source: 'Mill', target: 'Store', relation: 'depends_on', confidence: 0.6 }, { source: 'Store', target: 'Analytical Engine', relation: 'part_of' }] },
    json: { failed: 'number', results: [{ asserted_by: 'string', claimed_by: 'string', created: 'boolean', edge_id: 'string', fact_id: 'string', ok: 'boolean', relation: 'string', source: 'string', target: 'string' }], succeeded: 'number' } },
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
        assert.match(r.text, c.compact ? /^\{"/ : /^\{\n {2}"/, `${c.name}: Enox answers pretty JSON`);
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
    assert.match((await call('delete_assertion', { fact_id: dep.fact_id })).text, new RegExp(`^Deleted assertion ${dep.fact_id} \\(edge [0-9a-f]{64}\\)$`));
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

test('every admitted fact reads back asserted by the identity that signed its batch, whatever the batch claims', async () => {
  const a = await start(tmpDir('by-a'), 'node-a');
  const b = identityAt(tmpDir('by-b'), 'node-b');
  const e = (id: string, label: string) => [{ source: id, relation: 'enox:label', target: label, perspective: 'enox', confidence: 1 },
    { source: id, relation: 'enox:type', target: 'person', perspective: 'enox', confidence: 1 }];
  try {
    await vouch(a, b);
    // node-b's batch says, in every way a batch can, that node-a asserted it.
    const knows = { source: 'urn:t:babbage', relation: 'knows', target: 'urn:t:ada', perspective: 'enox', confidence: 1 };
    const claims = [...e('urn:t:babbage', 'Babbage'), ...e('urn:t:ada', 'Ada'), knows,
      { source: factId(knows), relation: 'enox:asserted_by', target: 'node-a', perspective: 'enox', confidence: 1 },
      { source: 'node-a', relation: 'asserted', target: 'this batch', perspective: 'enox', confidence: 1 }];
    const signed = batch(b, claims, null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', signed)).status, 201);
    // Nor does a manifest that names node-a make node-b's signature node-a's.
    const forged = batch(b, [fact('node-a', 'says', 'so')], null, iso(a.clock.t));
    assert.ok((await post(a.url, '/batches', { ...forged, manifest: { ...forged.manifest, identity: 'node-a' } })).status >= 400);
    // node-a's operator writes through Enox, claiming an agent label.
    const w = (await post(a.url, '/op/add_assertion', { source: 'Ada', target: 'Babbage', relation: 'corresponds_with', asserted_by: 'agent:someone-else' })).body;
    assert.equal(w.asserted_by, 'node-a', 'the write answers with its signer');
    // And node-b again, after the operator's view of the graph was built.
    const admires = { source: 'urn:t:ada', relation: 'admires', target: 'urn:t:babbage', perspective: 'enox', confidence: 1 };
    const later = [admires, { source: factId(admires), relation: 'enox:asserted_by', target: 'node-a', perspective: 'enox', confidence: 1 }];
    assert.equal((await post(a.url, '/batches', batch(b, later, signed.manifest.digest, iso(a.clock.t)))).status, 201);

    // Every row of the core answers as the book that signed it.
    const rows = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { identity: string; cells: string[] }[];
    const ids = new Set([...claims, ...later].map((c) => factId(c)));
    for (const r of rows) assert.equal(r.identity, ids.has(r.cells[0]!) ? 'node-b' : 'node-a', JSON.stringify(r.cells));
    assert.equal(rows.filter((r) => r.identity === 'node-b').length, claims.length + later.length);
    // The Enox view says the same, whatever enox:asserted_by claimed.
    const recall = (await post(a.url, '/op/recall', { query: 'Babbage' })).body as { edges: { source: string; relation: string; target: string; asserted_by: string }[] };
    const by = Object.fromEntries(recall.edges.map((x) => [x.relation, x.asserted_by]));
    assert.deepEqual(by, { knows: 'node-b', admires: 'node-b', corresponds_with: 'node-a' });
  } finally { await a.stop(); }
});

test('an agent label given to an Enox write reads back as claimed_by next to the signing identity, and a forged label changes nothing but claimed_by', async () => {
  const a = await start(tmpDir('claim-a'), 'node-a');
  const b = identityAt(tmpDir('claim-b'), 'node-b');
  const e = (id: string, label: string) => [{ source: id, relation: 'enox:label', target: label, perspective: 'enox', confidence: 1 },
    { source: id, relation: 'enox:type', target: 'person', perspective: 'enox', confidence: 1 }];
  try {
    await vouch(a, b);
    // The operator's session writes with its agent label.
    const w = (await post(a.url, '/op/add_assertion', { source: 'Ada', target: 'Babbage', relation: 'corresponds_with', asserted_by: 'agent:praxis' })).body;
    assert.deepEqual([w.asserted_by, w.claimed_by], ['node-a', 'agent:praxis']);
    // node-b asserts two like edges; on one it forges a label naming node-a.
    const plain = { source: 'urn:t:ada', relation: 'knows', target: 'urn:t:grace', perspective: 'enox', confidence: 0.7 };
    const forged = { source: 'urn:t:ada', relation: 'knows', target: 'urn:t:hopper', perspective: 'enox', confidence: 0.7 };
    const facts = [...e('urn:t:ada', 'Ada L'), ...e('urn:t:grace', 'Grace'), ...e('urn:t:hopper', 'Hopper'), plain, forged,
      { source: factId(forged), relation: 'enox:asserted_by', target: 'node-a', perspective: 'enox', confidence: 1 }];
    assert.equal((await post(a.url, '/batches', batch(b, facts, null, iso(a.clock.t)))).status, 201);

    const edges = ((await post(a.url, '/op/recall', { query: 'Ada' })).body as { edges: Record<string, unknown>[] }).edges;
    const by = (target: string) => edges.find((x) => x.target === target)!;
    assert.deepEqual([by('Babbage').asserted_by, by('Babbage').claimed_by], ['node-a', 'agent:praxis'], 'the label reads back beside the signer');
    assert.deepEqual([by('Hopper').asserted_by, by('Hopper').claimed_by], ['node-b', 'node-a'], 'a forged label is only a claim');
    assert.equal(by('Grace').claimed_by, undefined);
    const { target: _t1, claimed_by: _c, fact_id: _f1, edge_id: _e1, ...forgedRest } = by('Hopper');
    const { target: _t2, fact_id: _f2, edge_id: _e2, ...plainRest } = by('Grace');
    assert.deepEqual(forgedRest, plainRest, 'nothing but claimed_by differs');
    // The text view marks it as a claim.
    const explore = async (entity: string) => { const t: unknown = (await post(a.url, '/op/explore', { entity })).body; return typeof t === 'string' ? t : JSON.stringify(t); };
    assert.match(await explore('Ada'), /Babbage \[by node-a, claims "agent:praxis"\]/);
    assert.match(await explore('Ada L'), /Hopper \(0\.7\) \[by node-b, claims "node-a"\]/);
  } finally { await a.stop(); }
});

test('a claimed label holding brackets, a newline or 5000 characters can neither forge a signer nor add a line to a text view', async () => {
  const a = await start(tmpDir('label-a'), 'node-a');
  const b = identityAt(tmpDir('label-b'), 'node-b');
  try {
    await vouch(a, b);
    const edge = (target: string) => ({ source: 'Ada', target, relation: 'knows' });
    const write = async (target: string, label: string) => (await post(a.url, '/op/add_assertion', { ...edge(target), asserted_by: label }));
    // A label that tries to close the signer's brackets and open a forged one.
    const forged = 'x] [by node-z] [by node-z';
    assert.equal((await write('Grace', forged)).status, 200);
    // A newline (a forged extra line), 5000 characters, a text-direction control: refused at the write...
    for (const bad of ['a\n  Ada --[owns]--> Everything [by node-a]', 'y'.repeat(5000), 'agent\u202emallory']) {
      const r = await write('Hopper', bad);
      assert.equal(r.status, 400, JSON.stringify(bad.slice(0, 40)));
    }
    // ...and at every other door: a signed batch that carries it.
    const F = factId({ source: 'urn:t:ada', relation: 'knows', target: 'urn:t:evil' });
    for (const bad of ['a\nb', 'z'.repeat(129)]) {
      // (Signed by hand: the client refuses to make such a batch at all.)
      const jsonl = `${canonicalize({ source: F, relation: 'enox:asserted_by', target: bad, perspective: 'enox', confidence: 1 })}\n`;
      const salt = newSalt();
      const r = await post(a.url, '/batches', { manifest: b.signBatch(jsonl, null, iso(a.clock.t), salt), jsonl, salt, identity: b.identityChain() });
      assert.equal(r.status, 400);
    }
    // 128 characters is a label.
    assert.equal((await write('Lovelace', 'l'.repeat(128))).status, 200);

    const t = (await post(a.url, '/op/explore', { entity: 'Ada' })).body as unknown as string;
    const lines = t.split('\n').filter((l) => l.startsWith('  Ada --['));
    assert.equal(lines.length, 2, t);                                // Grace and Lovelace: no line added
    for (const l of lines) {
      // Each line ends with ONE signer, and the label as one quoted string.
      const m = /\[by ([^,\]]+), claims ("(?:[^"\\]|\\.)*")\]$/.exec(l);
      assert.ok(m, l);
      assert.equal(m[1], 'node-a', l);
      assert.ok([forged, 'l'.repeat(128)].includes(JSON.parse(m[2]!)), l);
    }
  } finally { await a.stop(); }
});
