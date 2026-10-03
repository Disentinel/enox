// The Enox tools answer like the Enox they replace (r_compat_parity): defects
// found side by side with the base Enox on the same data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnExecutor } from '../src/executor.ts';
import { publish } from '../src/client.ts';
import { bookOf } from '../src/identity.ts';
import type { Fact } from '../src/facts.ts';
import { answerSearches, BATCH, MAX_CHARS, PAD_BUDGET } from '../executors/embedder/embedder.ts';
import { HASH, type Model } from '../executors/embedder/embed.ts';
import { DAY, get, grant, identityAt, iso, post, start, tmpDir, type Clock, type Running } from './helpers.ts';

const EMBEDDER = path.join(import.meta.dirname, '..', 'executors', 'embedder', 'embedder.ts');
const wall = () => ({ get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } }) as Clock;
const E = (id: string) => `enox://example.org/graph/main/example/${id}`;
const f = (source: string, relation: string, target: string, confidence = 1): Fact => ({ source, relation, target, perspective: 'enox', confidence });
const entity = (id: string, label: string, description: string, domain = 'example', updated?: string) =>
  [f(E(id), 'enox:label', label), f(E(id), 'enox:description', description), f(E(id), 'enox:type', 'person'), f(E(id), 'enox:domain', domain),
    ...(updated ? [f(E(id), 'enox:updated_at', updated)] : [])];
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** An MCP tools/call as the operator (or anyone, with auth ''). */
function mcp(a: Running) {
  const token = a.node.operatorToken();
  let id = 0;
  return async (name: string, args: unknown, auth = token) => {
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (j.error) return { text: j.error.message, isError: true };            // refused by the schema
    return { text: j.result!.content[0]!.text, isError: j.result!.isError === true };
  };
}

/** Name an embedder for node `a`'s operator, and grant it the book. */
async function embedderFor(a: Running, name = 'embedder'): Promise<string> {
  const dir = tmpDir(`compat-${name}`);
  const ex = identityAt(dir, name);
  assert.equal((await post(a.url, '/identities', ex.identityChain())).status, 200);
  await publish(a.url, a.me, [f(name, 'roflenox:embedder', 'search'), grant(name, iso(Date.now() + DAY))]);
  return dir;
}

/** The embedder with its HASH model (no network, no model), once. */
async function runEmbedder(url: string, dataDir: string): Promise<void> {
  const child = spawnExecutor({ url, dataDir, script: EMBEDDER, cpuSeconds: 30, env: { ROFLENOX_ONCE: '1', ROFLENOX_EMBED_MODEL: 'hash' } });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  const { code } = await new Promise<{ code: number | null }>((r) => child.once('exit', (code) => r({ code })));
  assert.equal(code, 0, out);
}

test('recall finds an entity from a natural-language question that shares no word with its name', async () => {
  const a = await start(tmpDir('compat-recall'), 'node-a', { clock: wall() });
  const call = mcp(a);
  const recall = async (query: string) => JSON.parse((await call('recall', { query })).text) as { nodes: { name: string }[] };
  try {
    await publish(a.url, a.me, [
      ...entity('jane', 'Jane Doe', 'handles divorces and child custody'),
      ...entity('tom', 'Bob Baker', 'bakes sourdough bread every morning'),
      ...entity('tea', 'Earl Grey', 'black tea flavoured with bergamot oil'),
    ]);
    const Q = 'who handles divorces';
    assert.deepEqual([...words('Jane Doe')].filter((w) => words(Q).has(w)), [], 'the question shares no word with the name');
    // With no executor at all, recall is the name match (r_core_without_executors).
    assert.deepEqual((await recall('Jane')).nodes.map((n) => n.name), ['Jane Doe']);
    assert.deepEqual((await recall(Q)).nodes, [], 'names alone cannot find it');

    // With an embedder named, recall asks it by meaning, as semantic_search does…
    const ex = await embedderFor(a);
    assert.deepEqual((await recall(Q)).nodes, [], 'not answered yet: recall never guesses');
    await runEmbedder(a.url, ex);
    // …and once it has answered, the entity is found by its meaning.
    const r = await recall(Q);
    assert.equal(r.nodes[0]?.name, 'Jane Doe', JSON.stringify(r.nodes));
    assert.ok(!r.nodes.some((n) => n.name === 'Earl Grey'), 'an unrelated entity is not recalled');
  } finally { await a.stop(); }
});

