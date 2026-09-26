// Private batches: sealed to recipients, readable on no host in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { kek, open, seal, type Envelope } from '../src/seal.ts';
import { newSalt, toJsonl } from '../src/facts.ts';
import { canonicalize } from '../src/jcs.ts';
import { admitSealed, publishSealed } from '../src/client.ts';
import { listen } from '../src/http.ts';
import { DAY, fact, get, identityAt, iso, post, start, T0, tmpDir } from './helpers.ts';
import { LocalIdentity, type IdentityDoc } from '../src/identity.ts';

/** A dumb static host: serves files from a directory, knows nothing else. */
async function staticHost(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const p = path.join(dir, path.basename(req.url ?? '/'));
    if (!fs.existsSync(p)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fs.readFileSync(p));
  });
  const url = await listen(server, 0);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

function tryPayloadKey(e: Envelope, key: Buffer): boolean {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64url'));
    const ct = Buffer.from(e.ciphertext, 'base64url');
    d.setAAD(Buffer.from(canonicalize({ v: e.v, epk: e.epk, recipients: e.recipients })));
    d.setAuthTag(ct.subarray(ct.length - 16));
    d.update(ct.subarray(0, ct.length - 16));
    d.final();
    return true;
  } catch { return false; }
}

test('a static host holding a private batch cannot decrypt it, a recipient can', async () => {
  const a = await start(tmpDir('priv-a'), 'node-a');
  const r = await start(tmpDir('priv-r'), 'node-r');
  const q = identityAt(tmpDir('priv-q'), 'quinn');
  const hostId = identityAt(tmpDir('priv-host'), 'static-host');
  const hostDir = tmpDir('priv-static');
  const host = await staticHost(hostDir);
  try {
    for (const who of [r.me, q]) assert.equal((await post(a.url, '/identities', who.identityChain())).status, 200);
    const e = await publishSealed(a.url, a.me,
      [{ source: 'alice', relation: 'salary', target: '100', perspective: 'human-resources', confidence: 1 }], ['node-r', 'quinn'], () => a.clock.t);
    fs.writeFileSync(path.join(hostDir, 'batch.sealed'), JSON.stringify(e));

    // What the host holds says nothing of the content or its signer.
    const bytes = fs.readFileSync(path.join(hostDir, 'batch.sealed'), 'utf8');
    // (Only strings long enough not to occur by chance in base64 of random bytes.)
    for (const secret of ['salary', 'alice', 'node-a', 'human-resources']) assert.ok(!bytes.includes(secret), `the host can read "${secret}"`);

    // The host, with its own keys, cannot open it...
    assert.throws(() => open(e, 'static-host', hostId.encPrivateKey()), /not sealed to static-host/);
    // ...nor by claiming a recipient's stanza for itself...
    const claimed = { ...e, recipients: e.recipients.map((s) => ({ ...s, identity: 'static-host' })) };
    assert.throws(() => open(claimed, 'static-host', hostId.encPrivateKey()), /cannot_unwrap|opens with this identity's key/);
    // ...nor by presenting a recipient's NAME with its own key...
    assert.throws(() => open(e, 'node-r', hostId.encPrivateKey()), /opens with this identity's key/);
    // ...and the wrap key depends on the X25519 secret, not only on what is
    // public (epk, the recipient's key): two different secrets, same public
    // inputs, give different wrap keys.
    const pubK = r.me.identityDoc().doc.enc.public_key;
    assert.notDeepEqual(kek(crypto.randomBytes(32), e.epk, pubK), kek(crypto.randomBytes(32), e.epk, pubK));
    // ...and nothing it holds works as the payload key.
    const material = [e.epk, e.iv, ...e.recipients.flatMap((s) => [s.iv, s.wrapped])].map((x) => Buffer.from(x, 'base64url'));
    const candidates = material.flatMap((m) => (m.length >= 32 ? [m.subarray(0, 32), m.subarray(m.length - 32)] : []));
    assert.ok(candidates.length > 0);
    for (const k of candidates) assert.equal(tryPayloadKey(e, k), false, 'a field of the envelope opened the payload');

    // A recipient fetches it from the host, opens it, and its node admits the
    // batch as node-a's — the signature inside still decides.
    const fetched = JSON.parse(await (await fetch(`${host.url}/batch.sealed`)).text()) as Envelope;
    const receipt = await admitSealed(r.url, fetched);
    assert.equal((receipt.receipt as { identity: string }).identity, 'node-a');
    const rows = (await post(r.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { identity: string; cells: string[] }[];
    assert.deepEqual(rows.map((x) => [x.identity, ...x.cells.slice(1)]), [['node-a', 'alice', 'salary', '100']]);
    // The second recipient can too.
    assert.equal(open(fetched, 'quinn', q.encPrivateKey()).manifest.identity, 'node-a');

    // Anything altered is refused whole.
    const ct = Buffer.from(e.ciphertext, 'base64url');
    ct[5] ^= 1;
    assert.throws(() => open({ ...e, ciphertext: ct.toString('base64url') }, 'node-r', r.me.encPrivateKey()), /altered/);
    const extra = { ...e, recipients: [...e.recipients, { ...e.recipients[1]!, identity: 'static-host' }] };
    assert.throws(() => open(extra, 'node-r', r.me.encPrivateKey()), /altered/);
    // A batch body changed inside a re-sealed envelope still fails its signature.
    const inner = open(e, 'node-r', r.me.encPrivateKey());
    const forged = await post(r.url, '/batches', { ...inner, jsonl: inner.jsonl.replace('100', '999') });
    assert.equal(forged.body.error, 'digest_mismatch');
  } finally { await host.close(); await a.stop(); await r.stop(); }
});

test('a sealed batch opened a day later is admitted, and one signed by a key revoked before it was sealed is refused', async () => {
  const dirA = tmpDir('off-a');
  const a = await start(dirA, 'node-a');
  const r = await start(tmpDir('off-r'), 'node-r');
  try {
    assert.equal((await post(a.url, '/identities', r.me.identityChain())).status, 200);
    const e1 = await publishSealed(a.url, a.me, [fact('alice', 'knows', 'bob')], ['node-r'], () => a.clock.t);

    // A day later there is no live channel to be fresh on; the envelope is
    // judged by the key's validity at claimed_at.
    r.clock.t = T0 + DAY;
    const inner = open(e1, 'node-r', r.me.encPrivateKey());
    assert.equal((await post(r.url, '/batches', { ...inner })).body.error, 'stale', 'control: the same batch as a live POST is stale');
    const ok = await post(r.url, '/sealed', e1);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((ok.body.receipt as { via: string }).via, 'envelope');
    // Only an envelope the node itself can open is taken this way.
    const other = await publishSealed(a.url, a.me, [fact('alice', 'knows', 'eve')], ['node-a'], () => a.clock.t);
    assert.equal((await post(r.url, '/sealed', other)).body.error, 'not_a_recipient');

    // Key 1 is stolen; the owner recovers at T0+1h, revoking it.
    const td = tmpDir('off-thief');
    fs.cpSync(path.join(dirA, 'key'), path.join(td, 'key'), { recursive: true });
    const thief = LocalIdentity.load(td)!;
    a.clock.t = T0 + 3_600_000;
    const head = ((await get(a.url, '/health')).body.heads as Record<string, string>)['node-a']!;
    const chain = (await get(a.url, '/identities/node-a')).body as unknown as IdentityDoc[];
    const owner = LocalIdentity.recover(dirA, a.me.recoveryCode!, chain, head, new Date(a.clock.t));
    assert.equal((await post(a.url, '/identities', owner.identityChain())).status, 200);
    // node-r learns of it (the freshest chain it can get).
    assert.equal((await post(r.url, '/identities', owner.identityChain())).status, 200);

    // The thief seals a batch after the revocation (honestly dated, and backdated).
    // It chains onto what node-r holds, so only the key can stop it.
    const rHead = ((await get(r.url, '/health')).body.heads as Record<string, string>)['node-a']!;
    const theirs = (claimed: number) => {
      const jsonl = toJsonl([fact('mallory', 'owns', 'node-a')]);
      const salt = newSalt();
      return seal({ manifest: thief.signBatch(jsonl, rHead, iso(claimed), salt), jsonl, salt, identity: thief.identityChain() },
        [{ identity: 'node-r', enc_public_key: r.me.identityDoc().doc.enc.public_key }]);
    };
    const honest = await post(r.url, '/sealed', theirs(T0 + 7_200_000));
    assert.equal(honest.body.error, 'key_not_valid');
    const backdated = await post(r.url, '/sealed', theirs(T0 + 60_000));
    assert.equal(backdated.body.error, 'key_revoked');
    const rows = (await post(r.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { cells: string[] }[];
    assert.ok(!JSON.stringify(rows).includes('mallory'));
  } finally { await a.stop(); await r.stop(); }
});
