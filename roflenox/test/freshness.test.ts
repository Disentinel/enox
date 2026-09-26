// Freshness belongs to the moment of receipt: live challenges for feeds,
// re-attestation for a stale POST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize } from '../src/jcs.ts';
import { bookOf } from '../src/identity.ts';
import * as http from 'node:http';
import { listen } from '../src/http.ts';
import { mirror, publish, RemoteRefusal, writeStaticFeed } from '../src/client.ts';
import { answers, batch, DAY, exportRule, fact, get, identityAt, iso, post, start, T0, tmpDir } from './helpers.ts';

const WEEK = 7 * DAY;

test('a batch a week old mirrors from a live peer, and the same feed replayed without a fresh challenge is refused', async () => {
  const a = await start(tmpDir('wk-a'), 'node-a');
  const b = await start(tmpDir('wk-b'), 'node-b');
  const c = await start(tmpDir('wk-c'), 'node-c');
  const d = await start(tmpDir('wk-d'), 'node-d');
  const all = [a, b, c, d];
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    await publish(a.url, a.me, [fact('bob', 'knows', 'carol')], () => a.clock.t);
    for (const n of all) n.clock.t = T0 + WEEK;

    // Control: the same week-old batch POSTed as live content is stale.
    const old = (await get(a.url, '/feeds/node-a')).body as { identity: unknown; batches: { manifest: unknown; jsonl: string }[] };
    const direct = await post(b.url, '/batches', { ...old.batches[0], identity: old.identity });
    assert.equal(direct.status, 422);
    assert.equal(direct.body.error, 'stale');

    // From the live publisher, under B's challenge: admitted, a week old or not.
    assert.deepEqual(await mirror(b.url, a.url, 'node-a', b.me, () => b.clock.t), { identity: 'node-a', batches: 2 });
    assert.deepEqual(await answers(b.url), await answers(a.url));

    // Capture one answered feed, as C would receive it.
    const nonce = ((await post(c.url, '/challenges', {})).body.nonce) as string;
    const feed = (await get(a.url, `/feeds/node-a?challenge=${nonce}`)).body;
    assert.ok(feed.attestation, 'the publisher answered the challenge');
    const body = { identity: feed.identity, batches: feed.batches, attestation: feed.attestation, nonce };
    assert.equal((await post(c.url, '/feeds/admit', body)).status, 201);

    // Replayed: to C again, and to D which never issued that challenge.
    for (const n of [c, d]) {
      const r = await post(n.url, '/feeds/admit', body);
      assert.equal(r.status, 422);
      assert.equal(r.body.error, 'challenge_unknown');
    }
    // D's own fresh challenge does not rescue an attestation made for another.
    const dn = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const r2 = await post(d.url, '/feeds/admit', { ...body, nonce: dn });
    assert.equal(r2.body.error, 'challenge_mismatch');
    // A mirror is not the publisher: C cannot attest node-a's head.
    const dn2 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const viaC = (await get(c.url, `/feeds/node-a?challenge=${dn2}`)).body;
    assert.equal(viaC.attestation, undefined);
    const r3 = await post(d.url, '/feeds/admit', { identity: viaC.identity, batches: viaC.batches, attestation: viaC.attestation, nonce: dn2 });
    assert.equal(r3.body.error, 'no_attestation');
    // A mirror cannot forge the publisher's answer: C signs with its own key
    // under node-a's key id, and a genuine answer altered after signing fails too.
    const dn6 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const f6 = (await get(c.url, `/feeds/node-a?challenge=${dn6}`)).body as { identity: unknown; batches: { manifest: { digest: string } }[] };
    const forged = c.me.sign('roflenox-feed-v1\n', {
      identity: 'node-a', key_id: a.me.keyId, head: f6.batches.at(-1)!.manifest.digest, nonce: dn6, attested_at: iso(d.clock.t),
    });
    const r7 = await post(d.url, '/feeds/admit', { identity: f6.identity, batches: f6.batches, attestation: forged, nonce: dn6 });
    assert.equal(r7.body.error, 'bad_signature');
    const dn7 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const f7 = (await get(a.url, `/feeds/node-a?challenge=${dn7}`)).body as { identity: unknown; batches: unknown[]; attestation: { attested_at: string } };
    const altered = { ...f7.attestation, attested_at: iso(Date.parse(f7.attestation.attested_at) + 1) };
    const r8 = await post(d.url, '/feeds/admit', { identity: f7.identity, batches: f7.batches, attestation: altered, nonce: dn7 });
    assert.equal(r8.body.error, 'bad_signature');

    // A publisher whose clock is off by more than the window attests stale.
    a.clock.t = T0 + WEEK - 400_000;
    const dn3 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const skewed = (await get(a.url, `/feeds/node-a?challenge=${dn3}`)).body;
    const r4 = await post(d.url, '/feeds/admit', { identity: skewed.identity, batches: skewed.batches, attestation: skewed.attestation, nonce: dn3 });
    assert.equal(r4.body.error, 'stale');
    // A challenge is good for the window only.
    const dn4 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    a.clock.t = T0 + WEEK + 301_000;
    d.clock.t = T0 + WEEK + 301_000;
    const late = (await get(a.url, `/feeds/node-a?challenge=${dn4}`)).body;
    const r5 = await post(d.url, '/feeds/admit', { identity: late.identity, batches: late.batches, attestation: late.attestation, nonce: dn4 });
    assert.equal(r5.body.error, 'challenge_unknown');
    assert.equal((await get(d.url, '/health')).body.facts, 0, 'D admitted nothing');
    // The attested head must be the end of what is carried.
    const dn5 = ((await post(d.url, '/challenges', {})).body.nonce) as string;
    const f5 = (await get(a.url, `/feeds/node-a?challenge=${dn5}`)).body as { identity: unknown; batches: unknown[]; attestation: unknown };
    const r6 = await post(d.url, '/feeds/admit', { identity: f5.identity, batches: f5.batches.slice(0, 1), attestation: f5.attestation, nonce: dn5 });
    assert.equal(r6.body.error, 'head_mismatch');
  } finally { for (const n of all) await n.stop(); }
});

