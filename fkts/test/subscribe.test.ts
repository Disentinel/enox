// Subscriptions (r_subscribe): a literal's rows over server-sent events, the
// view page, and the journal of transitions — on the invariant toy
// (test/fixtures/invariants: a scanner's `shows`, rules stale/broken/
// accepted/red/intent). Needs a `rofl` engine with `watch` (ROFL_BIN).
//
// THE ORACLES (test/helpers.ts, oracle): after every batch, the rows a
// subscriber has accumulated from its frames equal a fresh `ask` of the same
// literal, as the same reader (the fan-out), and the answer of a node rebuilt
// from the log on a copy of the data directory (the kept worlds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import { bookOf, type LocalIdentity } from '../src/identity.ts';
import { signRequest } from '../src/httpsig.ts';
import type { Fact } from '../src/facts.ts';
import type { Frame } from '../src/subscribe.ts';
import { DAY, grant, identityAt, iso, post, start, oracle, subscribe, T0, tmpDir, vouch, type Running } from './helpers.ts';

const TOY = path.join(import.meta.dirname, 'fixtures/invariants');
const toy = (f: string): Fact[] => fs.readFileSync(path.join(TOY, `${f}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Fact);
const key = (r: { identity: string; cells: unknown[] }) => JSON.stringify([r.identity, r.cells]);

const asOperator = (n: Running) => ({ authorization: `Bearer ${n.node.operatorToken()}` });
const signedGet = (n: Running, who: LocalIdentity, p: string) => signRequest(who, 'GET', n.url + p, null, n.clock.t);
const subPath = (q: string) => `/subscribe?query=${encodeURIComponent(q)}`;

const pub = (n: Running, facts: Fact[]) => publish(n.url, n.me, facts, () => n.clock.t);

async function waitFor<T>(f: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v !== null) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a subscriber to red(P, X) is sent the whole answer, then +2 on the update and −1 on an acceptance; the journal says why', async () => {
  const n = await start(tmpDir('sub'), 'home.node');
  const me = n.me.name;
  try {
    await pub(n, [...toy('rules'), { source: 'reds', relation: 'fkts:journal', target: 'red(P, X)', perspective: 'journal', confidence: 1 }]);
    await pub(n, toy('scan'));
    const q = 'red(P, X)';
    const s = await subscribe(n.url, subPath(q), asOperator(n));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const f0 = await s.next();
    assert.equal(f0.kind, 'full');
    assert.deepEqual(f0.vars, ['P', 'X']);
    assert.deepEqual(f0.rows, []);
    await oracle(n, s, q);

    // A second literal with a constant sees only its rows.
    const only = await subscribe(n.url, subPath('red("settings", X)'), asOperator(n));
    assert.deepEqual((await only.next()).rows, []);

    await pub(n, toy('update'));
    const f1 = await s.next();
    assert.equal(f1.kind, 'delta', JSON.stringify(f1));
    assert.deepEqual(f1.added, [{ identity: me, cells: ['home', 'login@v1'] }, { identity: me, cells: ['settings', 'login@v1'] }]);
    assert.deepEqual(f1.removed, []);
    assert.equal(f1.by, 'delta', 'taken by the engine\'s delta, not a re-ask');
    const update = f1.cause!;
    assert.match(update, /^[0-9a-f]{64}$/, 'the batch that moved them');
    await oracle(n, s, q);
    const g1 = await only.next();
    assert.deepEqual(g1.added, [{ identity: me, cells: ['login@v1'] }], 'the constant filters');
    await oracle(n, only, 'red("settings", X)');

    await pub(n, toy('accept'));
    const f2 = await s.next();
    assert.deepEqual(f2.added, []);
    assert.deepEqual(f2.removed, [{ identity: me, cells: ['home', 'login@v1'] }]);
    await oracle(n, s, q);
    await only.quiet(150);
    // As a call (MCP, CLI, POST /op/subscribe): one frame, the whole answer.
    const call = await post(n.url, '/op/subscribe', { query: q });
    assert.equal(call.body.kind, 'full');
    assert.deepEqual((call.body.rows as unknown[]).map((r) => key(r as { identity: string; cells: unknown[] })), [...s.rows.keys()].sort());

    // One batch: a row comes (profile) and one goes (settings accepted).
    await pub(n, toy('scan2'));
    const f3 = await s.next();
    assert.deepEqual(f3.added, [{ identity: me, cells: ['profile', 'login@v1'] }]);
    assert.deepEqual(f3.removed, [{ identity: me, cells: ['settings', 'login@v1'] }]);
    await oracle(n, s, q);
    assert.deepEqual((await only.next()).removed, [{ identity: me, cells: ['login@v1'] }]);
    await oracle(n, only, 'red("settings", X)');

    // The journal: every transition, a signed fact of the node naming the batch that caused it.
    const appeared = await waitFor(async () => {
      const r = (await post(n.url, '/ask', { query: 'edge(F, S, "fkts:appeared", C)' })).body.rows as { cells: string[] }[];
      return r.length >= 3 ? r : null;
    });
    const vanished = await waitFor(async () => {
      const r = (await post(n.url, '/ask', { query: 'edge(F, S, "fkts:vanished", C)' })).body.rows as { cells: string[] }[];
      return r.length >= 2 ? r : null;
    });
    const b = bookOf(me);
    assert.deepEqual(appeared.map((r) => r.cells[1]).sort(), [`red[${b}]("home", "login@v1")`, `red[${b}]("profile", "login@v1")`, `red[${b}]("settings", "login@v1")`]);
    assert.deepEqual(vanished.map((r) => r.cells[1]).sort(), [`red[${b}]("home", "login@v1")`, `red[${b}]("settings", "login@v1")`]);
    const home = appeared.find((r) => r.cells[1] === `red[${b}]("home", "login@v1")`)!;
    assert.equal(home.cells[2], update);
    const why = (await post(n.url, '/op/why', { literal: `edge("${home.cells[0]}", ${JSON.stringify(home.cells[1])}, "fkts:appeared", "${update}")` })).body as unknown as { holds: boolean; text: string }[];
    const t = why.find((w) => w.holds)!.text;
    assert.ok(t.includes(`caused by batch ${update}`), t);
    s.close();
    only.close();
  } finally { await n.stop(); }
});

test('a subscriber sees only what it may read: no grant, nothing; a grant, the rows; the grant expired, nothing again', async () => {
  const n = await start(tmpDir('sub-acc'), 'home.node');
  const eve = identityAt(tmpDir('sub-eve'), 'eve');
  try {
    await vouch(n, eve);
    await pub(n, [...toy('rules'), ...toy('scan')]);
    const own = `red[${bookOf(n.me.name)}](P, X)`;
    const refused = await subscribe(n.url, subPath(own), signedGet(n, eve, subPath(own)));
    assert.equal(refused.status, 403);
    assert.equal(refused.body!.error, 'no_grant');
    const anon = await subscribe(n.url, subPath(own), {});
    assert.equal(anon.status, 404, 'an anonymous reader is told nothing of the book');

    const s = await subscribe(n.url, subPath('red(P, X)'), signedGet(n, eve, subPath('red(P, X)')));
    assert.equal(s.status, 200);
    assert.deepEqual((await s.next()).rows, []);
    // A base relation is watched in every book at once: only the fan-out keeps eve from the owner's.
    const sup = 'edge(F, S, "supersedes", T)';
    const e = await subscribe(n.url, subPath(sup), signedGet(n, eve, subPath(sup)));
    assert.deepEqual((await e.next()).rows, []);
    const owner = await subscribe(n.url, subPath('red(P, X)'), asOperator(n));
    await owner.next();
    await pub(n, toy('update'));
    assert.equal((await owner.next()).added!.length, 2);
    await s.quiet(200);
    await e.quiet(0);
    await oracle(n, s, 'red(P, X)', eve);
    await oracle(n, e, sup, eve);

    await pub(n, [grant('eve', iso(T0 + DAY))]);
    const g = await s.next();
    assert.equal(g.kind, 'full', 'access moved: the answer whole');
    assert.equal(g.rows!.length, 2);
    await oracle(n, s, 'red(P, X)', eve);
    assert.equal((await e.next()).rows!.length, 1);
    await oracle(n, e, sup, eve);

    n.clock.t = T0 + DAY + 1000;
    await n.node.tick();
    const x = await s.next();
    assert.equal(x.kind, 'full');
    assert.deepEqual(x.rows, [], 'the grant expired: no rows');
    await oracle(n, s, 'red(P, X)', eve);
    s.close(); owner.close(); e.close();
  } finally { await n.stop(); }
});

test('a view published in the owner\'s book is served as a page and its events are the literal\'s subscription', async () => {
  const n = await start(tmpDir('sub-view'), 'home.node');
  try {
    await pub(n, [...toy('rules'), ...toy('scan'), { source: 'stale-pages', relation: 'fkts:view', target: 'red(P, X)', perspective: 'view', confidence: 1 }]);
    const page = await fetch(`${n.url}/view/home.node/stale-pages`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /text\/event-stream/);
    const anon = await subscribe(n.url, '/view/home.node/stale-pages', {});
    assert.equal(anon.status, 404, 'a reader who cannot see the view is told there is none');
    const s = await subscribe(n.url, '/view/home.node/stale-pages', asOperator(n));
    assert.equal(s.status, 200);
    assert.deepEqual((await s.next()).rows, []);
    await pub(n, toy('update'));
    assert.equal((await s.next()).added!.length, 2);
    await oracle(n, s, 'red(P, X)');
    s.close();
  } finally { await n.stop(); }
});
