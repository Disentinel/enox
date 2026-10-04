// The owner's claude.ai retest of the deployed node, 2026-10-04: one name per
// edge, a live view, writes that answer what they wrote, a schema to learn the
// query language from, consistent errors and bounded reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { bookOf } from '../src/identity.ts';
import { factId } from '../src/facts.ts';
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
