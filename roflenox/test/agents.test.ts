// Agents are identities: a key delegated by a parent until an expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalIdentity } from '../src/identity.ts';
import { publish } from '../src/client.ts';
import { batch, DAY, fact, identityAt, iso, post, start, T0, tmpDir, vouch } from './helpers.ts';

const delegate = (agent: string, until: string) => ({ source: agent, relation: 'roflenox:delegate', target: until, perspective: 'policy', confidence: 1 });

test('a delegated agent key publishes until its expiry and is refused after it', async () => {
  const n = await start(tmpDir('agent-n'), 'hub');
  const alice = identityAt(tmpDir('agent-alice'), 'alice');
  const bot = LocalIdentity.create(tmpDir('agent-bot'), 'alice.bot', new Date(T0 - DAY), { delegatedBy: 'alice' });
  const rogue = LocalIdentity.create(tmpDir('agent-rogue'), 'alice.rogue', new Date(T0 - DAY), { delegatedBy: 'alice' });
  try {
    await vouch(n, alice);                      // the hub's operator knows alice; her agents come by delegation
    await publish(n.url, alice, [fact('alice', 'runs', 'bot'), delegate('alice.bot', iso(T0 + 3_600_000))], () => n.clock.t);

    // Until the expiry: it publishes, into its OWN book.
    const b1 = batch(bot, [fact('bot', 'saw', 'thing-1')], null, iso(n.clock.t));
    assert.equal((await post(n.url, '/batches', b1)).status, 201);
    const rows = (await post(n.url, '/ask', { query: 'edge(F, "bot", "saw", T)' })).body.rows as { identity: string }[];
    assert.deepEqual(rows.map((r) => r.identity), ['alice.bot']);

    // After it: refused, and the engine says why.
    n.clock.t = T0 + 2 * 3_600_000;
    const late = await post(n.url, '/batches', batch(bot, [fact('bot', 'saw', 'thing-2')], b1.manifest.digest, iso(n.clock.t)));
    assert.equal(late.status, 422);
    assert.equal(late.body.error, 'not_delegated');
    assert.match(String(late.body.whynot), /^whynot delegated\[sys_roflenox\]\("alice.bot","alice"\):/);
    assert.match(String(late.body.whynot), /builtin fails/);

    // An agent its parent never delegated is refused outright.
    const r = await post(n.url, '/batches', batch(rogue, [fact('rogue', 'did', 'x')], null, iso(n.clock.t)));
    assert.equal(r.body.error, 'not_delegated');
    assert.match(String(r.body.whynot), /failed premise: delegate\[b_[0-9a-f]{16}\]\("alice.rogue",\?U#0\)/);

    // A new delegation from the parent lets it act again — nothing else is agent-specific.
    await publish(n.url, alice, [delegate('alice.bot', iso(T0 + DAY))], () => n.clock.t);
    assert.equal((await post(n.url, '/batches', batch(bot, [fact('bot', 'saw', 'thing-3')], b1.manifest.digest, iso(n.clock.t)))).status, 201);
  } finally { await n.stop(); }
});

test('a sub-agent is refused as soon as any identity above it in the delegation chain is', async () => {
  const n = await start(tmpDir('chain-n'), 'hub');
  const alice = identityAt(tmpDir('chain-alice'), 'alice');
  const bot = LocalIdentity.create(tmpDir('chain-bot'), 'alice.bot', new Date(T0 - DAY), { delegatedBy: 'alice' });
  const bot2 = LocalIdentity.create(tmpDir('chain-bot2'), 'alice.bot2', new Date(T0 - DAY), { delegatedBy: 'alice.bot' });
  try {
    await vouch(n, alice);
    await publish(n.url, alice, [delegate('alice.bot', iso(T0 + 3_600_000))], () => n.clock.t);
    // The expiring agent mints a year-long heir while it is still live.
    const d = batch(bot, [delegate('alice.bot2', iso(T0 + 365 * DAY))], null, iso(n.clock.t));
    assert.equal((await post(n.url, '/batches', d)).status, 201);
    const c1 = batch(bot2, [fact('bot2', 'did', '1')], null, iso(n.clock.t));
    assert.equal((await post(n.url, '/batches', c1)).status, 201, 'control: the whole chain is live');

    n.clock.t = T0 + 2 * 3_600_000;
    const r = await post(n.url, '/batches', batch(bot2, [fact('bot2', 'did', '2')], c1.manifest.digest, iso(n.clock.t)));
    assert.equal(r.status, 422, 'the heir falls with its parent');
    assert.equal(r.body.error, 'not_delegated');
    assert.match(String(r.body.message), /alice\.bot has no live delegation from alice/, 'names the first link that failed');
    assert.match(String(r.body.whynot), /^whynot delegated\[sys_roflenox\]\("alice.bot","alice"\):/);
  } finally { await n.stop(); }
});