test('semantic_search results carry age_days and stale like the base', async () => {
  const a = await start(tmpDir('compat-stale'), 'node-a', { clock: wall() });
  const call = mcp(a);
  const now = Date.now();
  const ago = (d: number) => iso(now - d * DAY);
  try {
    await publish(a.url, a.me, [
      ...entity('old-ml', 'Old model', 'a neural network language model', 'ml', ago(100.2)),          // ml: stale after 90 days
      ...entity('new-ml', 'New model', 'a neural network language model too', 'ml', ago(10.2)),
      ...entity('old-cs', 'Old paper', 'a neural network paper', 'cs.SE', ago(300.2)),               // no TTL of its own: 365
      ...entity('older-cs', 'Older paper', 'a neural network paper again', 'cs.SE', ago(400.2)),
    ]);
    const ex = await embedderFor(a);
    const search = async () => JSON.parse((await call('semantic_search', { query: 'neural network', top_k: 10 })).text) as {
      index: string; nodes: { name: string; domain: string; updated_at: string; age_days: number; stale: boolean }[] };
    assert.equal((await search()).index, 'pending');
    await runEmbedder(a.url, ex);
    const r = await search();
    assert.equal(r.index, 'embedder:embedder');
    const got = Object.fromEntries(r.nodes.map((n) => [n.name, [n.age_days, n.stale]]));
    assert.deepEqual(got, { 'Old model': [100, true], 'New model': [10, false], 'Old paper': [300, false], 'Older paper': [400, true] });
  } finally { await a.stop(); }
});

test('a fractional proof_depth is refused', async () => {
  const a = await start(tmpDir('compat-depth'), 'node-a', { clock: wall() });
  const call = mcp(a);
  const batches = async () => ((await get(a.url, '/health', { as: a.me, now: Date.now() })).body as { batches: number }).batches;
  try {
    const ok = await call('add_assertion', { source: 'Ada', target: 'Engine', relation: 'designs', proof_depth: 2 });
    assert.equal(ok.isError, false, ok.text);
    const { fact_id } = JSON.parse(ok.text) as { fact_id: string };
    const before = await batches();
    const add = await call('add_assertion', { source: 'Ada', target: 'Mill', relation: 'designs', proof_depth: 1.5 });
    assert.equal(add.isError, true, add.text);
    assert.match(add.text, /proof_depth is an integer/);
    const upd = await call('update_assertion', { fact_id, proof_depth: 0.5 });
    assert.equal(upd.isError, true, upd.text);
    assert.match(upd.text, /proof_depth is an integer/);
    const bat = JSON.parse((await call('batch_assertions', { assertions: [{ source: 'Ada', target: 'Store', relation: 'designs', proof_depth: 2.5 }] })).text) as {
      succeeded: number; failed: number; results: { error?: string }[] };
    assert.deepEqual([bat.succeeded, bat.failed], [0, 1]);
    assert.match(bat.results[0]!.error!, /proof_depth is an integer/);
    assert.equal(await batches(), before, 'nothing was written');
    // An integer one is taken, and reads back as written.
    const up = await call('update_assertion', { fact_id, proof_depth: 3 });
    assert.equal(up.isError, false, up.text);
    assert.equal((JSON.parse(up.text) as { proof_depth: number }).proof_depth, 3);
  } finally { await a.stop(); }
});

