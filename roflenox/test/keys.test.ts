// Key lifecycle: automatic keys, rotation, recovery, revocation, loud key change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { docHash, keyIdOf, LocalIdentity, signDoc, type IdentityDoc } from '../src/identity.ts';
import { publish, publishSealed, RemoteRefusal } from '../src/client.ts';
import { answers, batch, DAY, exportRule, fact, get, identityAt, invitation, iso, post, start, T0, tmpDir, pull, vouch } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

test('a fresh install that publishes a signed batch with no manual key step', async () => {
  const dir = tmpDir('fresh');
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'serve', '--port', '0', '--data', dir]);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  try {
    const url = await new Promise<string>((ok, no) => {
      child.stdout!.on('data', () => { const m = /serving \S+ at (http:\S+)/.exec(out); if (m) ok(m[1]!); });
      child.on('exit', (c) => no(new Error(`serve exited ${c}: ${out}`)));
    });
    const file = path.join(tmpDir('fresh-f'), 'f.jsonl');
    fs.writeFileSync(file, '{"source":"alice","relation":"knows","target":"bob","perspective":"p","confidence":1}\n');
    // No init, no key step: serve made the identity, publish signs with it.
    const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--data', dir, '--url', url], { encoding: 'utf8' });
    const pub = run(['publish', file]);
    assert.equal(pub.status, 0, pub.stderr);
    assert.match(pub.stdout, /published 1 facts as /);
    const ask = run(['ask', 'edge(F, S, R, T)']);
    assert.match(ask.stdout, /"alice"\t"knows"\t"bob"/);
    assert.equal((fs.statSync(LocalIdentity.keyPath(dir)).mode & 0o777), 0o600);
    // The one piece of key material shown, once: the recovery code.
    assert.equal((out.match(/recovery code for/g) ?? []).length, 1);
    assert.doesNotMatch(pub.stdout + pub.stderr + ask.stdout + ask.stderr, /recovery code/);
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
  }
});

test('a rotation in the middle of a chain is followed without a warning', async () => {
  const dirA = tmpDir('rot-a');
  const a = await start(dirA, 'node-a');
  let b = await start(tmpDir('rot-b'), 'node-b');
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    a.clock.t = b.clock.t = T0 + 3_600_000;
    const tmpDirWithOldKey = tmpDir('rot-old');
    fs.cpSync(path.join(dirA, 'key'), path.join(tmpDirWithOldKey, 'key'), { recursive: true });
    const me2 = a.me.rotate(dirA, new Date(a.clock.t));
    await publish(a.url, me2, [fact('bob', 'knows', 'carol')], () => a.clock.t);
    // The old key signs nothing new after the rotation.
    const head = ((await get(a.url, '/health')).body.heads as Record<string, string>)['node-a']!;
    const late = await post(a.url, '/batches', batch(a.me, [fact('x', 'y', 'z')], head, iso(a.clock.t)));
    assert.equal(late.body.error, 'key_not_valid');

    // Nor can it fork the document chain: an alternative second version,
    // backdated to when the old key was still valid, does not follow the first.
    const j = JSON.parse(fs.readFileSync(LocalIdentity.keyPath(tmpDirWithOldKey), 'utf8')) as { private_key: string };
    const oldKey = crypto.createPrivateKey({ key: Buffer.from(j.private_key, 'base64'), format: 'der', type: 'pkcs8' });
    const d0 = a.me.identityDoc();
    const fork = signDoc({ ...d0.doc, seq: 1, prev: docHash(d0), issued_at: iso(T0 + 1000) }, oldKey);
    const rf = await post(a.url, '/identities', [d0, fork]);
    assert.equal(rf.status, 409);
    assert.match(String(rf.body.whynot), /failed premise: follows\[sys_roflenox\]\("node-a",1\)/);

    // B follows: two documents, two keys, one chain, nothing to report.
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 2 });
    const hb = (await get(b.url, '/health')).body;
    assert.deepEqual(hb.recovered, []);
    assert.deepEqual(hb.heads, { 'node-a': head });
    assert.equal(((await get(b.url, '/identities/node-a')).body as unknown as IdentityDoc[]).length, 2);
    const signers = ((await get(b.url, '/feeds/node-a')).body.batches as { manifest: { key_id: string } }[]).map((x) => x.manifest.key_id);
    assert.deepEqual(signers, [a.me.keyId, me2.keyId]);
    const want = await answers(a.url, { as: null });
    assert.deepEqual(await answers(b.url, { as: null }), want);
    // And again from the log alone.
    await b.stop();
    b = await start(b.dir, 'node-b', { clock: b.clock });
    assert.deepEqual(await answers(b.url, { as: null }), want);
  } finally { await a.stop(); await b.stop(); }
});