test('a re-attested batch keeps its digest and gains a second, fresh signature', async () => {
  const dir = tmpDir('reattest');
  let a = await start(dir, 'node-a');
  try {
    const orig = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t - DAY));
    const stale = await post(a.url, '/batches', orig);
    assert.equal(stale.body.error, 'stale');

    // Wrong ways to re-attest are refused.
    const other = identityAt(tmpDir('reattest-o'), 'node-a');
    const cases: [unknown, string][] = [
      [other.reattest(orig.manifest.digest, iso(a.clock.t)), 'unknown_key'],
      [a.me.reattest('0'.repeat(64), iso(a.clock.t)), 'bad_reattest'],
      [{ ...a.me.reattest(orig.manifest.digest, iso(a.clock.t)), attested_at: iso(a.clock.t + 1) }, 'bad_signature'],
      [a.me.reattest(orig.manifest.digest, iso(a.clock.t - DAY)), 'stale'],
    ];
    for (const [reattest, why] of cases) {
      assert.equal((await post(a.url, '/batches', { ...orig, reattest })).body.error, why);
    }

    const att = a.me.reattest(orig.manifest.digest, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', { ...orig, reattest: att })).status, 201);

    const check = async () => {
      const f = (await get(a.url, '/feeds/node-a')).body as { batches: { manifest: typeof orig.manifest; jsonl: string; reattest: typeof att }[] };
      const [e] = f.batches;
      assert.deepEqual(e!.manifest, orig.manifest, 'content and original provenance unchanged');
      assert.equal(e!.jsonl, orig.jsonl);
      assert.equal(e!.reattest.digest, orig.manifest.digest);
      assert.notEqual(e!.reattest.sig, orig.manifest.sig);
      assert.equal(e!.reattest.attested_at, iso(a.clock.t));
      assert.equal(e!.manifest.claimed_at, iso(T0 - DAY));
      const onDisk = fs.readFileSync(path.join(dir, 'log', bookOf('node-a'), `${orig.manifest.digest}.manifest.json`), 'utf8');
      assert.equal(onDisk, canonicalize(orig.manifest));
      const rows = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { identity: string }[];
      assert.deepEqual(rows.map((r) => r.identity), ['node-a']);
    };
    await check();
    await a.stop();
    a = await start(dir, 'node-a');   // replay re-verifies the re-attestation
    await check();
  } finally { await a.stop(); }
});

