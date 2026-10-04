// The owner's claude.ai retest of the deployed node, 2026-10-04: one name per
// edge, a live view, writes that answer what they wrote, a schema to learn the
// query language from, consistent errors and bounded reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { bookOf } from '../src/identity.ts';
import { factId } from '../src/facts.ts';
import { searchKey } from '../src/node.ts';
import { DAY, grant, identityAt, iso, post, start, T0, tmpDir, vouch, type Running } from './helpers.ts';

type Text = { text: string; isError: boolean };
const factIdOf = (source: string, relation: string, target: string) => factId({ source, relation, target });

/** Call an MCP tool on `a` as its operator (the owner, through claude.ai). */
function tools(a: Running) {
  let id = 0;
  return async (name: string, args: Record<string, unknown> = {}): Promise<Text> => {
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (j.error) return { text: j.error.message, isError: true };
    return { text: j.result!.content[0]!.text, isError: j.result!.isError === true };
  };
}
const json = <T>(t: Text): T => { assert.equal(t.isError, false, t.text); return JSON.parse(t.text) as T; };
type Rows = { vars: string[]; rows: { identity: string; cells: (string | number)[] }[]; note?: string };
const ask = async (a: Running, query: string, perspective?: string) =>
  (await post(a.url, '/ask', { query, ...(perspective ? { perspective } : {}) })).body as unknown as Rows;

test('update_assertion, delete_assertion and why accept either the Enox fact_id or the fact id ask returns, and add_assertion returns both', async () => {
  const a = await start(tmpDir('one-id'), 'node-a');
  try {
    const call = tools(a);
    type Added = { fact_id: string; edge_id: string; source: string; target: string };
    const ab = json<Added>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', context: 'c1' }));
    const bc = json<Added>(await call('add_assertion', { source: 'Beta', target: 'Gamma', relation: 'uses' }));
    // Both names, and each is what the other side calls the edge.
    const asked = await ask(a, `edge(F, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`);
    assert.deepEqual(asked.rows.map((r) => r.cells[0]), [ab.edge_id]);
    assert.deepEqual((await ask(a, `edge(G, ${JSON.stringify(ab.edge_id)}, "enox:fact_id", X)`)).rows.map((r) => r.cells[1]), [ab.fact_id]);
    assert.notEqual(ab.fact_id, ab.edge_id);

    // why, by either name: the same explanation of the same edge.
    const lit = (id: string) => `edge(${JSON.stringify(id)}, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`;
    const byF = json<{ holds: boolean; text: string }[]>(await call('why', { literal: lit(ab.edge_id) }));
    const byEnox = json<{ holds: boolean; text: string }[]>(await call('why', { literal: lit(ab.fact_id) }));
    assert.ok(byF.length > 0 && byF.every((e) => e.holds), JSON.stringify(byF));
    assert.deepEqual(byEnox, byF);
    // A reader with a grant names it by its Enox id too (asked of the engine, not the operator's view).
    const reader = identityAt(tmpDir('one-id-reader'), 'reader');
    await vouch(a, reader);
    await publish(a.url, a.me, [grant('reader', iso(T0 + DAY))], () => a.clock.t);
    const theirs = (await post(a.url, '/op/why', { literal: lit(ab.fact_id) }, { as: reader })).body as unknown as { identity: string; holds: boolean }[];
    assert.deepEqual(theirs.map((e) => [e.identity, e.holds]), [['node-a', true]], JSON.stringify(theirs));
    // ask too: the Enox id names the same fact.
    assert.deepEqual(((await post(a.url, '/op/ask', { query: `conf(${JSON.stringify(ab.fact_id)}, C)` })).body as unknown as Rows).rows.map((r) => r.cells), [[1000]]);

    // update_assertion by either name.
    const u1 = json<{ confidence: number; fact_id: string; edge_id: string }>(await call('update_assertion', { fact_id: ab.edge_id, confidence: 0.4 }));
    assert.deepEqual([u1.confidence, u1.fact_id, u1.edge_id], [0.4, ab.fact_id, ab.edge_id]);
    const u2 = json<{ confidence: number }>(await call('update_assertion', { fact_id: ab.fact_id, confidence: 0.3 }));
    assert.equal(u2.confidence, 0.3);
    assert.deepEqual((await ask(a, `conf(${JSON.stringify(ab.edge_id)}, C)`)).rows.map((r) => r.cells[0]), [300]);

    // delete_assertion by either name; the answer names both.
    const d1 = await call('delete_assertion', { fact_id: ab.edge_id });
    assert.equal(d1.text.split('\n')[0], `Deleted assertion ${ab.fact_id} (edge ${ab.edge_id})`);
    const d2 = await call('delete_assertion', { fact_id: bc.fact_id });
    assert.equal(d2.text.split('\n')[0], `Deleted assertion ${bc.fact_id} (edge ${bc.edge_id})`);
    for (const x of [ab, bc]) assert.deepEqual((await ask(a, `conf(${JSON.stringify(x.edge_id)}, C)`)).rows.map((r) => r.cells[0]), [0]);
    // An id that names nothing is still not found.
    assert.equal((await call('delete_assertion', { fact_id: 'f'.repeat(64) })).isError, true);
  } finally { await a.stop(); }
});

