// Search by meaning (r_semantic_search, r_derived_rebuildable): an executor
// embeds facts into its own book and answers search intents there. The node
// embeds nothing; an answer is in the log, so it stays when the embedder is
// gone, and derived data is rebuilt from primary facts alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnExecutor } from '../src/executor.ts';
import { publish } from '../src/client.ts';
import type { Fact } from '../src/facts.ts';
import { DAY, get, grant, identityAt, iso, post, serveAsIs, start, tmpDir, type Clock } from './helpers.ts';

const EMBEDDER = path.join(import.meta.dirname, '..', 'executors', 'embedder', 'embedder.ts');
const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;

const E = (id: string) => `enox://example.org/graph/main/example/${id}`;
const f = (source: string, relation: string, target: string): Fact => ({ source, relation, target, perspective: 'enox', confidence: 1 });
const entity = (id: string, label: string, description: string) =>
  [f(E(id), 'enox:label', label), f(E(id), 'enox:description', description), f(E(id), 'enox:type', 'artifact'), f(E(id), 'enox:domain', 'example')];

/** The embedder with its HASH model: this suite needs neither the network
 *  nor a model (test/hermetic.test.ts). The learned model's own check —
 *  "a meaning search finds a fact that shares none of the query's words" —
 *  is in executors/embedder/test. */
async function runEmbedder(url: string, dataDir: string): Promise<string> {
  const child = spawnExecutor({ url, dataDir, script: EMBEDDER, cpuSeconds: 30, env: { ROFLENOX_ONCE: '1', ROFLENOX_EMBED_MODEL: 'hash' } });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  const { code } = await new Promise<{ code: number | null }>((r) => child.once('exit', (code) => r({ code })));
  assert.equal(code, 0, out);
  return out;
}

test('a meaning search returns a fact after the embedder answers its intent, and the core answers the same with the embedder absent', async () => {
  const dir = tmpDir('search-a');
  let a = await start(dir, 'node-a', { clock: wall });
  const token = a.node.operatorToken();
  let id = 0;
  const search = async (url: string, query: string, auth: string | null = token) => {
    const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'semantic_search', arguments: { query, include_edges: true } } }) });
    const j = await r.json() as { result: { content: { text: string }[]; isError?: boolean } };
    assert.notEqual(j.result.isError, true, j.result.content[0]!.text);
    return JSON.parse(j.result.content[0]!.text) as { index: string; message: string; nodes: { name: string; similarity: number }[];
      edges: { source_name: string; relation: string; target_name: string; similarity: number }[] };
  };
  const batches = async () => ((await (await fetch(`${a.url}/health`)).json()) as { batches: number }).batches;
  const Q = 'a machine that tabulates polynomial tables';
  try {
    await publish(a.url, a.me, [
      ...entity('difference-engine', 'Difference Engine', 'a mechanical calculator that tabulates polynomial functions'),
      ...entity('loom', 'Jacquard loom', 'a weaving machine controlled by punched cards'),
      ...entity('earl-grey', 'Earl Grey', 'black tea flavoured with bergamot oil'),
      ...entity('ada', 'Ada Lovelace', 'wrote the first published program'),
      f(E('ada'), 'wrote_about', E('difference-engine')),
      f(E('loom'), 'inspired', E('ada')),
    ]);

    // No embedder named: the node says so, and never guesses.
    const none = await search(a.url, Q);
    assert.equal(none.index, 'absent');
    assert.deepEqual([none.nodes, none.edges], [[], []]);

    const exDir = tmpDir('search-e');
    const ex = identityAt(exDir, 'embedder');
    assert.equal((await post(a.url, '/identities', ex.identityChain())).status, 200);
    await publish(a.url, a.me, [f('embedder', 'roflenox:embedder', 'search'), grant('embedder', iso(Date.now() + DAY))]);

    // A read by anyone but the operator never writes: nothing is asked.
    const before = await batches();
    assert.equal((await search(a.url, Q, null)).index, 'pending');
    assert.equal(await batches(), before, 'an anonymous search wrote nothing');
    // The operator's search is a fact, and a rule makes it the embedder's intent.
    const asked = await search(a.url, Q);
    assert.equal(asked.index, 'pending');
    assert.match(asked.message, /asked embedder/);
    assert.equal(await batches(), before + 1);
    const intents = (await post(a.url, '/ask', { query: 'intent(K, "embedder", "search", Q)' })).body.rows as { cells: string[] }[];
    assert.deepEqual(intents.map((r) => r.cells[1]), [Q]);

    // The embedder answers its intent — in its own book.
    const out = await runEmbedder(a.url, exDir);
    assert.match(out, /answered 1 searches; index: 0 from the log, \d+ embedded now/);
    const answered = await search(a.url, Q);
    assert.equal(answered.index, 'embedder:embedder');
    assert.equal(answered.nodes[0]?.name, 'Difference Engine', JSON.stringify(answered.nodes));
    const fact = answered.edges.find((e) => e.target_name === 'Difference Engine');
    assert.ok(fact, `a fact is returned: ${JSON.stringify(answered.edges)}`);
    assert.deepEqual([fact.source_name, fact.relation], ['Ada Lovelace', 'wrote_about']);
    const embeddings = (await post(a.url, '/ask', { query: 'edge(F, K, "roflenox:embedding", V)' })).body.rows as { identity: string }[];
    assert.ok(embeddings.length > 0 && embeddings.every((r) => r.identity === 'embedder'), 'embeddings live in the embedder\'s book');
    // The caller reads only what it may: an anonymous caller gets the same
    // answer through its own view, which holds none of node-a's book.
    const anon = await search(a.url, Q, null);
    assert.equal(anon.index, 'embedder:embedder');
    assert.deepEqual([anon.nodes, anon.edges], [[], []]);

    // The embedder is gone (its process has exited): the core answers the
    // same — and the same again after it rebuilds everything from its log.
    const strip = (r: typeof answered) => ({ nodes: r.nodes, edges: r.edges });
    assert.deepEqual(strip(await search(a.url, Q)), strip(answered));
    await a.stop();
    a = { ...(await serveAsIs(dir, wall)), me: a.me };
    assert.deepEqual(strip(await search(a.url, Q)), strip(answered), 'the same answer from a node rebuilt from its log');

    // A lost index is rebuilt from the log: a fresh process embeds nothing twice.
    assert.equal((await search(a.url, 'bergamot tea')).index, 'pending');
    assert.match(await runEmbedder(a.url, exDir), /answered 1 searches; index: [1-9]\d* from the log, 0 embedded now/);
    assert.equal((await search(a.url, 'bergamot tea')).nodes[0]?.name, 'Earl Grey');

    // Losing the derived data entirely loses no knowledge: a fresh embedder
    // with an empty book rebuilds it from the primary facts alone, to the
    // same answer.
    const ex2Dir = tmpDir('search-e2');
    const ex2 = identityAt(ex2Dir, 'embedder-two');
    assert.equal((await post(a.url, '/identities', ex2.identityChain(), { as: a.me, now: wall.t })).status, 200);   // the operator introduces it
    await publish(a.url, a.me, [{ ...f('embedder', 'roflenox:embedder', 'search'), confidence: 0 },
      f('embedder-two', 'roflenox:embedder', 'search'), grant('embedder-two', iso(Date.now() + DAY))]);
    assert.equal((await search(a.url, Q)).index, 'pending', 'the answer is the named embedder\'s');
    // (Both searches asked so far are now its intents.)
    assert.match(await runEmbedder(a.url, ex2Dir), /answered 2 searches; index: 0 from the log, [1-9]\d* embedded now/);
    const rebuilt = await search(a.url, Q);
    assert.equal(rebuilt.index, 'embedder:embedder-two');
    assert.deepEqual(strip(rebuilt), strip(answered));
  } finally { await a.stop(); }
});

