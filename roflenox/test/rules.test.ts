// User rules, and asking why and why not about what they derive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirror, publish } from '../src/client.ts';
import { bookOf } from '../src/identity.ts';
import { batch, DAY, exportRule, fact, grant, identityAt, invitation, iso, post, start, T0, tmpDir, type Running, pull, vouch } from './helpers.ts';
import type { LocalIdentity } from '../src/identity.ts';

const rule = (name: string, text: string) => ({ source: name, relation: 'roflenox:rule', target: text, perspective: 'rules', confidence: 1 });
const trust = (author: string, confidence = 1) => ({ source: author, relation: 'roflenox:trust_rules', target: 'rules', perspective: 'policy', confidence });

/** bob knows where people work and lets alice read it for a day; alice has a rule over it. */
async function setup(tag: string): Promise<{ n: Running; alice: LocalIdentity; bob: LocalIdentity }> {
  const n = await start(tmpDir(`${tag}-n`), 'hub');
  const alice = identityAt(tmpDir(`${tag}-alice`), 'alice');
  const bob = identityAt(tmpDir(`${tag}-bob`), 'bob');
  for (const who of [alice, bob]) assert.equal((await post(n.url, '/identities', who.identityChain())).status, 200);
  await publish(n.url, bob, [fact('ada', 'works_at', 'acme'), fact('grace', 'works_at', 'acme'), fact('linus', 'works_at', 'osdl'),
    grant('alice', iso(T0 + DAY))], () => n.clock.t);
  await publish(n.url, alice, [rule('colleagues', 'colleague(P) :- edge[@bob](F, P, "works_at", "acme").')], () => n.clock.t);
  // The hub runs alice's rules because its operator trusts her for rules.
  await publish(n.url, n.me, [trust('alice')], () => n.clock.t);
  return { n, alice, bob };
}

test('a rule published by alice derives facts in her book from bob\'s granted facts, and cannot conclude into bob\'s book', async () => {
  const { n, alice, bob } = await setup('ur');
  try {
    const ask = async (q: string, as: LocalIdentity) => ((await post(n.url, '/ask', { query: q }, { as })).body.rows as { identity: string; cells: string[] }[]);
    const got = await ask('colleague(P)', alice);
    assert.deepEqual(got.map((r) => [r.identity, r.cells[0]]).sort(), [['alice', 'ada'], ['alice', 'grace']], 'derived in HER book');
    assert.deepEqual(await ask(`colleague[${bookOf('bob')}](P)`, n.me), [], 'nothing derived in bob\'s');

    // A head in bob's book refuses the whole batch, and so does a read of the system book.
    for (const [text, why] of [['colleague[@bob](P) :- edge(F, P, "works_at", "acme").', 'rule_scope'],
      [`colleague(P) :- may_read[sys_roflenox]("alice", P).`, 'bad_rule']] as const) {
      const head = ((await post(n.url, '/op/chain', { identity: 'alice' })).body.digests as string[]).at(-1)!;
      const r = await post(n.url, '/batches', batch(alice, [fact('x', 'y', 'z'), rule('bad', text)], head, iso(n.clock.t)));
      assert.equal(r.status, 422, text);
      assert.equal(r.body.error, why);
    }
    // Reads cross only through a live grant: when bob's grant expires, the rule sees nothing.
    n.clock.t = T0 + DAY + 1000;
    assert.deepEqual(await ask('colleague(P)', alice), []);
    // bob's facts were never touched.
    assert.equal((await ask(`edge[${bookOf('bob')}](F, S, "works_at", T)`, bob)).length, 3);
  } finally { await n.stop(); }
});

