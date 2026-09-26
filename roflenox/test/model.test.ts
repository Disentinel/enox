// The data model: perspectives and the current confidence of an assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { exportRule, fact, identityAt, post, start, tmpDir } from './helpers.ts';

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