/** What a thief holds: a copy of the key file. */
function steal(dir: string): { thief: LocalIdentity; key: crypto.KeyObject; dir: string } {
  const td = tmpDir('thief');
  fs.cpSync(path.join(dir, 'key'), path.join(td, 'key'), { recursive: true });
  const j = JSON.parse(fs.readFileSync(LocalIdentity.keyPath(td), 'utf8')) as { private_key: string };
  return { thief: LocalIdentity.load(td)!, key: crypto.createPrivateKey({ key: Buffer.from(j.private_key, 'base64'), format: 'der', type: 'pkcs8' }), dir: td };
}

test('a stolen current key cannot rotate the identity away from its recovery key', async () => {
  const dirA = tmpDir('rec-a');
  const a = await start(dirA, 'node-a');
  const code = a.me.recoveryCode!;
  try {
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    const { thief, key, dir: td } = steal(dirA);
    const cur = a.me.identityDoc();

    // 1. The stolen key names a recovery key of the thief's own.
    const theirs = crypto.generateKeyPairSync('ed25519').privateKey;
    const tx = crypto.createPublicKey(theirs).export({ format: 'jwk' }).x as string;
    const away = signDoc({ ...cur.doc, seq: 1, prev: docHash(cur), issued_at: iso(a.clock.t),
      recovery: { key_id: keyIdOf(tx), public_key: tx } }, key);
    const r1 = await post(a.url, '/identities', [cur, away]);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'key_changed');
    assert.match(String(r1.body.whynot), /blocked: changes_recovery\[sys_roflenox\]\("node-a",1\) holds/);

    // 2. The stolen key tries to revoke (only recovery may).
    const nk = crypto.generateKeyPairSync('ed25519').privateKey;
    const nx = crypto.createPublicKey(nk).export({ format: 'jwk' }).x as string;
    const revoke = signDoc({ ...cur.doc, seq: 1, prev: docHash(cur), issued_at: iso(a.clock.t),
      keys: [{ ...cur.doc.keys[0]!, revoked_at: iso(a.clock.t), last_good: null },
        { key_id: keyIdOf(nx), alg: 'Ed25519', public_key: nx, valid_from: iso(a.clock.t) }] }, key);
    const r2 = await post(a.url, '/identities', [cur, revoke]);
    assert.equal(r2.status, 409);
    assert.match(String(r2.body.whynot), /blocked: revokes\[sys_roflenox\]\("node-a",1\) holds/);

    // 2b. Without the key, a document that merely NAMES it is a forgery.
    const forged = { ...signDoc({ ...cur.doc, seq: 1, prev: docHash(cur), issued_at: iso(a.clock.t),
      recovery: { key_id: keyIdOf(tx), public_key: tx } }, theirs), key_id: cur.key_id };
    const r2b = await post(a.url, '/identities', [cur, forged]);
    assert.equal(r2b.status, 422);
    assert.equal(r2b.body.error, 'bad_identity_doc');

    // 3. A plain rotation IS within the stolen key's power...
    a.clock.t += 1000;
    const t2 = thief.rotate(td, new Date(a.clock.t));
    assert.equal((await post(a.url, '/identities', t2.identityChain())).status, 200);
    // ...and the recovery key takes it back: every key revoked, a new one in use.
    a.clock.t += 1000;
    const chain = (await get(a.url, '/identities/node-a')).body as unknown as IdentityDoc[];
    const owner = LocalIdentity.recover(dirA, code, chain, b1.manifest.digest, new Date(a.clock.t));
    assert.equal((await post(a.url, '/identities', owner.identityChain())).status, 200);

    a.clock.t += 1000;
    const t3 = await post(a.url, '/batches', batch(t2, [fact('mallory', 'owns', 'node-a')], b1.manifest.digest, iso(a.clock.t)));
    assert.match(String(t3.body.error), /key_not_valid|key_revoked/);
    const again = t2.rotate(td, new Date(a.clock.t));
    const r4 = await post(a.url, '/identities', again.identityChain());
    assert.equal(r4.status, 409, 'the thief cannot rotate past the recovery');
    assert.equal((await post(a.url, '/batches', batch(owner, [fact('alice', 'knows', 'carol')], b1.manifest.digest, iso(a.clock.t)))).status, 201);
  } finally { await a.stop(); }
});