test('a search the operator asks is never published by a wildcard export', async () => {
  const a = await start(tmpDir('search-leak'), 'alice', { clock: wall });
  try {
    const token = a.node.operatorToken();
    const Q = 'divorce lawyer near me';
    // alice publishes everything ("*" to "public") and names an embedder.
    await publish(a.url, a.me, [
      { source: '*', relation: 'roflenox:export', target: 'public', perspective: 'policy', confidence: 1 },
      f('embedder', 'roflenox:embedder', 'search'),
      { source: 'bob', relation: 'roflenox:rule', target: 'likes2(X) :- edge(F, X, "likes", T).', perspective: 'rules', confidence: 1 },
      grant('embedder', iso(Date.now() + DAY)),
    ]);
    // (A batch leaves whole or not at all: the ordinary fact goes on its own.)
    await publish(a.url, a.me, [f('alice', 'likes', 'tea')]);
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { query: Q } } }) });
    assert.equal(JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text).index, 'pending');
    assert.equal((await post(a.url, '/ask', { query: 'edge(F, K, "roflenox:search", Q)' })).body.rows instanceof Array, true);
    assert.equal(((await post(a.url, '/ask', { query: 'edge(F, K, "roflenox:search", Q)' })).body.rows as unknown[]).length, 1, 'the search is a fact of alice\'s');

    // Nobody else sees it: not the public feed, not an anonymous ask.
    const feed = await get(a.url, '/feeds/alice', { as: null });
    assert.equal(feed.status, 200);
    const published = JSON.stringify(feed.body);
    assert.match(published, /likes/, 'the wildcard does publish ordinary facts');
    for (const secret of [Q, 'roflenox:search', 'roflenox:grant', 'roflenox:rule', 'roflenox:embedder']) {
      assert.ok(!published.includes(secret), `the public feed carries ${secret}`);
    }
    const anon = async (q: string) => (await post(a.url, '/ask', { query: q }, { as: null })).body.rows as unknown[];
    assert.equal((await anon('edge(F, S, "likes", T)')).length, 1, 'control: an anonymous reader sees exported facts');
    assert.deepEqual(await anon('edge(F, K, "roflenox:search", Q)'), []);
    assert.deepEqual(await anon('edge(F, S, "roflenox:grant", T)'), []);

    // The list of the node's relations is closed: another roflenox: relation,
    // which the wildcard exclusion might not know, is not admitted at all.
    await assert.rejects(publish(a.url, a.me, [f('alice', 'roflenox:private_note', 'x')]), /not one of the node's relations/);

    // Only an export that NAMES the relation publishes it.
    await publish(a.url, a.me, [{ source: 'roflenox:search', relation: 'roflenox:export', target: 'public', perspective: 'policy', confidence: 1 }]);
    assert.equal((await anon('edge(F, K, "roflenox:search", Q)')).length, 1);
  } finally { await a.stop(); }
});