test('after delete_assertion the edge is gone from live and still in edge with confidence zero', async () => {
  const a = await start(tmpDir('live-del'), 'node-a');
  try {
    const call = tools(a);
    const ab = json<{ edge_id: string; source: string; target: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    json(await call('add_assertion', { source: 'Alpha', target: 'Gamma', relation: 'uses' }));
    const q = `(F, ${JSON.stringify(ab.source)}, "uses", T)`;
    assert.equal((await ask(a, `live${q}`)).rows.length, 2);
    assert.equal((await call('delete_assertion', { fact_id: ab.edge_id })).isError, false);
    const live = await ask(a, `live${q}`);
    assert.deepEqual(live.vars, ['F', 'T']);
    assert.equal(live.rows.length, 1);
    assert.ok(!live.rows.some((r) => r.cells[0] === ab.edge_id), 'the deleted edge is not live');
    // edge stays the whole history: the deleted edge is there, at confidence 0.
    assert.ok((await ask(a, `edge${q}`)).rows.some((r) => r.cells[0] === ab.edge_id));
    assert.deepEqual((await ask(a, `conf(${JSON.stringify(ab.edge_id)}, C)`)).rows.map((r) => r.cells[0]), [0]);
    // why and whynot agree with ask.
    const lit = `live(${JSON.stringify(ab.edge_id)}, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`;
    const w = (await post(a.url, '/op/whynot', { literal: lit })).body as unknown as { holds: boolean; text: string }[];
    assert.deepEqual(w.map((e) => e.holds), [false]);
    assert.match(w[0]!.text, /retired \(confidence 0\)/);
    // Re-asserted, it is live again.
    json(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    assert.equal((await ask(a, `live${q}`)).rows.length, 2);
  } finally { await a.stop(); }
});

test('after update_node only the new description holds in live while the old one stays in edge', async () => {
  const a = await start(tmpDir('live-desc'), 'node-a');
  try {
    const call = tools(a);
    const ab = json<{ source: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    json(await call('update_node', { node_id: ab.source, description: 'the old description' }));
    json(await call('update_node', { node_id: ab.source, description: 'the new description', name: 'Alpha Prime' }));
    const q = (p: string, r: string) => `${p}(F, ${JSON.stringify(ab.source)}, "${r}", T)`;
    const values = async (p: string, r: string) => (await ask(a, q(p, r))).rows.map((x) => x.cells[1]).sort();
    assert.deepEqual(await values('live', 'enox:description'), ['the new description']);
    assert.deepEqual(await values('edge', 'enox:description'), ['the new description', 'the old description']);
    assert.deepEqual(await values('live', 'enox:label'), ['Alpha Prime']);
    assert.deepEqual(await values('edge', 'enox:label'), ['Alpha', 'Alpha Prime']);
    // Setting the old value again makes it the value again: the latest write wins.
    json(await call('update_node', { node_id: ab.source, description: 'the old description' }));
    assert.deepEqual(await values('live', 'enox:description'), ['the old description']);
    // The Enox read agrees.
    assert.match((await call('explore', { entity: 'Alpha Prime' })).text, /> the old description/);
  } finally { await a.stop(); }
});

test('a grant replaced by a newer grant to the same grantee leaves exactly one grant in live', async () => {
  const a = await start(tmpDir('live-grant'), 'node-a');
  try {
    const reader = identityAt(tmpDir('live-grant-r'), 'reader');
    await vouch(a, reader);
    const pub = (until: number, c = 1) => publish(a.url, a.me, [{ ...grant('reader', iso(until)), confidence: c }], () => a.clock.t);
    const reads = async () => (await post(a.url, '/ask', { query: `edge[${bookOf('node-a')}](F, S, R, T)` }, { as: reader })).status;
    await pub(T0 + 10 * DAY);
    await pub(T0 + DAY);                                           // newer, and shorter: it replaces the first
    const live = await ask(a, 'live(F, "reader", "roflenox:grant", U)');
    assert.deepEqual(live.rows.map((r) => r.cells[1]), [iso(T0 + DAY)]);
    assert.equal((await ask(a, 'edge(F, "reader", "roflenox:grant", U)')).rows.length, 2, 'both stay in edge');
    assert.deepEqual((await ask(a, 'grant(R, U)')).rows.map((r) => r.cells), [['reader', (T0 + DAY) / 1000]], 'the engine holds the one in force');
    // In force means what access does: the reader reads until the newer grant ends, not the older.
    assert.equal(await reads(), 200);
    a.clock.t = T0 + 2 * DAY;
    assert.equal(await reads(), 403);
    assert.deepEqual((await ask(a, 'live(F, "reader", "roflenox:grant", U)')).rows, [], 'an expired grant is not live');
    // A grant again, then retired: an older grant never comes back into force.
    await pub(T0 + 5 * DAY);
    assert.equal(await reads(), 200);
    await pub(T0 + 5 * DAY, 0);
    assert.equal(await reads(), 410);
    assert.deepEqual((await ask(a, 'live(F, S, "roflenox:grant", U)')).rows, []);
    // The same after a restart: replay keeps which grant is in force.
    await a.node.close();
    const { RoflenoxNode } = await import('../src/node.ts');
    const n = await RoflenoxNode.open({ dataDir: a.dir, now: () => a.clock.t });
    try {
      assert.deepEqual((await n.ask('grant(R, U)', a.me.name)).rows, []);
    } finally { await n.close(); }
  } finally { await a.stop().catch(() => {}); }
});

test('add_assertion that creates its target node leaves that node without a description and keeps the context on the edge', async () => {
  const a = await start(tmpDir('ctx-stays'), 'node-a');
  try {
    const call = tools(a);
    json(await call('update_node', { node_id: json<{ source: string }>(await call('add_assertion', { source: 'Alpha', target: 'Seed', relation: 'seeds' })).source, description: 'Alpha, described' }));
    const context = 'Alpha uses Beta because the benchmark said so. More detail follows here.';
    const ab = json<{ source: string; target: string; context: string; edge_id: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', context }));
    assert.equal(ab.context, context);
    // The created node: no description, in the view and in the facts.
    const beta = json<{ node: { description: string } }>(await call('query_graph', { node_id: ab.target }));
    assert.equal(beta.node.description, '');
    assert.deepEqual((await ask(a, `edge(F, ${JSON.stringify(ab.target)}, "enox:description", T)`)).rows, []);
    assert.doesNotMatch((await call('explore', { entity: 'Beta' })).text, /benchmark said so\.\n|^> /m);
    // The existing source keeps its own description.
    assert.equal(json<{ node: { description: string } }>(await call('query_graph', { node_id: ab.source })).node.description, 'Alpha, described');
    // The context is on the edge.
    assert.deepEqual((await ask(a, `edge(G, ${JSON.stringify(ab.edge_id)}, "enox:context", T)`)).rows.map((r) => r.cells[1]), [context]);
    assert.match((await call('explore', { entity: 'Alpha' })).text, /Alpha --\[uses\]--> Beta[^\n]*\n {4}context: Alpha uses Beta because the benchmark said so/);
    // batch_assertions the same.
    json(await call('batch_assertions', { assertions: [{ source: 'Gamma', target: 'Delta', relation: 'uses', context: 'a batch context' }] }));
    const delta = json<{ id: string; description: string }[]>(await call('query_graph', { query: 'Delta' }));
    assert.deepEqual(delta.map((x) => x.description), ['']);
    const gamma = json<{ id: string; description: string }[]>(await call('query_graph', { query: 'Gamma' }));
    assert.deepEqual(gamma.map((x) => x.description), ['']);
  } finally { await a.stop(); }
});

test('retract_node removes a node and its edges from explore, traverse, query_graph and live in one batch, and they remain in edge with confidence zero', async () => {
  const a = await start(tmpDir('retract-node'), 'node-a');
  try {
    const call = tools(a);
    const ab = json<{ source: string; target: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', context: 'why Alpha uses Beta' }));
    json(await call('add_assertion', { source: 'Gamma', target: 'Beta', relation: 'cites' }));
    json(await call('add_assertion', { source: 'Beta', target: 'Delta', relation: 'part_of' }));
    json(await call('add_assertion', { source: 'Alpha', target: 'Delta', relation: 'uses' }));
    json(await call('update_node', { node_id: ab.target, description: 'Beta, described', aliases: ['B'] }));
    const beta = JSON.stringify(ab.target);
    const touching = [`edge(F, ${beta}, R, T)`, `edge(F, S, R, ${beta})`];
    const held = (await Promise.all(touching.map((q) => ask(a, q)))).flatMap((r) => r.rows.map((x) => x.cells[0]));
    assert.ok(held.length >= 9, `facts about Beta: ${held.length}`);
    const batches = async () => (await post(a.url, '/op/health', {})).body.batches as number;
    const before = await batches();

    const r = json<{ node_id: string; retracted: number; edges: number; edge_ids: string[] }>(await call('retract_node', { node_id: ab.target }));
    assert.equal(await batches(), before + 1, 'one batch');
    assert.deepEqual([r.node_id, r.edges, r.retracted], [ab.target, 3, held.length]);

    // Gone from every Enox read …
    assert.equal((await call('explore', { entity: ab.target })).isError, true);
    assert.deepEqual(json<unknown[]>(await call('query_graph', { query: 'Beta' })), []);
    assert.equal(json<{ node: unknown }>(await call('query_graph', { node_id: ab.target })).node, null);
    const alpha = json<{ outgoing: { target: string }[] }>(await call('query_graph', { node_id: ab.source }));
    assert.deepEqual(alpha.outgoing.map((e) => e.target).filter((t) => t === ab.target), []);
    assert.doesNotMatch((await call('traverse', { entity: 'Alpha', max_depth: 3 })).text, /Beta/);
    assert.doesNotMatch((await call('explore', { entity: 'Gamma' })).text, /Beta/);
    // … and from live; the other ends stay.
    for (const q of touching) assert.deepEqual((await ask(a, q.replace(/^edge/, 'live'))).rows, [], q);
    for (const name of ['Alpha', 'Gamma', 'Delta']) assert.equal((await call('explore', { entity: name })).isError, false, name);
    assert.match((await call('explore', { entity: 'Alpha' })).text, /Alpha --\[uses\]--> Delta/);
    // History: every fact is still in edge, at confidence 0.
    const after = (await Promise.all(touching.map((q) => ask(a, q)))).flatMap((x) => x.rows.map((y) => y.cells[0]));
    assert.deepEqual(after.sort(), [...held].sort());
    for (const F of after) assert.deepEqual((await ask(a, `conf(${JSON.stringify(F)}, C)`)).rows.map((x) => x.cells[0]), [0], String(F));
    // A node that is not there is not found.
    assert.equal((await call('retract_node', { node_id: 'enox://example.org/graph/main/cs/nothing' })).isError, true);
  } finally { await a.stop(); }
});

test('delete_assertion retracts a fact asserted through assert under another perspective', async () => {
  const a = await start(tmpDir('del-persp'), 'node-a');
  try {
    const call = tools(a);
    const claim = { source: 'session-7', relation: 'zz_claim', target: 'task-42', perspective: 'zz_coord', confidence: 1 };
    const kept = { source: 'session-8', relation: 'zz_claim', target: 'task-43', perspective: 'zz_coord', confidence: 1 };
    assert.equal(json<{ admitted: boolean }>(await call('assert', { facts: [claim, kept] })).admitted, true);
    const rows = (await ask(a, 'edge(F, "session-7", "zz_claim", T)')).rows;
    assert.equal(rows.length, 1);
    const F = rows[0]!.cells[0] as string;
    assert.equal((await ask(a, 'edge(F, S, "zz_claim", T)', 'zz_coord')).rows.length, 2);

    const d = await call('delete_assertion', { fact_id: F });
    assert.equal(d.isError, false, d.text);
    assert.equal(d.text.split('\n')[0], `Deleted assertion ${F} (edge ${F})`, 'a fact no Enox write named has one id');
    // Retracted under its own perspective, not re-asserted under "enox".
    assert.deepEqual((await ask(a, `asserted(${JSON.stringify(F)}, P, C, S)`)).rows.map((r) => r.cells.slice(0, 2)), [['zz_coord', 0]]);
    assert.deepEqual((await ask(a, 'live(F, S, "zz_claim", T)')).rows.map((r) => r.cells[1]), ['session-8']);
    assert.equal((await ask(a, 'edge(F, S, "zz_claim", T)')).rows.length, 2, 'the log keeps it');
    // Deleted once, it is not found again.
    assert.equal((await call('delete_assertion', { fact_id: F })).isError, true);
    // A fact between Enox entities asserted under another perspective: by its Enox fact_id too.
    const ab = json<{ fact_id: string; edge_id: string; source: string; target: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    json(await call('assert', { facts: [{ source: ab.source, relation: 'zz_depends', target: ab.target, perspective: 'zz_coord', confidence: 1 },
      { source: factIdOf(ab.source, 'zz_depends', ab.target), relation: 'enox:fact_id', target: 'e'.repeat(64), perspective: 'enox', confidence: 1 }] }));
    const del = await call('delete_assertion', { fact_id: 'e'.repeat(64) });
    assert.equal(del.text.split('\n')[0], `Deleted assertion ${'e'.repeat(64)} (edge ${factIdOf(ab.source, 'zz_depends', ab.target)})`);
    assert.deepEqual((await ask(a, `live(F, S, "zz_depends", T)`)).rows, []);
    assert.deepEqual((await ask(a, 'live(F, S, "zz_claim", T)')).rows.map((r) => r.cells[1]), ['session-8'], 'the other fact stays');
  } finally { await a.stop(); }
});

test('assert returns the batch digest, its chain position and every admitted fact id, and they match chain and ask', async () => {
  const a = await start(tmpDir('assert-receipt'), 'node-a');
  try {
    const call = tools(a);
    type Receipt = { admitted: boolean; identity: string; facts: number; digest: string; seq: number; fact_ids: string[] };
    const facts = [{ source: 'session-7', relation: 'zz_claim', target: 'task-42', perspective: 'zz_coord', confidence: 1 },
      { source: 'session-7', relation: 'zz_note', target: 'started', perspective: 'zz_coord', confidence: 0.5 }];
    const first = json<Receipt>(await call('assert', { facts }));
    const second = json<Receipt>(await call('assert', { facts: [{ ...facts[0]!, confidence: 0 }] }));
    const chain = json<{ digests: string[] }>(await call('chain', { identity: 'node-a' }));
    for (const r of [first, second]) {
      assert.equal(r.identity, 'node-a');
      assert.match(r.digest, /^[0-9a-f]{64}$/);
      assert.equal(chain.digests[r.seq], r.digest, 'chain[seq] is the batch');
    }
    assert.equal(second.seq, first.seq + 1);
    assert.equal(first.fact_ids.length, 2);
    // Each id is ask's F of that fact, and asserted names the same position.
    for (const [i, f] of facts.entries()) {
      const rows = (await ask(a, `edge(F, ${JSON.stringify(f.source)}, ${JSON.stringify(f.relation)}, ${JSON.stringify(f.target)})`)).rows;
      assert.deepEqual(rows.map((r) => r.cells[0]), [first.fact_ids[i]]);
    }
    assert.deepEqual((await ask(a, `asserted(${JSON.stringify(first.fact_ids[1])}, P, C, S)`)).rows.map((r) => r.cells), [['zz_coord', 500, first.seq]]);
    assert.deepEqual((await ask(a, `asserted(${JSON.stringify(second.fact_ids[0])}, P, C, S)`)).rows.map((r) => r.cells), [['zz_coord', 0, second.seq]]);
    // The Enox writes answer the same way.
    type Batch = { batch: { digest: string; seq: number; fact_ids: string[] } };
    const added = json<Batch & { edge_id: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    assert.equal(added.batch.seq, second.seq + 1);
    assert.equal(json<{ digests: string[] }>(await call('chain', { identity: 'node-a' })).digests[added.batch.seq], added.batch.digest);
    assert.ok(added.batch.fact_ids.includes(added.edge_id));
    for (const F of added.batch.fact_ids) assert.equal((await ask(a, `conf(${JSON.stringify(F)}, C)`)).rows.length, 1, F);
    const updated = json<Batch>(await call('update_assertion', { fact_id: added.edge_id, confidence: 0.5 }));
    assert.equal(updated.batch.seq, added.batch.seq + 1);
    assert.match((await call('delete_assertion', { fact_id: added.edge_id })).text, new RegExp(`\\nbatch [0-9a-f]{64} \\(seq ${updated.batch.seq + 1}, 2 facts\\)$`));
  } finally { await a.stop(); }
});

test('the schema tool lists every predicate ask answers with its arity and every perspective present, and asking each listed predicate with its arity is never refused', async () => {
  const a = await start(tmpDir('schema'), 'node-a');
  try {
    const call = tools(a);
    json(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    json(await call('assert', { facts: [{ source: 'session-7', relation: 'zz_claim', target: 'task-42', perspective: 'zz_coord', confidence: 1 },
      { source: 'session-7', relation: 'zz_claim', target: 'task-43', perspective: 'zz_coord', confidence: 0 },
      { source: 'pair(X) :- edge(F, X, "zz_claim", T).', relation: 'roflenox:rule', target: 'pair(X) :- edge(F, X, "zz_claim", T).', perspective: 'rules', confidence: 1 }] }));
    await publish(a.url, a.me, [grant('reader', iso(T0 + DAY))], () => a.clock.t);
    type Schema = { predicates: { name: string; arity: number; args: string[]; meaning: string }[]; perspectives: { perspective: string; facts: number }[];
      units: Record<string, string> };
    const s = json<Schema>(await call('schema'));
    const names = s.predicates.map((p) => `${p.name}/${p.arity}`);
    for (const p of ['edge/4', 'live/4', 'conf/2', 'asserted/4', 'persp/2', 'intent/4', 'answered/3', 'grant/2', 'delegate/2', 'export/2', 'follows/2', 'trusts/1', 'edge_num/4', 'pair/1']) {
      assert.ok(names.includes(p), `${p} in ${names.join(', ')}`);
    }
    for (const p of s.predicates) {
      assert.equal(p.args.length, p.arity, p.name);
      assert.ok(p.meaning.length > 10, p.name);
    }
    // Every perspective present, with its facts (the ones asserted now, retired ones too).
    const counts = Object.fromEntries(s.perspectives.map((p) => [p.perspective, p.facts]));
    assert.deepEqual(Object.keys(counts).sort(), ['enox', 'policy', 'rules', 'zz_coord']);
    assert.deepEqual([counts.zz_coord, counts.rules, counts.policy], [2, 1, 1]);
    const total = (await ask(a, 'persp(F, P)')).rows.length;
    assert.equal(s.perspectives.reduce((n, p) => n + p.facts, 0), total);
    // The units, and the ask tool points here.
    assert.match(s.units.confidence!, /per mille/);
    assert.match(s.units.confidence!, /0\.\.1/);
    const list = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const askTool = ((await list.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools.find((t) => t.name === 'ask')!;
    assert.match(askTool.description, /schema tool/);
    // Each listed predicate, asked with its arity, is answered, never refused.
    for (const p of s.predicates) {
      const r = await post(a.url, '/ask', { query: `${p.name}(${p.args.join(', ')})` });
      assert.equal(r.status, 200, `${p.name}/${p.arity}: ${JSON.stringify(r.body)}`);
      assert.deepEqual((r.body as { vars: string[] }).vars, p.args, p.name);
    }
    // A stranger sees only what it may: no perspective of a book it may not read.
    const anon = (await post(a.url, '/op/schema', {}, { as: null })).body as unknown as Schema;
    assert.deepEqual(anon.perspectives, []);
    assert.ok(!anon.predicates.some((p) => p.name === 'pair'), 'no rule head of a book it may not read');
  } finally { await a.stop(); }
});

test('wrong arity, a conjunction, a negation and a fact held only under another perspective each get one consistent explanation without engine internals', async () => {
  const a = await start(tmpDir('query-errors'), 'node-a');
  try {
    const call = tools(a);
    const asked = async (query: string, perspective?: string) => post(a.url, '/ask', { query, ...(perspective ? { perspective } : {}) });
    json(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    // answered/3 names its variables in a book with no rules too.
    assert.deepEqual((await asked('answered(K, E, V)')).body.vars, ['K', 'E', 'V']);
    json(await call('assert', { facts: [{ source: 'session-7', relation: 'zz_claim', target: 'task-42', perspective: 'zz_coord', confidence: 1 },
      { source: 'pair(X) :- edge(F, X, "zz_claim", T).', relation: 'roflenox:rule', target: 'pair(X) :- edge(F, X, "zz_claim", T).', perspective: 'rules', confidence: 1 }] }));
    const INTERNAL = /engine|clause|closing dot|parse error|unexpected/i;

    // A wrong arity is a note, for every predicate: the node's own, the engine's, a rule's.
    for (const [q, n, m] of [['asserted(A, B)', 4, 2], ['conf(F)', 2, 1], ['persp(F, P, X)', 2, 3], ['live(F, S)', 4, 2], ['edge(F, S, R)', 4, 3],
      ['intent(K, E)', 4, 2], ['delegate(A)', 2, 1], ['export(R, A, X)', 2, 3], ['answered(K, E)', 3, 2], ['grant(R)', 2, 1], ['pair(X, Y)', 1, 2]] as const) {
      const r = await asked(q);
      assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.rows, [], q);
      assert.equal(r.body.note, `${q.split('(')[0]} takes ${n} argument${n === 1 ? '' : 's'}, not ${m}`, q);
    }
    // A conjunction and a negation: the same refusal, saying a question is one literal.
    const conj = await asked('edge(F, S, R, T), conf(F, C)');
    const neg = await asked('not edge(F, S, "uses", T)');
    const neg2 = await asked('edge(F, S, R, T), not conf(F, 0)');
    for (const r of [conj, neg, neg2]) {
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'bad_query');
      assert.match(String(r.body.message), /^a question is one literal, rel\(Args\) or rel\[book\]\(Args\)/);
      assert.doesNotMatch(String(r.body.message), INTERNAL);
    }
    assert.equal(conj.body.message, neg.body.message);
    // Malformed inside one literal: no engine wording either.
    const bad = await asked('edge(F, "unterminated, R, T)');
    assert.equal(bad.status, 400);
    assert.doesNotMatch(String(bad.body.message), INTERNAL);
    // answered/3 names its variables, rules or none.
    assert.deepEqual((await asked('answered(K, E, V)')).body.vars, ['K', 'E', 'V']);
    // A fact held only under another perspective: the note names it.
    const other = await asked('edge(F, S, "zz_claim", T)', 'enox');
    assert.deepEqual(other.body.rows, []);
    assert.match(String(other.body.note), /nothing under perspective "enox" matches; edge\(F, S, "zz_claim", T\) has 1 row asserted under other perspectives: 1 under "zz_coord"/);
    // A hash-like id gets no nearest names.
    const hash = await asked(`edge(F, "${'ab'.repeat(32)}", R, T)`);
    assert.equal(hash.body.note, `no edge has "${'ab'.repeat(32)}" as its source`);
    // Control: a misspelt word still gets its nearest names.
    assert.match(String((await asked('edge(F, S, "usez", T)')).body.note), /the nearest that do: "uses"/);
  } finally { await a.stop(); }
});

test('chain pages with a limit, semantic_search cuts descriptions to the cap, and why on an Enox edge answers once with the batch and claim of its axiom', async () => {
  const a = await start(tmpDir('bounded'), 'node-a');
  try {
    const call = tools(a);
    // A chain longer than a page.
    for (let k = 0; k < 104; k++) json(await call('assert', { facts: [{ source: `s${k}`, relation: 'zz_step', target: `t${k}`, perspective: 'zz', confidence: 1 }] }));
    type Chain = { digests: string[]; total: number; head: string; cut?: boolean; cursor?: string };
    const first = json<Chain>(await call('chain', { identity: 'node-a' }));
    assert.equal(first.digests.length, 100, 'a default page');
    assert.equal(first.total, 104);
    assert.equal(first.cut, true);
    const pages: string[] = [];
    for (let cursor: string | undefined; ;) {
      const p = json<Chain>(await call('chain', { identity: 'node-a', limit: 30, ...(cursor ? { cursor } : {}) }));
      assert.ok(p.digests.length <= 30);
      pages.push(...p.digests);
      if (!p.cut) break;
      cursor = p.cursor;
    }
    assert.equal(pages.length, 104);
    assert.equal(new Set(pages).size, 104);
    assert.equal(pages.at(-1), first.head);
    const health = (await post(a.url, '/op/health', {})).body as { heads: Record<string, string> };
    assert.equal(first.head, health.heads['node-a']);
    // A client that publishes reads the head from the page, past the first page.
    await publish(a.url, a.me, [{ source: 'x', relation: 'zz_after', target: 'y', perspective: 'zz', confidence: 1 }], () => a.clock.t);
    assert.equal(json<Chain>(await call('chain', { identity: 'node-a', limit: 1 })).total, 105);

    // semantic_search: an embedder's answer, with a description longer than the cap.
    const emb = identityAt(tmpDir('bounded-emb'), 'embedder.example.org');
    await vouch(a, emb);
    const long = `${'A long abstract about polynomial tables and engines. '.repeat(20)}End.`;
    const ab = json<{ source: string; target: string; edge_id: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', context: long, asserted_by: 'agent:test' }));
    json(await call('update_node', { node_id: ab.source, description: long }));
    await publish(a.url, a.me, [{ source: 'embedder.example.org', relation: 'roflenox:embedder', target: 'search', perspective: 'policy', confidence: 1 }], () => a.clock.t);
    const Q = 'polynomial engines';
    await publish(a.url, emb, [{ source: searchKey(Q), relation: 'roflenox:result', perspective: 'search', confidence: 1,
      target: JSON.stringify({ hits: [{ kind: 'node', id: ab.source, score: 0.9 }, { kind: 'fact', id: ab.edge_id, score: 0.8 }] }) },
    { source: 'n:x', relation: 'roflenox:embedding', target: '[0.1]', perspective: 'search', confidence: 1 }], () => a.clock.t);
    type Found = { nodes: { description: string }[]; edges: { context: string }[] };
    const found = json<Found>(await call('semantic_search', { query: Q, include_edges: true }));
    assert.equal(found.nodes.length, 1);
    assert.ok(found.nodes[0]!.description.length <= 300 && found.nodes[0]!.description.endsWith('…'), `${found.nodes[0]!.description.length}`);
    assert.ok(found.edges[0]!.context.length <= 300, `${found.edges[0]!.context.length}`);
    const capped = json<Found>(await call('semantic_search', { query: Q, include_edges: true, max_description: 40 }));
    assert.ok(capped.nodes[0]!.description.length <= 40, capped.nodes[0]!.description);
    assert.equal(json<Found>(await call('semantic_search', { query: Q, max_description: 0 })).nodes[0]!.description, long, '0: whole');

    // why on an Enox edge: once — not once per book (the embedder's book is there too) — and
    // its axiom names its batch, the admission number and the claim.
    const lit = `edge(${JSON.stringify(ab.edge_id)}, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`;
    const why = json<{ identity: string; holds: boolean; text: string }[]>(await call('why', { literal: lit }));
    assert.deepEqual(why.map((e) => [e.identity, e.holds]), [['node-a', true]]);
    const chain = json<Chain>(await call('chain', { identity: 'node-a', limit: 1000 }));
    const seq = (await ask(a, `asserted(${JSON.stringify(ab.edge_id)}, P, C, S)`)).rows[0]!.cells[2] as number;
    assert.match(why[0]!.text, new RegExp(`\\[axiom\\] batch ${chain.digests[seq]} \\(admission \\d+, node-a's batch ${seq}, claimed_at [0-9T:.-]+Z\\), claimed_by "agent:test"$`));
    // whynot of a fact no book holds answers once too.
    const whynot = json<{ identity: string }[]>(await call('whynot', { literal: lit.replace('"uses"', '"usez"') }));
    assert.deepEqual(whynot.map((e) => e.identity), ['node-a']);
    // A question about the embedder's facts is answered from its book alone.
    const theirs = json<{ identity: string }[]>(await call('why', { literal: `edge(G, "n:x", "roflenox:embedding", "[0.1]")`.replace('G', JSON.stringify(factIdOf('n:x', 'roflenox:embedding', '[0.1]'))) }));
    assert.deepEqual(theirs.map((e) => e.identity), ['embedder.example.org']);
  } finally { await a.stop(); }
});

test('tools/list holds no tool described as not offered, and re-adding a deleted edge answers restored', async () => {
  const a = await start(tmpDir('tool-list'), 'node-a');
  try {
    const call = tools(a);
    const list = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const listed = ((await list.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
    assert.deepEqual(listed.filter((t) => /not offered/i.test(t.description)).map((t) => t.name), []);
    for (const n of ['create_share', 'revoke_share']) assert.ok(!listed.some((t) => t.name === n), n);
    assert.ok(listed.some((t) => t.name === 'list_shares') && listed.some((t) => t.name === 'retract_node'));
    // A client that calls one anyway is told what to do instead.
    const share = await call('create_share', { name: 'x', domains: ['cs'] });
    assert.equal(share.isError, true);
    assert.match(share.text, /roflenox:grant/);

    // Re-adding a deleted edge: restored, with its old ids — not created, not updated.
    type Added = { fact_id: string; edge_id: string; created: boolean; updated: boolean; restored?: boolean };
    const first = json<Added>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', proof_depth: 2 }));
    assert.deepEqual([first.created, first.updated, first.restored], [true, false, undefined]);
    const again = json<Added>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    assert.deepEqual([again.created, again.updated, again.restored], [false, true, undefined]);
    assert.equal((await call('delete_assertion', { fact_id: first.fact_id })).isError, false);
    const back = json<Added>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    assert.deepEqual([back.created, back.updated, back.restored, back.fact_id, back.edge_id], [false, false, true, first.fact_id, first.edge_id]);
    // It is an edge again, keeping its first created_at and proof_depth.
    const q = json<{ outgoing: { fact_id: string; created_at: string }[] }>(await call('query_graph', { node_id: json<{ id: string }[]>(await call('query_graph', { query: 'Alpha' }))[0]!.id }));
    assert.equal(q.outgoing.filter((e) => e.fact_id === first.fact_id).length, 1);
    assert.equal((await ask(a, `edge(G, ${JSON.stringify(first.edge_id)}, "enox:created_at", T)`)).rows.length, 1, 'created once');
    assert.deepEqual((await ask(a, `live(G, ${JSON.stringify(first.edge_id)}, "enox:proof_depth", T)`)).rows.map((r) => r.cells[1]), ['2']);
    // batch_assertions says the same.
    assert.equal((await call('delete_assertion', { fact_id: first.edge_id })).isError, false);
    const batch = json<{ results: Added[] }>(await call('batch_assertions', { assertions: [{ source: 'Alpha', target: 'Beta', relation: 'uses' }] }));
    assert.deepEqual([batch.results[0]!.created, batch.results[0]!.restored], [false, true]);
  } finally { await a.stop(); }
});

test('two asks at the same head answer the same rows while writes land between them, and an ask at a head older than the node keeps is refused naming the oldest it keeps', async () => {
  const a = await start(tmpDir('at-head'), 'node-a');
  try {
    const call = tools(a);
    const claim = (s: string, t: string, c = 1) => ({ source: s, relation: 'zz_claim', target: t, perspective: 'zz_coord', confidence: c });
    json(await call('assert', { facts: [claim('session-1', 'task-1'), claim('session-2', 'task-2')] }));
    const ab = json<{ source: string; edge_id: string }>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    json(await call('update_node', { node_id: ab.source, description: 'first' }));
    type At = Rows & { head: string };
    const first = (await post(a.url, '/ask', { query: 'live(F, S, "zz_claim", T)' })).body as unknown as At;
    assert.match(first.head, /^[0-9a-f]{64}$/);
    const head = first.head;
    const qs = ['live(F, S, "zz_claim", T)', 'edge(F, S, "zz_claim", T)', 'asserted(F, P, C, S)', 'conf(F, C)', 'persp(F, P)',
      `live(F, ${JSON.stringify(ab.source)}, "enox:description", T)`, 'edge(F, S, R, T)', 'edge(F, S, "zz_claim", T)'];
    const before = await Promise.all(qs.map(async (q, i) => (await post(a.url, '/ask', { query: q, at: head, ...(i === 7 ? { perspective: 'zz_coord' } : {}) })).body as unknown as At));
    // Writes land: a new claim, a retraction, a new value, a new fact, a new identity's book.
    json(await call('assert', { facts: [claim('session-3', 'task-3'), claim('session-1', 'task-1', 0)] }));
    json(await call('update_node', { node_id: ab.source, description: 'second' }));
    assert.equal((await call('delete_assertion', { fact_id: ab.edge_id })).isError, false);
    const other = identityAt(tmpDir('at-head-b'), 'node-b');
    await vouch(a, other);
    await publish(a.url, other, [claim('session-9', 'task-9')], () => a.clock.t);
    // At the head: exactly the rows of before.
    for (const [i, q] of qs.entries()) {
      const again = (await post(a.url, '/ask', { query: q, at: head, ...(i === 7 ? { perspective: 'zz_coord' } : {}) })).body as unknown as At;
      assert.deepEqual(again.rows, before[i]!.rows, q);
      assert.equal(again.head, head);
    }
    assert.deepEqual(before[0]!.rows.map((r) => r.cells[1]).sort(), ['session-1', 'session-2']);
    assert.deepEqual(before[5]!.rows.map((r) => r.cells[1]), ['first']);
    // … and now, the writes are there.
    const now = (await post(a.url, '/ask', { query: 'live(F, S, "zz_claim", T)' })).body as unknown as At;
    assert.deepEqual(now.rows.map((r) => [r.identity, r.cells[1]]).sort(), [['node-a', 'session-2'], ['node-a', 'session-3'], ['node-b', 'session-9']]);
    assert.notEqual(now.head, head);
    assert.deepEqual(((await post(a.url, '/ask', { query: `live(F, ${JSON.stringify(ab.source)}, "enox:description", T)` })).body as unknown as At).rows.map((r) => r.cells[1]), ['second']);
    // A derived predicate is answered only at the latest head; an unknown head is refused.
    assert.equal((await post(a.url, '/ask', { query: 'grant(R, U)', at: head })).status, 400);
    assert.equal((await post(a.url, '/ask', { query: 'grant(R, U)', at: now.head })).status, 200);
    assert.equal((await post(a.url, '/ask', { query: 'conf(F, C)', at: 'ab'.repeat(32) })).status, 404);
    // Paging at a head survives writes landing between the pages.
    const p1 = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)', at: head, limit: 3 })).body as unknown as At & { cursor: string };
    json(await call('assert', { facts: [claim('session-4', 'task-4')] }));
    const p2 = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)', at: head, limit: 1000, cursor: p1.cursor }));
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.deepEqual([...p1.rows, ...(p2.body as unknown as At).rows], before[6]!.rows);
  } finally { await a.stop(); }

  // A node that keeps the history of its last 5 admitted facts: a head older
  // than that is refused, naming the oldest head it keeps.
  const k = await start(tmpDir('at-old'), 'node-k', { recentFacts: 5 });
  try {
    const call = tools(k);
    const facts = (n: number) => Array.from({ length: 3 }, (_, i) => ({ source: `s${n}-${i}`, relation: 'zz_bulk', target: 't', perspective: 'zz', confidence: 1 }));
    const headNow = async () => ((await post(k.url, '/ask', { query: 'conf(F, C)', limit: 1 })).body as unknown as { head: string }).head;
    const h0 = await headNow();
    json(await call('assert', { facts: facts(1) }));
    const h1 = await headNow();
    json(await call('assert', { facts: facts(2) }));
    const h2 = await headNow();
    json(await call('assert', { facts: facts(3) }));
    for (const h of [h0, h1]) {
      const old = await post(k.url, '/ask', { query: 'conf(F, C)', at: h });
      assert.equal(old.status, 410);
      assert.equal(old.body.error, 'head_gone');
      assert.equal(old.body.oldest, h2, 'the oldest head it keeps');
      assert.match(String(old.body.message), new RegExp(`oldest head it answers at is ${h2}$`));
    }
    assert.equal(((await post(k.url, '/ask', { query: 'edge(F, S, "zz_bulk", T)', at: h2 })).body as unknown as Rows).rows.length, 6);
    // After a restart the window is the same: replay remembers the same batches.
    await k.node.close();
    const { RoflenoxNode } = await import('../src/node.ts');
    const n = await RoflenoxNode.open({ dataDir: k.dir, now: () => k.clock.t, recentFacts: 5 });
    try {
      assert.equal((await n.ask('edge(F, S, "zz_bulk", T)', 'node-k', null, { at: h2 })).rows.length, 6);
      await assert.rejects(n.ask('conf(F, C)', 'node-k', null, { at: h1 }), /oldest head it answers at/);
    } finally { await n.close(); }
  } finally { await k.stop().catch(() => {}); }
});


test('ask ordered by admission lists rows in the order their batches were admitted, the same after a restart', async () => {
  const dir = tmpDir('admission');
  const a = await start(dir, 'node-a');
  try {
    const call = tools(a);
    const claim = (s: string, c = 1) => ({ source: s, relation: 'zz_claim', target: 'task', perspective: 'zz_coord', confidence: c });
    // Batches admitted in an order that is not the rows' sorted order.
    for (const s of ['session-c', 'session-a', 'session-d', 'session-b']) json(await call('assert', { facts: [claim(s)] }));
    json(await call('assert', { facts: [claim('session-c', 0.5)] }));          // re-asserted: its assertion is now the latest
    const reader = identityAt(tmpDir('admission-r'), 'reader');
    await vouch(a, reader);
    await publish(a.url, a.me, [grant('reader', iso(T0 + DAY))], () => a.clock.t);
    type Ord = { rows: { identity: string; cells: (string | number)[]; admission?: number | null }[] };
    const ordered = async (url: string, query: string) => (await post(url, '/ask', { query, order: 'admission' })).body as unknown as Ord;
    const edge = await ordered(a.url, 'edge(F, S, "zz_claim", T)');
    assert.deepEqual(edge.rows.map((r) => r.cells[1]), ['session-c', 'session-a', 'session-d', 'session-b'], 'edge: by the batch that first asserted it');
    const adm = edge.rows.map((r) => r.admission!);
    assert.ok(adm.every((x, i) => typeof x === 'number' && (i === 0 || x > adm[i - 1]!)), JSON.stringify(adm));
    const live = await ordered(a.url, 'live(F, S, "zz_claim", T)');
    assert.deepEqual(live.rows.map((r) => r.cells[1]), ['session-a', 'session-d', 'session-b', 'session-c'], 'live: by the batch of its current assertion');
    const claims = (await ordered(a.url, 'asserted(F, "zz_coord", C, S)')).rows;
    assert.deepEqual(claims.map((r) => r.cells[1]), [1000, 1000, 1000, 500]);
    const grants = await ordered(a.url, 'grant(R, U)');
    assert.equal(grants.rows.length, 1);
    assert.ok(grants.rows[0]!.admission! > claims.at(-1)!.admission!, 'a grant: the batch of the grant in force');
    // Without order: no admission numbers.
    const plain = (await post(a.url, '/ask', { query: 'edge(F, S, "zz_claim", T)' })).body as unknown as Ord;
    assert.ok(plain.rows.every((r) => r.admission === undefined));
    assert.deepEqual(new Set(plain.rows.map((r) => r.cells[1])), new Set(edge.rows.map((r) => r.cells[1])));
    // The same after a restart.
    const QS = ['edge(F, S, "zz_claim", T)', 'asserted(F, P, C, S)', 'grant(R, U)', 'live(F, S, R, T)'];
    const before = await Promise.all(QS.map((q) => ordered(a.url, q)));
    await a.stop();
    const b = await start(dir, 'node-a');
    try {
      const after = await Promise.all(QS.map((q) => ordered(b.url, q)));
      assert.deepEqual(after.map((x) => x.rows), before.map((x) => x.rows));
    } finally { await b.stop(); }
  } finally { await a.stop().catch(() => {}); }
});