test('a backdated batch received after revocation is rejected', async () => {
  const dirA = tmpDir('rev-a');
  const a = await start(dirA, 'node-a');
  const c = await start(tmpDir('rev-c'), 'node-c');
  try {
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    assert.deepEqual(await pull(c, invitation(a), 'node-a'), { identity: 'node-a', batches: 1 });
    const { thief } = steal(dirA);

    // The owner recovers at T0+10 s.
    a.clock.t = T0 + 10_000;
    const chain = (await get(a.url, '/identities/node-a')).body as unknown as IdentityDoc[];
    const owner = LocalIdentity.recover(dirA, a.me.recoveryCode!, chain, b1.manifest.digest, new Date(a.clock.t));
    assert.equal((await post(a.url, '/identities', owner.identityChain())).status, 200);

    // At T0+20 s the thief posts a batch claiming T0+5 s: inside the freshness
    // window, inside the key's validity as claimed — and received after revocation.
    a.clock.t = c.clock.t = T0 + 20_000;
    const backdated = batch(thief, [fact('mallory', 'owns', 'node-a')], b1.manifest.digest, iso(T0 + 5_000));
    const r = await post(a.url, '/batches', backdated);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'key_revoked');
    // Control: the same bytes at a node that has not heard of the revocation
    // are accepted — what decides is the receipt, not the claim.
    assert.equal((await post(c.url, '/batches', backdated)).status, 201);
    // The owner's own next batch is fine.
    assert.equal((await post(a.url, '/batches', batch(owner, [fact('alice', 'knows', 'dave')], b1.manifest.digest, iso(a.clock.t)))).status, 201);
  } finally { await a.stop(); await c.stop(); }
});

test('a first contact over plain HTTP is refused without an invitation link and pins with one whose key id matches', async () => {
  const a = await start(tmpDir('inv-a'), 'node-a');
  const b = await start(tmpDir('inv-b'), 'node-b');
  // An impostor serving a feed under the same name, with its own key.
  const x = await start(tmpDir('inv-x'), 'node-a');
  try {
    for (const n of [a, x]) await publish(n.url, n.me, [fact('alice', 'knows', n === a ? 'bob' : 'mallory'), exportRule('*', 'public')], () => n.clock.t);
    const refused = (link: string) => pull(b, link, 'node-a').then(() => null, (e: unknown) => e as { reason?: string });
    const nothingPinned = async () => {
      assert.deepEqual((await get(b.url, '/health')).body.heads, {});
      assert.equal((await get(b.url, '/identities/node-a')).status, 404);
    };
    // A bare http:// URL on first contact: refused before anything is pinned.
    assert.equal((await refused(a.url))?.reason, 'invitation_required');
    await nothingPinned();
    // An invitation whose key id is not the one the peer's identity starts from
    // (the impostor's feed under A's link, and A's feed under a made-up key id).
    assert.equal((await refused(invitation(a, x.url)))?.reason, 'invitation_mismatch');
    assert.equal((await refused(`${a.url}#key=${'A'.repeat(43)}`))?.reason, 'invitation_mismatch');
    await nothingPinned();
    // The right link pins A — and from then on the plain URL is enough, while
    // the impostor meets the pin and is refused as a changed key.
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 1 });
    assert.equal(((await get(b.url, '/identities/node-a')).body as unknown as IdentityDoc[])[0]!.key_id, a.me.keyId);
    await publish(a.url, a.me, [fact('bob', 'knows', 'carol')], () => a.clock.t);
    assert.deepEqual(await pull(b, a.url, 'node-a'), { identity: 'node-a', batches: 1 });
    assert.equal((await refused(x.url))?.reason, 'key_changed');
  } finally { await a.stop(); await b.stop(); await x.stop(); }
});

