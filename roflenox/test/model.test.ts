// The data model: perspectives and the current confidence of an assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { bookOf, LocalIdentity } from '../src/identity.ts';
import { batch, DAY, exportRule, fact, get, identityAt, iso, post, start, T0, tmpDir, vouch } from './helpers.ts';

test('a question restricted to one perspective sees only the facts asserted under it', async () => {
  const a = await start(tmpDir('persp'), 'node-a');
  try {
    const now = () => a.clock.t;
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob', 0.9, 'work'), fact('alice', 'knows', 'carol', 0.8, 'home'),
      fact('alice', 'owns', 'x', 0.5, 'work'), exportRule('knows', 'public')], now);
    // A re-assertion moves a fact to another perspective.
    await publish(a.url, a.me, [fact('alice', 'owns', 'x', 0.6, 'home')], now);
    const ask = async (p: string, as?: null) => ((await post(a.url, '/ask', { query: 'edge(F, S, R, T)', perspective: p }, as === null ? { as: null } : {})).body);
    const work = await ask('work');
    assert.deepEqual(work.vars, ['F', 'S', 'R', 'T']);
    assert.deepEqual((work.rows as { cells: string[] }[]).map((r) => r.cells.slice(1)), [['alice', 'knows', 'bob']]);
    const home = (await ask('home')).rows as { cells: string[] }[];
    assert.deepEqual(home.map((r) => r.cells.slice(1)).sort(), [['alice', 'knows', 'carol'], ['alice', 'owns', 'x']]);
    // Control: without the restriction all three facts answer (plus the policy fact).
    const all = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { cells: string[] }[];
    assert.equal(all.filter((r) => r.cells[2] !== 'roflenox:export').length, 3);
    // The restriction keeps the reader's scope: an unsigned reader sees only exported facts.
    assert.deepEqual(((await ask('home', null)).rows as { cells: string[] }[]).map((r) => r.cells.slice(1)), [['alice', 'knows', 'carol']]);
    // Constants work in the restricted form too.
    const bound = (await post(a.url, '/ask', { query: 'edge(F, "alice", "owns", T)', perspective: 'home' })).body;
    assert.deepEqual(bound.vars, ['F', 'T']);
    assert.equal((bound.rows as unknown[]).length, 1);
  } finally { await a.stop(); }
});