test('why names the facts and the rule an answer stands on, and whynot names the missing premise', async () => {
  const { n, alice } = await setup('ex');
  const carol = identityAt(tmpDir('ex-carol'), 'carol');
  try {
    const why = (await post(n.url, '/op/why', { literal: 'colleague("ada")' }, { as: alice })).body as unknown as { identity: string; holds: boolean; text: string }[];
    // Asked of every book alice reads whole — hers and bob's; it holds in hers.
    assert.deepEqual(why.filter((w) => w.holds).map((w) => w.identity), ['alice']);
    const t = why.find((w) => w.holds)!.text;
    assert.match(t, /^colleague\[b_[0-9a-f]{16}\]\("ada"\)\s+<= r[0-9a-f]+/, 'the rule it stands on');
    assert.ok(t.includes(`edge[${bookOf('bob')}]`) && t.includes('"ada","works_at","acme") [axiom]'), 'bob\'s fact it stands on');
    assert.match(t, /may_read\[sys_roflenox\]\("alice","b_[0-9a-f]{16}"\)/, 'and the grant that let it read');

    const whynot = ((await post(n.url, '/op/whynot', { literal: 'colleague("linus")' }, { as: alice })).body as unknown as { identity: string; holds: boolean; text: string }[])
      .filter((w) => w.identity === 'alice');
    assert.equal(whynot[0]!.holds, false);
    assert.ok(whynot[0]!.text.includes(`failed premise: edge[${bookOf('bob')}](?F#0,"linus","works_at","acme")`), whynot[0]!.text);

    // Within what the asker may see: carol gets no explanation of alice's book.
    assert.equal((await post(n.url, '/identities', carol.identityChain())).status, 200);
    const c = await post(n.url, '/op/why', { literal: `colleague[${bookOf('alice')}]("ada")` }, { as: carol });
    assert.equal(c.status, 403);
    assert.equal(c.body.error, 'no_grant');
  } finally { await n.stop(); }
});

test('negation over an ungranted book is no oracle', async () => {
  const { n, alice } = await setup('neg');
  try {
    await publish(n.url, alice, [fact('alice', 'knows', 'ada'), fact('alice', 'knows', 'zed'),
      rule('absent', 'absent(P) :- edge(F, S, "knows", P), not edge[@bob](_, P, "works_at", "acme").')], () => n.clock.t);
    const ask = async () => ((await post(n.url, '/ask', { query: 'absent(P)' }, { as: alice })).body.rows as { cells: string[] }[]).map((r) => r.cells[0]);
    // Control, with bob's grant live: exactly the person bob does not list.
    assert.deepEqual(await ask(), ['zed']);
    // Without it, the rule learns nothing — not even by what is ABSENT from bob's book.
    n.clock.t = T0 + DAY + 1000;
    assert.deepEqual(await ask(), []);
  } finally { await n.stop(); }
});

test('an unbounded rule yields unknown with its budget named, and another identity\'s batch is admitted meanwhile without delay', async () => {
  const n = await start(tmpDir('budget-n'), 'hub', { ruleBudget: 20_000 });
  const alice = identityAt(tmpDir('budget-alice'), 'alice');
  const bob = identityAt(tmpDir('budget-bob'), 'bob');
  const timed = async <T>(f: () => Promise<T>) => { const t = performance.now(); const r = await f(); return [r, performance.now() - t] as const; };
  try {
    await vouch(n, alice, bob);
    await publish(n.url, n.me, [trust('alice')], () => n.clock.t);
    // Baselines on this machine, now (the suite runs under load): one ordinary admission.
    const [, bobAlone] = await timed(() => publish(n.url, bob, [fact('bob', 'knows', 'dave')], () => n.clock.t));
    // The repro: a rule that counts forever. Its batch is admitted like any other —
    // admission does not run authors' rules.
    const [, aliceAdmit] = await timed(() => publish(n.url, alice, [fact('alice', 'knows', 'bob'),
      rule('base', 'n(0) :- edge(F, S, "knows", T).'), rule('grow', 'n(M) :- n(N), M is N + 1.'),
      rule('fine', 'friend(T) :- edge(F, "alice", "knows", T).')], () => n.clock.t));
    assert.ok(aliceAdmit < 1000 + 5 * bobAlone, `alice's batch took ${aliceAdmit.toFixed(0)} ms (an ordinary one ${bobAlone.toFixed(0)} ms)`);
    // What alice's runaway costs, alone: at most her budget.
    const [, askAlone] = await timed(() => post(n.url, '/ask', { query: 'n(X)', limit: 1 }, { as: alice }));
    await publish(n.url, bob, [fact('bob', 'knows', 'erin')], () => n.clock.t);   // her world must rebuild once more

    // alice asks about her runaway relation while bob publishes: bob waits for
    // at most one budget of hers, never for the rule itself.
    const asking = post(n.url, '/ask', { query: 'n(X)' }, { as: alice });
    const [, bobAdmit] = await timed(() => publish(n.url, bob, [fact('bob', 'knows', 'carol')], () => n.clock.t));
    const r = (await asking).body as { rows: unknown[]; total?: number; unknown?: { identity: string; reason: string; budget: number; unit: string }[] };
    assert.ok(bobAdmit < bobAlone + askAlone + 500, `bob's batch took ${bobAdmit.toFixed(0)} ms (alone ${bobAlone.toFixed(0)} ms, alice's budget ${askAlone.toFixed(0)} ms)`);
    // Unknown, with the budget named — never a silently truncated "answer".
    assert.deepEqual(r.unknown?.map((u) => [u.identity, u.budget, u.unit]), [['alice', 20_000, 'steps']]);
    assert.match(r.unknown![0]!.reason, /budget_exhausted/);
    assert.ok(r.rows.length > 0 && (r.total ?? r.rows.length) <= 20_001);
    // The same author's terminating rule shares her world and her budget: the
    // engine fires a non-recursive rule once recursion settles, so under a
    // runaway it is unknown with the budget named, never an empty answer.
    // Everyone else still answers.
    const friend = (await post(n.url, '/ask', { query: 'friend(T)' }, { as: alice })).body as { rows: { cells: string[] }[]; unknown?: { identity: string; budget: number }[] };
    assert.deepEqual(friend.rows.map((x) => x.cells[0]), []);
    assert.deepEqual(friend.unknown?.map((u) => [u.identity, u.budget]), [['alice', 20_000]]);
    const bobs = (await post(n.url, '/ask', { query: 'edge(F, "bob", "knows", T)' }, { as: bob })).body as { rows: unknown[]; unknown?: unknown };
    assert.equal(bobs.rows.length, 3);
    assert.equal(bobs.unknown, undefined, 'bob\'s answer is not touched by alice\'s budget');
  } finally { await n.stop(); }
});