test('an identity nobody vouched for cannot be pinned by writing, introducing or pushing a feed, and the invited pull of the real one still pins', async () => {
  const a = await start(tmpDir('squat-a'), 'node-a');
  const b = await start(tmpDir('squat-b'), 'node-b');
  const x = await start(tmpDir('squat-x'), 'node-a');           // an impostor: A's name, its own key
  const alice = identityAt(tmpDir('squat-alice'), 'alice');
  const bot = LocalIdentity.create(tmpDir('squat-bot'), 'bot.alice', new Date(T0 - DAY), { delegatedBy: 'alice' });
  const rogue = LocalIdentity.create(tmpDir('squat-rogue'), 'rogue.alice', new Date(T0 - DAY), { delegatedBy: 'alice' });
  try {
    for (const n of [a, x]) await publish(n.url, n.me, [fact('alice', 'knows', n === a ? 'bob' : 'mallory'), exportRule('*', 'public')], () => n.clock.t);
    await vouch(b, alice);
    const anon = { as: null };
    const refused = (r: { status: number; body: Record<string, unknown> }, how: string) => {
      assert.equal(r.status, 403, `${how}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'not_vouched', how);
    };

    // Writing: the impostor posts its own signed batch, identity document attached.
    const f = (await get(x.url, '/feeds/node-a')).body as { identity: unknown; batches: { manifest: { digest: string }; jsonl: string; salt: string }[] };
    refused(await post(b.url, '/batches', { ...f.batches[0], identity: f.identity }, anon), 'a write');
    // Introducing: anonymously, and signed by an identity B knows that is not its operator.
    refused(await post(b.url, '/identities', x.me.identityChain(), anon), 'an introduction');
    refused(await post(b.url, '/identities', x.me.identityChain(), { as: alice }), 'an introduction by a known non-operator');
    // Pushing a feed: under B's own live challenge, and as a static checkpoint.
    const nonce = (await post(b.url, '/challenges', {}, anon)).body.nonce as string;
    const live = (await get(x.url, `/feeds/node-a?challenge=${nonce}`, anon)).body;
    refused(await post(b.url, '/feeds/admit', { identity: live.identity, batches: live.batches, attestation: live.attestation, nonce }, anon), 'a pushed feed');
    const checkpoint = x.me.checkpoint(f.batches[0]!.manifest.digest, iso(x.clock.t));
    refused(await post(b.url, '/feeds/admit', { identity: f.identity, batches: f.batches, checkpoint }, anon), 'a pushed static copy');
    // A sealed batch addressed to B.
    await vouch(x, b.me);
    const e = await publishSealed(x.url, x.me, [fact('alice', 'owes', 'mallory')], ['node-b'], () => x.clock.t);
    refused(await post(b.url, '/sealed', e, anon), 'a sealed batch');
    // Nor can anyone take B's own name before B's first batch pins it.
    const y = identityAt(tmpDir('squat-y'), 'node-b');
    refused(await post(b.url, '/batches', batch(y, [fact('b', 'is', 'mine')], null, iso(b.clock.t)), anon), 'a write under the node\'s own name');
    // Nothing of the impostor was pinned.
    assert.equal((await get(b.url, '/identities/node-a')).status, 404);
    assert.equal(((await get(b.url, '/health')).body.heads as Record<string, string>)['node-a'], undefined);

    // A delegation from an identity B pins vouches for its agent — only for the
    // one it delegated.
    await publish(b.url, alice, [{ source: 'bot.alice', relation: 'roflenox:delegate', target: iso(T0 + DAY), perspective: 'policy', confidence: 1 }], () => b.clock.t);
    assert.equal((await post(b.url, '/batches', batch(bot, [fact('bot', 'saw', 'x')], null, iso(b.clock.t)), anon)).status, 201);
    refused(await post(b.url, '/batches', batch(rogue, [fact('rogue', 'saw', 'x')], null, iso(b.clock.t)), anon), 'an undelegated agent');

    // The real A, pulled by its invitation (B's operator's word), pins.
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 1 });
    assert.equal(((await get(b.url, '/identities/node-a')).body as unknown as IdentityDoc[])[0]!.key_id, a.me.keyId);
  } finally { await a.stop(); await b.stop(); await x.stop(); }
});

test('a delegation to a name outside the parent\'s own names pins nothing, and the invited pull of that name\'s real owner still pins', async () => {
  const a = await start(tmpDir('zone-a'), 'node-a');
  const b = await start(tmpDir('zone-b'), 'node-b');
  const alice = identityAt(tmpDir('zone-alice'), 'alice');
  // Agents that name alice as their parent: only the last is under her.
  const names = ['node-a', 'xalice', 'deep.bot.alice', 'alice.bot', 'bot.alice'];
  const agents = names.map((n) => LocalIdentity.create(tmpDir('zone-agent'), n, new Date(T0 - DAY), { delegatedBy: 'alice' }));
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    await vouch(b, alice);
    // alice, trusted at B, delegates every one of those names.
    await publish(b.url, alice, names.map((n) => ({ source: n, relation: 'roflenox:delegate', target: iso(T0 + DAY), perspective: 'policy', confidence: 1 })), () => b.clock.t);
    const tried: string[][] = [];
    for (const g of agents) {
      const r = await post(b.url, '/batches', batch(g, [fact(g.name, 'claims', 'this name')], null, iso(b.clock.t)), { as: null });
      tried.push([g.name, r.status === 201 ? 'pinned' : String(r.body.error)]);
    }
    assert.deepEqual(tried, [['node-a', 'not_vouched'], ['xalice', 'not_vouched'], ['deep.bot.alice', 'not_vouched'],
      ['alice.bot', 'not_vouched'], ['bot.alice', 'pinned']]);
    assert.equal((await get(b.url, '/identities/node-a')).status, 404);
    // The real node-a, pulled by its invitation, pins its own key.
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 1 });
    assert.equal(((await get(b.url, '/identities/node-a')).body as unknown as IdentityDoc[])[0]!.key_id, a.me.keyId);
  } finally { await a.stop(); await b.stop(); }
});

test('a node that swaps its key without rotation is refused with a whynot', async () => {
  const a = await start(tmpDir('swap-a'), 'node-a');
  const b = await start(tmpDir('swap-b'), 'node-b');
  // The same name on a fresh install: a new key, no rotation signed by the old.
  const a2 = await start(tmpDir('swap-a2'), 'node-a');
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 1 });
    const headBefore = (await get(b.url, '/health')).body.heads;
    await publish(a2.url, a2.me, [fact('alice', 'owns', 'everything'), exportRule('*', 'public')], () => a2.clock.t);

    const err = await pull(b, a2.url, 'node-a').then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RemoteRefusal, 'the pull stops');
    assert.equal(err.status, 409);
    assert.equal(err.reason, 'key_changed');
    // The engine says why: no rule accepts a document the pinned key did not sign.
    assert.match(err.whynot!, /^whynot accepted_update\[sys_roflenox\]\("node-a",0\):/);
    assert.ok(err.whynot!.includes(`failed premise: follows[sys_roflenox]("node-a",0)`), err.whynot!);
    assert.deepEqual((await get(b.url, '/health')).body.heads, headBefore);
    // A direct POST says the same.
    const f = (await get(a2.url, '/feeds/node-a')).body as { identity: unknown; batches: { manifest: unknown; jsonl: string }[] };
    const r = await post(b.url, '/batches', { ...f.batches[0], identity: f.identity });
    assert.equal(r.status, 409);
    assert.match(String(r.body.whynot), /current_key\[sys_roflenox\]|follows\[sys_roflenox\]/);
  } finally { await a.stop(); await b.stop(); await a2.stop(); }
});

test('a thief future-dating a rotation cannot lock out the recovery key', async () => {
  const dirA = tmpDir('fut-a');
  const a = await start(dirA, 'node-a');
  const code = a.me.recoveryCode!;
  try {
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    const { thief, dir: td } = steal(dirA);

    // Far in the future: refused outright.
    const far = thief.rotate(tmpDir('fut-far'), new Date('2099-01-01T00:00:00.000Z'));
    const r1 = await post(a.url, '/identities', far.identityChain());
    assert.equal(r1.status, 422);
    assert.equal(r1.body.error, 'future_dated');

    // Just inside the allowed skew: a rotation the stolen key may make...
    const near = thief.rotate(td, new Date(a.clock.t + 290_000));
    assert.equal((await post(a.url, '/identities', near.identityChain())).status, 200);
    // ...and still the recovery key, signing NOW (earlier than that rotation
    // claims), takes the identity back: it is ordered by the chain, not the clock.
    const chain = (await get(a.url, '/identities/node-a')).body as unknown as IdentityDoc[];
    const owner = LocalIdentity.recover(dirA, code, chain, b1.manifest.digest, new Date(a.clock.t));
    const r2 = await post(a.url, '/identities', owner.identityChain());
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    a.clock.t += 1000;
    assert.match(String((await post(a.url, '/batches', batch(near, [fact('mallory', 'owns', 'x')], b1.manifest.digest, iso(a.clock.t)))).body.error),
      /key_not_valid|key_revoked/);
    assert.equal((await post(a.url, '/batches', batch(owner, [fact('alice', 'knows', 'carol')], b1.manifest.digest, iso(a.clock.t)))).status, 201);
  } finally { await a.stop(); }
});

test('an identity document dated past the allowed skew is refused', async () => {
  const a = await start(tmpDir('skew-a'), 'node-a');
  const b = await start(tmpDir('skew-b'), 'node-b');
  try {
    // A first contact from the future.
    const fdir = tmpDir('skew-f');
    const doc0 = identityAt(fdir, 'from-future').identityDoc();
    const later = signDoc({ ...doc0.doc, issued_at: iso(a.clock.t + 3_600_000),
      keys: doc0.doc.keys.map((k) => ({ ...k, valid_from: iso(a.clock.t + 3_600_000) })) }, keyOfDir(fdir));
    const r1 = await post(a.url, '/identities', [later]);
    assert.equal(r1.status, 422);
    assert.equal(r1.body.error, 'future_dated');
    // A rotation from the future.
    const rot = a.me.rotate(tmpDir('skew-rot'), new Date(a.clock.t + 3_600_000));
    assert.equal((await post(a.url, '/identities', rot.identityChain())).body.error, 'future_dated');
    // Inside the skew is fine (clocks differ), and so is the present.
    assert.equal((await post(a.url, '/identities', identityAt(tmpDir('skew-ok'), 'ok').identityChain())).status, 200);
    // A batch claiming the future: a live POST is outside the window (stale);
    // from a feed — where age is not judged — it is refused as future-dated.
    const fb = batch(a.me, [fact('alice', 'knows', 'tomorrow'), exportRule('*', 'public')], null, iso(a.clock.t + 3_600_000));
    assert.equal((await post(a.url, '/batches', fb)).body.error, 'stale');
    a.clock.t += 3_600_000;                       // the publisher's clock runs an hour fast...
    assert.equal((await post(a.url, '/batches', fb)).status, 201);
    a.clock.t -= 3_600_000;                       // ...and is corrected before B pulls
    const err = await pull(b, invitation(a), 'node-a').then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RemoteRefusal);
    assert.equal(err.reason, 'future_dated');
    assert.deepEqual((await get(b.url, '/health')).body.heads, {});
  } finally { await a.stop(); await b.stop(); }
});

/** The private key in a data dir's key file (what a thief or a forger holds). */
function keyOfDir(dir: string): crypto.KeyObject {
  const j = JSON.parse(fs.readFileSync(LocalIdentity.keyPath(dir), 'utf8')) as { private_key: string };
  return crypto.createPrivateKey({ key: Buffer.from(j.private_key, 'base64'), format: 'der', type: 'pkcs8' });
}