test('the embedder embeds a book of mixed text lengths in bounded memory and finishes although writes land during its read', async () => {
  const a = await start(tmpDir('compat-embed'), 'node-a', { clock: wall() });
  const call = mcp(a);
  try {
    // 300 short entities and 3 long ones: in one call a model pads every
    // text to the longest — 303 × 6000 characters.
    const long = (k: number) => `${'a very long description of a steam engine part '.repeat(125)}${k}`;
    const facts: Fact[] = [];
    for (let i = 0; i < 300; i++) facts.push(...entity(`e${i}`, `Entity ${i}`, `short note ${i}`));
    for (let k = 0; k < 3; k++) facts.push(...entity(`long${k}`, `Long ${k}`, long(k)));
    for (let i = 0; i < facts.length; i += 400) await publish(a.url, a.me, facts.slice(i, i + 400));
    const exDir = await embedderFor(a);
    assert.equal((await call('semantic_search', { query: 'steam engine part' })).isError, false);

    // The model the embedder runs: the hash one, measuring each call as a
    // padding model would allocate it (texts × longest text).
    const calls: { n: number; longest: number }[] = [];
    const measured: Model = { id: HASH.id, embed: async (texts, role) => {
      calls.push({ n: texts.length, longest: Math.max(...texts.map((t) => t.length)) });
      return HASH.embed(texts, role);
    } };
    // Writes land while it reads the book, batch by batch.
    let landed = 0;
    const onPage = async (page: number) => {
      if (page > 3) return;
      await publish(a.url, a.me, [...entity(`during${page}`, `Written during page ${page}`, 'arrived mid-read')]);
      landed++;
    };
    const { LocalIdentity } = await import('../src/identity.ts');
    const me = LocalIdentity.load(exDir)!;
    const answered = await answerSearches(a.url, me, measured, () => {}, { feedPage: 1, onPage });
    assert.equal(answered, 1, 'it finished');
    assert.ok(landed >= 2, `writes landed during the read (${landed})`);

    const passages = calls.slice(0, -1);                         // the last call embeds the query
    assert.equal(passages.reduce((s, c) => s + c.n, 0) > 303, true, 'every entity and assertion was embedded');
    for (const c of passages) {
      assert.ok(c.n <= BATCH, `${c.n} texts in one call`);
      assert.ok(c.longest <= MAX_CHARS, `a ${c.longest}-character text`);
      assert.ok(c.n === 1 || c.n * c.longest <= PAD_BUDGET, `one call padded to ${c.n} × ${c.longest} characters`);
    }
    const r = JSON.parse((await call('semantic_search', { query: 'steam engine part' })).text) as { index: string; nodes: { name: string }[] };
    assert.equal(r.index, 'embedder:embedder');
    assert.match(r.nodes[0]?.name ?? '', /^Long \d$/, JSON.stringify(r.nodes.slice(0, 3)));
  } finally { await a.stop(); }
});

test('why agrees with ask for every literal ask returns, including conf', async () => {
  const a = await start(tmpDir('compat-why'), 'node-a', { clock: wall() });
  try {
    const kn = (s: string, t: string, c: number, p = 'social'): Fact => ({ source: s, relation: 'knows', target: t, perspective: p, confidence: c });
    await publish(a.url, a.me, [kn('ada', 'bob', 0.9), kn('bob', 'carol', 0.5, 'work'), kn('carol', 'dan', 1),
      { source: 'knowers', relation: 'roflenox:rule', target: 'knower(X) :- edge(F, X, "knows", T).', perspective: 'rules', confidence: 1 }]);
    // Superseded and retired assertions: the current one is what both answer.
    await publish(a.url, a.me, [kn('ada', 'bob', 0.7, 'work'), kn('carol', 'dan', 0)]);
    const book = bookOf(a.me.name);
    const term = (c: string | number) => (typeof c === 'number' ? String(c) : JSON.stringify(c));
    let checked = 0;
    for (const [rel, args] of [['edge', 'F, S, R, T'], ['conf', 'F, C'], ['persp', 'F, P'], ['asserted', 'F, P, C, S'], ['knower', 'X']] as const) {
      const rows = (await a.node.ask(`${rel}(${args})`, a.me.name)).rows;
      assert.ok(rows.length > 0, `${rel} answers rows`);
      for (const r of rows) {
        const lit = `${rel}[${bookOf(r.identity)}](${r.cells.map(term).join(', ')})`;
        const why = await a.node.why(lit, a.me.name);
        assert.deepEqual(why.map((e) => e.holds), [true], `why ${lit}: ${JSON.stringify(why)}`);
        checked++;
      }
    }
    assert.ok(checked >= 16, `${checked} literals`);
    // And a value ask does not return, why does not hold — naming the current one.
    for (const r of (await a.node.ask('conf(F, C)', a.me.name)).rows) {
      const [F, C] = r.cells as [string, number];
      const w = await a.node.why(`conf[${book}](${JSON.stringify(F)}, ${C + 1})`, a.me.name);
      assert.deepEqual(w.map((e) => e.holds), [false]);
      assert.match(w[0]!.text, new RegExp(`,${C},\\d+\\)$`), w[0]!.text);
      const wn = await a.node.whynot(`conf[${book}](${JSON.stringify(F)}, ${C + 1})`, a.me.name);
      assert.deepEqual(wn.map((e) => e.holds), [false]);
    }
  } finally { await a.stop(); }
});
