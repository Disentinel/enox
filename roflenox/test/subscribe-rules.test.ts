// Subscriptions across a batch that moves RULES or ACCESS (r_subscribe): a
// rule added, retired and switched on again, a grant a rule reads by revoked,
// given again and expired, an author's first rules. Needs a `rofl` with
// `watch` and `edit` (ROFL_BIN).
//
// THE ORACLE: after every batch, the rows a subscriber has accumulated from
// its frames equal a fresh `ask` of the same literal, as the same reader; and
// a reader whose access did not change is sent a `delta`, taken by the
// engine's delta (`by: delta`), never the answer whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import type { LocalIdentity } from '../src/identity.ts';
import { signRequest } from '../src/httpsig.ts';
import type { Fact } from '../src/facts.ts';
import type { Frame } from '../src/subscribe.ts';
import { DAY, fact, grant, identityAt, iso, post, start, subscribe, T0, tmpDir, vouch, type Running, type Stream } from './helpers.ts';

const TOY = path.join(import.meta.dirname, 'fixtures/invariants');
const toy = (f: string): Fact[] => fs.readFileSync(path.join(TOY, `${f}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Fact);
const key = (r: { identity: string; cells: unknown[] }) => JSON.stringify([r.identity, r.cells]);
const rule = (name: string, text: string, confidence = 1): Fact => ({ source: name, relation: 'roflenox:rule', target: text, perspective: 'invariant', confidence });
const subPath = (q: string) => `/subscribe?query=${encodeURIComponent(q)}`;
const asOperator = (n: Running) => ({ authorization: `Bearer ${n.node.operatorToken()}` });
const signedGet = (n: Running, who: LocalIdentity, p: string) => signRequest(who, 'GET', n.url + p, null, n.clock.t);
const pubAs = (n: Running, who: LocalIdentity, facts: Fact[]) => publish(n.url, who, facts, () => n.clock.t);

async function oracle(n: Running, s: Stream, query: string, as?: LocalIdentity): Promise<void> {
  const a = await post(n.url, '/ask', { query }, as ? { as } : {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([...s.rows.keys()].sort(), (a.body.rows as { identity: string; cells: unknown[] }[]).map(key).sort(), `subscription ≠ ask ${query}`);
}

/** The next frame is a delta the engine took by delta, moving exactly these rows. */
function delta(f: Frame, added: [string, string][], removed: [string, string][], me: string): void {
  assert.equal(f.kind, 'delta', JSON.stringify(f));
  assert.equal(f.by, 'delta', JSON.stringify(f));
  assert.deepEqual(f.added, added.map((c) => ({ identity: me, cells: c })));
  assert.deepEqual(f.removed, removed.map((c) => ({ identity: me, cells: c })));
}

const WIDEN = 'red(P, X) :- edge[@bob](F, P, "bad", X).';

test('a rule added, retired and switched on again, and a grant it reads by revoked, given and expired, reach a subscriber as deltas', async () => {
  const n = await start(tmpDir('subr'), 'home.node');
  const eve = identityAt(tmpDir('subr-eve'), 'eve');
  const bob = identityAt(tmpDir('subr-bob'), 'bob');
  const me = n.me.name;
  const q = 'red(P, X)';
  try {
    await vouch(n, eve, bob);
    await pubAs(n, n.me, [...toy('rules'), ...toy('scan'), ...toy('update'), grant('eve', iso(T0 + 10 * DAY))]);
    await pubAs(n, bob, [fact('blog', 'bad', 'login@v1'), grant('home.node', iso(T0 + DAY))]);
    // eve reads the owner's book whole and nothing of bob's: her access moves
    // with none of the batches below.
    const s = await subscribe(n.url, subPath(q), signedGet(n, eve, subPath(q)));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal((await s.next()).rows!.length, 2);
    await oracle(n, s, q, eve);

    // A rule that widens red, over bob's book (read by his grant).
    await pubAs(n, n.me, [rule('widen', WIDEN)]);
    delta(await s.next(), [['blog', 'login@v1']], [], me);
    await oracle(n, s, q, eve);

    // The rule retired (re-asserted at 0), then switched on again.
    await pubAs(n, n.me, [rule('widen', WIDEN, 0)]);
    delta(await s.next(), [], [['blog', 'login@v1']], me);
    await oracle(n, s, q, eve);
    await pubAs(n, n.me, [rule('widen', WIDEN)]);
    delta(await s.next(), [['blog', 'login@v1']], [], me);
    await oracle(n, s, q, eve);

    // bob revokes the grant the rule reads by (re-asserted at 0): the row goes.
    await pubAs(n, bob, [{ ...grant('home.node', iso(T0 + DAY)), confidence: 0 }]);
    delta(await s.next(), [], [['blog', 'login@v1']], me);
    await oracle(n, s, q, eve);

    // bob grants again, for an hour; the hour passes: the row comes, then goes by the clock.
    await pubAs(n, bob, [grant('home.node', iso(T0 + 3_600_000))]);
    delta(await s.next(), [['blog', 'login@v1']], [], me);
    await oracle(n, s, q, eve);
    n.clock.t = T0 + 3_600_000 + 1000;
    await n.node.tick();
    delta(await s.next(), [], [['blog', 'login@v1']], me);
    await oracle(n, s, q, eve);

    // A rule of the original set retired: what it alone derived goes.
    await pubAs(n, n.me, [{ ...toy('rules').find((f) => f.source === 'red')!, confidence: 0 }]);
    delta(await s.next(), [], [['home', 'login@v1'], ['settings', 'login@v1']], me);
    await oracle(n, s, q, eve);
    s.close();
  } finally { await n.stop(); }
});

test('an author\'s first rules: a world where there was none, its rows sent as added, saying the world was built whole', async () => {
  const n = await start(tmpDir('subr-first'), 'home.node');
  const me = n.me.name;
  const q = 'red(P, X)';
  try {
    await pubAs(n, n.me, [...toy('scan'), ...toy('update')]);
    const s = await subscribe(n.url, subPath(q), asOperator(n));
    assert.deepEqual((await s.next()).rows, []);
    await pubAs(n, n.me, toy('rules'));
    const f = await s.next();
    assert.equal(f.kind, 'delta', JSON.stringify(f));
    assert.equal(f.by, 'whole', 'there was no world to add the rules to');
    assert.deepEqual(f.added, [{ identity: me, cells: ['home', 'login@v1'] }, { identity: me, cells: ['settings', 'login@v1'] }]);
    await oracle(n, s, q);
    // From then on, by delta.
    await pubAs(n, n.me, toy('accept'));
    delta(await s.next(), [], [['home', 'login@v1']], me);
    await oracle(n, s, q);
    // Every rule retired: the rows go by delta before the world closes.
    await pubAs(n, n.me, toy('rules').map((r) => ({ ...r, confidence: 0 })));
    delta(await s.next(), [], [['settings', 'login@v1']], me);
    await oracle(n, s, q);
    s.close();
  } finally { await n.stop(); }
});

test('a world the node must build anew (its rules ran out of their budget) sends its readers the answer whole, by whole, saying why', async () => {
  const n = await start(tmpDir('subr-wall'), 'home.node', { ruleBudget: 40 });
  const alice = identityAt(tmpDir('subr-alice'), 'alice');
  const q = 'big(X)';
  try {
    await vouch(n, alice);
    await pubAs(n, n.me, [{ source: 'alice', relation: 'roflenox:trust_rules', target: 'rules', perspective: 'policy', confidence: 1 }]);
    await pubAs(n, alice, [rule('big', 'big(X) :- edge(F, X, "n", Y), edge(G, Y, "n", Z).'),
      ...Array.from({ length: 60 }, (_, i) => fact(`v${i}`, 'n', `v${(i + 1) % 60}`))]);
    const s = await subscribe(n.url, subPath(q), signedGet(n, alice, subPath(q)));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const f0 = await s.next();
    assert.ok(f0.unknown?.length, `the budget ran out: ${JSON.stringify(f0)}`);
    await pubAs(n, alice, [fact('w', 'n', 'v0')]);
    const f = await s.next();
    assert.equal(f.kind, 'full', JSON.stringify(f));
    assert.equal(f.by, 'whole');
    assert.match(f.why ?? '', /budget/);
    s.close();
  } finally { await n.stop(); }
});