test('a mirrored rule does not run until the reader trusts its author for rules, and then it does', async () => {
  const a = await start(tmpDir('trust-a'), 'pubr');
  const b = await start(tmpDir('trust-b'), 'reader');
  try {
    await publish(a.url, a.me, [fact('ada', 'knows', 'grace'), rule('knowers', 'knower(X) :- edge(F, X, "knows", T).'), exportRule('*', 'public'),
      // A wildcard never publishes a rule: it is published by name.
      exportRule('roflenox:rule', 'public')], () => a.clock.t);
    const knowers = async (url: string) => ((await post(url, '/ask', { query: 'knower(X)' })).body.rows as { cells: string[] }[]).map((r) => r.cells[0]);
    assert.deepEqual(await knowers(a.url), ['ada'], 'control: at home, the operator\'s own rule runs');

    assert.deepEqual(await pull(b, invitation(a), 'pubr'), { identity: 'pubr', batches: 1 });
    // The facts came; the code did not run.
    assert.equal(((await post(b.url, '/ask', { query: 'edge(F, "ada", "knows", T)' })).body.rows as unknown[]).length, 1);
    assert.deepEqual(await knowers(b.url), []);

    // The reader trusts the author for rules — a fact in its own book — and then it does.
    await publish(b.url, b.me, [trust('pubr')], () => b.clock.t);
    assert.deepEqual(await knowers(b.url), ['ada']);
    // Withdrawn (re-asserted at confidence 0): inert again.
    await publish(b.url, b.me, [trust('pubr', 0)], () => b.clock.t);
    assert.deepEqual(await knowers(b.url), []);

    // POSTED is no different: a never-seen identity that posts a rule to the
    // reader is admitted (facts), but its rule does not run until trusted.
    const stranger = identityAt(tmpDir('trust-s'), 'stranger');
    await vouch(b, stranger);
    await publish(b.url, stranger, [fact('sam', 'knows', 'kim'), rule('knowers', 'knower(X) :- edge(F, X, "knows", T).')], () => b.clock.t);
    assert.equal(((await post(b.url, '/ask', { query: 'edge(F, "sam", "knows", T)' })).body.rows as unknown[]).length, 1);
    assert.deepEqual(await knowers(b.url), []);
    await publish(b.url, b.me, [trust('stranger')], () => b.clock.t);
    assert.deepEqual(await knowers(b.url), ['sam']);
  } finally { await a.stop(); await b.stop(); }
});