test('re-asserting a fact with a new confidence leaves exactly one confidence for that identity, the latest', async () => {
  const a = await start(tmpDir('conf'), 'node-a');
  const b = identityAt(tmpDir('conf-b'), 'node-b');
  try {
    const now = () => a.clock.t;
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob', 0.3)], now);
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob', 0.9)], now);
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob', 0.7)], now);
    const conf = async () => ((await post(a.url, '/ask', { query: 'conf(F, C)' })).body.rows as { identity: string; cells: (string | number)[] }[])
      .map((r) => [r.identity, r.cells[1]]);
    assert.deepEqual(await conf(), [['node-a', 700]]);
    // Another identity's assertion of the same fact is its own, and does not replace node-a's.
    await vouch(a, b);
    await publish(a.url, b, [fact('alice', 'knows', 'bob', 0.2)], now);
    assert.deepEqual(await conf(), [['node-a', 700], ['node-b', 200]]);
    // The engine holds only the CURRENT assertion of each (identity, fact).
    assert.equal(((await post(a.url, '/ask', { query: 'asserted(F, P, C, S)' })).body.rows as unknown[]).length, 2);
    // The fact itself is one edge per identity, however often it was asserted.
    assert.equal(((await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as unknown[]).length, 2);
    // And the answer survives a rebuild from the log.
    await a.stop();
    const again = await start(a.dir, 'node-a');
    try {
      assert.deepEqual(((await post(again.url, '/ask', { query: 'conf(F, C)' })).body.rows as { identity: string; cells: number[] }[])
        .map((r) => [r.identity, r.cells[1]]), [['node-a', 700], ['node-b', 200]]);
    } finally { await again.stop(); }
  } catch (e) { await a.stop().catch(() => {}); throw e; }
});

test('each control fact retired at confidence 0 stops acting: a retired grant reads nothing, a retired delegation vouches for nobody and stops its agent, a retired rule derives nothing, a retired export publishes nothing', async () => {
  const dir = tmpDir('retire-a');
  let a = await start(dir, 'node-a');
  const bob = identityAt(tmpDir('retire-bob'), 'bob');
  const alice = identityAt(tmpDir('retire-alice'), 'alice');
  const bot = LocalIdentity.create(tmpDir('retire-bot'), 'bot.alice', new Date(T0 - DAY), { delegatedBy: 'alice' });
  const bot2 = LocalIdentity.create(tmpDir('retire-bot2'), 'bot2.alice', new Date(T0 - DAY), { delegatedBy: 'alice' });
  const ctl = (source: string, relation: string, target: string, confidence = 1) => ({ source, relation, target, perspective: 'policy', confidence });
  const until = iso(T0 + DAY);
  const control = {
    grant: ctl('bob', 'roflenox:grant', until),
    rule: ctl('knowers', 'roflenox:rule', 'knower(X) :- edge(F, X, "knows", T).'),
    publish: ctl('knows', 'roflenox:export', 'public'),
  };
  const rows = async (query: string, as?: LocalIdentity | null) => {
    const r = await post(a.url, '/ask', { query }, as === undefined ? {} : { as });
    return r.status === 200 ? (r.body.rows as unknown[]).length : 0;
  };
  const anonymousFeed = async () => (((await get(a.url, '/feeds/node-a', { as: null })).body.batches ?? []) as { jsonl?: string }[]).filter((x) => x.jsonl !== undefined).length;
  try {
    await vouch(a, bob, alice);
    await publish(a.url, a.me, [fact('ada', 'knows', 'grace'), ...Object.values(control)], () => a.clock.t);
    await publish(a.url, alice, [ctl('bot.alice', 'roflenox:delegate', until), ctl('bot2.alice', 'roflenox:delegate', until)], () => a.clock.t);
    const b1 = batch(bot, [fact('bot', 'saw', '1')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1, { as: null })).status, 201, 'control: the delegation vouches for its agent');
    // Every control fact acts.
    assert.equal(await rows(`edge[${bookOf('node-a')}](F, S, R, T)`, bob), 4, 'the grant: bob reads the book');
    assert.equal(await rows('knower(X)'), 1, 'the rule derives');
    assert.equal(await rows('edge(F, S, "knows", T)', null), 1, 'the export publishes');

    // Retired, each one: the same fact, re-asserted at confidence 0.
    await publish(a.url, a.me, Object.values(control).map((c) => ({ ...c, confidence: 0 })), () => a.clock.t);
    await publish(a.url, alice, [ctl('bot.alice', 'roflenox:delegate', until, 0), ctl('bot2.alice', 'roflenox:delegate', until, 0)], () => a.clock.t);
    // ...and stays retired when the node is rebuilt from its log.
    for (const when of ['live', 'after a restart']) {
      if (when !== 'live') { await a.stop(); a = await start(dir, 'node-a'); }
      assert.equal(await rows(`edge[${bookOf('node-a')}](F, S, R, T)`, bob), 0, `${when}: a retired grant reads nothing`);
      assert.equal(await rows('edge(F, S, R, T)', bob), 0);
      assert.equal(await rows('knower(X)'), 0, `${when}: a retired rule derives nothing`);
      assert.equal(await rows('edge(F, S, "knows", T)', null), 0, `${when}: a retired export publishes nothing`);
      assert.equal(await anonymousFeed(), 0, `${when}: nor does any batch leave in the feed`);
    }
    const next = await post(a.url, '/batches', batch(bot, [fact('bot', 'saw', '2')], b1.manifest.digest, iso(a.clock.t)), { as: null });
    assert.equal(next.body.error, 'not_delegated', 'a retired delegation stops its agent');
    const first = await post(a.url, '/batches', batch(bot2, [fact('bot2', 'saw', '1')], null, iso(a.clock.t)), { as: null });
    assert.equal(first.body.error, 'not_vouched', 'and vouches for nobody');
  } finally { await a.stop(); }
});