test('a flood of challenge requests neither grows memory nor stops an honest mirror', async () => {
  const a = await start(tmpDir('flood-a'), 'node-a');
  const b = await start(tmpDir('flood-b'), 'node-b');
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    // A flood at B: 1 000 over HTTP, 200 000 more in-process.
    const statuses: number[] = [];
    for (let k = 0; k < 50; k++) {
      statuses.push(...(await Promise.all(Array.from({ length: 20 }, () => post(b.url, '/challenges', {}, { as: null })))).map((r) => r.status));
    }
    assert.equal(statuses.filter((c) => c === 201).length, 1000, 'nobody is refused a challenge');
    for (let i = 0; i < 200_000; i++) b.node.issueChallenge();
    // The only per-challenge state a node keeps is this table; heap is too
    // noisy to be the measurement.
    assert.equal((await get(b.url, '/health')).body.challenges_remembered, 0, 'issuing stores nothing');
    // An honest mirror goes through in the middle of it.
    assert.deepEqual(await mirror(b.url, a.url, 'node-a', undefined, () => b.clock.t), { identity: 'node-a', batches: 1 });
    assert.equal((await get(b.url, '/health')).body.challenges_remembered, 1, 'only the verified feed\'s challenge is remembered');
    // What a challenge must be: issued here, untampered, unexpired, unused.
    const n = (await post(b.url, '/challenges', {})).body.nonce as string;
    const raw = Buffer.from(n, 'base64url');
    raw[3] ^= 1;
    const feed = (await get(a.url, `/feeds/node-a?challenge=${raw.toString('base64url')}`)).body;
    const tampered = await post(b.url, '/feeds/admit', { identity: feed.identity, batches: [], attestation: feed.attestation, nonce: raw.toString('base64url') });
    assert.equal(tampered.body.error, 'challenge_unknown');
    const foreign = (await post(a.url, '/challenges', {})).body.nonce as string;       // A's, not B's
    const f2 = (await get(a.url, `/feeds/node-a?challenge=${foreign}`)).body;
    assert.equal((await post(b.url, '/feeds/admit', { identity: f2.identity, batches: [], attestation: f2.attestation, nonce: foreign })).body.error, 'challenge_unknown');
    // A refused feed leaves nothing behind.
    assert.equal((await get(b.url, '/health')).body.challenges_remembered, 1);
    // Expired: the window passes.
    const old = (await post(b.url, '/challenges', {})).body.nonce as string;
    a.clock.t += 301_000; b.clock.t += 301_000;
    const f3 = (await get(a.url, `/feeds/node-a?challenge=${old}`)).body;
    assert.equal((await post(b.url, '/feeds/admit', { identity: f3.identity, batches: [], attestation: f3.attestation, nonce: old })).body.error, 'challenge_unknown');
  } finally { await a.stop(); await b.stop(); }
});

/** A static host: files by path, the query string ignored, nothing else. */
async function staticDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!p.startsWith(dir) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(fs.readFileSync(p));
  });
  const url = await listen(server, 0);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

test('a feed copied to a static directory mirrors under a fresh checkpoint and is refused under an expired one', async () => {
  const a = await start(tmpDir('static-a'), 'node-a');
  const b = await start(tmpDir('static-b'), 'node-b');
  const c = await start(tmpDir('static-c'), 'node-c');
  const dir = tmpDir('static-dir');
  const host = await staticDir(dir);
  try {
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), exportRule('*', 'public')], () => a.clock.t);
    await publish(a.url, a.me, [fact('bob', 'knows', 'carol')], () => a.clock.t);
    await writeStaticFeed(a.url, a.me, dir, () => a.clock.t);
    await a.stop();                                   // the publisher goes offline; only the files remain

    // An hour later, inside the 24 h window: B mirrors from the directory.
    b.clock.t = T0 + 3_600_000;
    assert.deepEqual(await mirror(b.url, host.url, 'node-a', undefined, () => b.clock.t), { identity: 'node-a', batches: 2 });
    const rows = (await post(b.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as unknown[];
    assert.equal(rows.length, 3);

    // A day and an hour later, the same copy: the checkpoint has expired.
    c.clock.t = T0 + DAY + 3_600_000;
    const err = await mirror(c.url, host.url, 'node-a', undefined, () => c.clock.t).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof RemoteRefusal);
    assert.equal(err.reason, 'checkpoint_expired');
    assert.deepEqual((await get(c.url, '/health')).body.heads, {});

    // Tampering with the checkpoint, or pairing it with another head, is refused too.
    const copy = JSON.parse(fs.readFileSync(path.join(dir, 'feeds', 'node-a'), 'utf8')) as { identity: unknown; batches: unknown[]; checkpoint: { checkpoint_at: string } };
    const d = await start(tmpDir('static-d'), 'node-d');
    try {
      d.clock.t = T0 + 3_600_000;
      const later = { ...copy, checkpoint: { ...copy.checkpoint, checkpoint_at: iso(T0 + 3_000_000) } };
      assert.equal((await post(d.url, '/feeds/admit', later)).body.error, 'bad_signature');
      assert.equal((await post(d.url, '/feeds/admit', { ...copy, batches: copy.batches.slice(0, 1) })).body.error, 'head_mismatch');
      assert.equal((await post(d.url, '/feeds/admit', { identity: copy.identity, batches: copy.batches })).body.error, 'no_attestation');
    } finally { await d.stop(); }
  } finally { await host.close(); await b.stop(); await c.stop(); }
});
