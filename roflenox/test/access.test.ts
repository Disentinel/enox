// Access: signed grants read by ROFL rules, RFC 9421 requests, default deny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { bookOf, verifyManifestSig, type IdentityDoc, type LocalIdentity } from '../src/identity.ts';
import { listen } from '../src/http.ts';
import { batchDigest, factId, sha256hex, toJsonl } from '../src/facts.ts';
import { signRequest } from '../src/httpsig.ts';
import { publish } from '../src/client.ts';
import type { Manifest } from '../src/identity.ts';
import { batch, DAY, exportRule, fact, get, grant, identityAt, invitation, iso, post, start, T0, tmpDir, pull, vouch } from './helpers.ts';

const BOOK_A = bookOf('node-a');

test('a request signed by an identity with no grant is refused and whynot names the missing grant', async () => {
  const a = await start(tmpDir('grant'), 'node-a');
  const bob = identityAt(tmpDir('grant-bob'), 'bob');
  const carol = identityAt(tmpDir('grant-carol'), 'carol');
  const b = identityAt(tmpDir('grant-b'), 'node-b');
  try {
    for (const who of [bob, carol]) assert.equal((await post(a.url, '/identities', who.identityDoc())).status, 200);
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob'), grant('bob', iso(T0 + DAY))], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    // node-b "grants" carol in ITS book: that is no grant to node-a's book.
    assert.equal((await post(a.url, '/batches', batch(b, [fact('x', 'y', 'z'), grant('carol', iso(T0 + DAY))], null, iso(a.clock.t)))).status, 201);
    const q = { query: `edge[${BOOK_A}](F, S, R, T)` };

    const refused = await post(a.url, '/ask', q, { as: carol });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'no_grant');
    const whynot = String(refused.body.whynot);
    // The engine's own text: the rule, and the grant premise that failed.
    assert.match(whynot, /^whynot may_read\[sys_roflenox\]\("carol","b_[0-9a-f]{16}"\):/);
    assert.ok(whynot.includes(`failed premise: grant[${BOOK_A}]("carol",`), whynot);
    assert.match(whynot, /no rule concludes 'grant' and no matching base fact exists/);
    const ex = (await post(a.url, '/op/whynot', { literal: `edge("f", "a", "r", "b")` }, { as: carol })).body as unknown as { identity: string }[];
    assert.deepEqual(ex.map((e) => e.identity), ['node-b'], 'carol gets explanations only of the book she was granted');

    // The recipient reads; a bookless question simply shows carol nothing of node-a.
    const ok = await post(a.url, '/ask', q, { as: bob });
    assert.equal(ok.status, 200);
    assert.equal((ok.body.rows as unknown[]).length, 2);
    const bookless = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' }, { as: carol })).body.rows as { identity: string }[];
    assert.ok(!bookless.some((r) => r.identity === 'node-a'));

    // Expiry is judged by the engine on the node's clock.
    a.clock.t = T0 + DAY + 1000;
    const expired = await post(a.url, '/ask', q, { as: bob });
    assert.equal(expired.status, 403);
    assert.match(String(expired.body.whynot), /builtin fails/);
    a.clock.t = T0;

    // Unsigned, unknown, tampered and replayed requests are not reads.
    assert.equal((await post(a.url, '/ask', q, { as: null })).status, 401);
    const stranger = identityAt(tmpDir('grant-s'), 'stranger');
    assert.equal((await post(a.url, '/ask', q, { as: stranger })).body.error, 'unknown_requester');
    const body = JSON.stringify(q);
    const h = signRequest(bob, 'POST', `${a.url}/ask`, body, a.clock.t);
    const send = (text: string) => fetch(`${a.url}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: text })
      .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const tampered = await send(JSON.stringify({ query: 'edge(F, S, R, T)' }));
    assert.equal(tampered.status, 401);
    assert.match(String(tampered.body.message), /content-digest/);
    assert.equal((await send(body)).status, 200);
    const replay = await send(body);
    assert.equal(replay.status, 401);
    assert.match(String(replay.body.message), /nonce reused/);
    // carol signs, but names bob's key: the signature does not verify under it.
    const forged = signRequest(carol, 'POST', `${a.url}/ask`, body, a.clock.t);
    forged['signature-input'] = forged['signature-input']!.replace(/keyid="[0-9a-f]+"/, `keyid="${bob.keyId}"`);
    const r4 = await fetch(`${a.url}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...forged }, body });
    assert.equal(r4.status, 401);
    assert.match(String(((await r4.json()) as { message: string }).message), /does not verify/);
    const late = signRequest(bob, 'POST', `${a.url}/ask`, body, a.clock.t - 301_000);
    const r5 = await fetch(`${a.url}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...late }, body });
    assert.equal(r5.status, 401);
  } finally { await a.stop(); }
});

test('a fact with no export rule never appears in a published batch', async () => {
  const a = await start(tmpDir('export-a'), 'node-a');
  const b = await start(tmpDir('export-b'), 'node-b');
  const dave = identityAt(tmpDir('export-dave'), 'dave');
  try {
    assert.equal((await post(a.url, '/identities', dave.identityDoc())).status, 200);
    // The policy itself is a fact too, and it is not exported: it names "salary".
    const b0 = batch(a.me, [exportRule('knows', 'public'), exportRule('salary', 'dave')], null, iso(a.clock.t));
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], b0.manifest.digest, iso(a.clock.t));
    const b2 = batch(a.me, [fact('alice', 'salary', '100')], b1.manifest.digest, iso(a.clock.t));
    const b3 = batch(a.me, [fact('bob', 'knows', 'carol'), fact('bob', 'salary', '90')], b2.manifest.digest, iso(a.clock.t));
    for (const x of [b0, b1, b2, b3]) assert.equal((await post(a.url, '/batches', x)).status, 201);

    // The public feed: the whole chain, content only where every fact is exported.
    const pub = await get(a.url, '/feeds/node-a', { as: null });
    assert.equal(pub.status, 200);
    const entries = pub.body.batches as { manifest: { digest: string }; jsonl?: string; withheld?: boolean }[];
    assert.deepEqual(entries.map((e) => e.manifest.digest), [b0, b1, b2, b3].map((x) => x.manifest.digest));
    assert.deepEqual(entries.map((e) => e.withheld === true), [true, false, true, true]);
    assert.ok(!JSON.stringify(pub.body).includes('salary'), 'no salary fact left the node');

    // Mirrored anonymously: the chain converges, the private facts never arrive.
    assert.deepEqual(await pull(b, invitation(a), 'node-a'), { identity: 'node-a', batches: 4 });
    assert.deepEqual((await get(b.url, '/health')).body.heads, (await get(a.url, '/health')).body.heads);
    const onB = (await post(b.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { cells: string[] }[];
    assert.ok(onB.length > 0 && !JSON.stringify(onB).includes('salary'));
    assert.ok(!JSON.stringify((await get(b.url, '/feeds/node-a', { as: null })).body).includes('salary'));

    // An unsigned question sees exported facts only, fact by fact.
    const anon = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' }, { as: null })).body.rows as { cells: string[] }[];
    assert.deepEqual(anon.map((r) => r.cells.slice(1)).sort(),
      [['alice', 'knows', 'bob'], ['bob', 'knows', 'carol']]);

    // An export to one identity reaches that identity, signed.
    const toDave = (await get(a.url, '/feeds/node-a', { as: dave })).body.batches as { withheld?: boolean; jsonl?: string }[];
    assert.deepEqual(toDave.map((e) => e.withheld === true), [true, false, false, false]);
    assert.ok(toDave[2]!.jsonl!.includes('"salary"'));
  } finally { await a.stop(); await b.stop(); }
});

test('a guessed secret cannot be confirmed from a withheld manifest', async () => {
  const a = await start(tmpDir('guess-a'), 'node-a');
  try {
    const policy = batch(a.me, [exportRule('knows', 'public')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', policy)).status, 201);
    const secret = batch(a.me, [fact('alice', 'salary', '5000')], policy.manifest.digest, iso(a.clock.t));
    // Positive control 1: the secret batch is admitted.
    assert.equal((await post(a.url, '/batches', secret)).status, 201);

    const pub = (await get(a.url, '/feeds/node-a', { as: null })).body.batches as { manifest: { digest: string; count: number }; withheld?: boolean; salt?: string }[];
    const w = pub[1]!;
    // Positive control 2: the withheld manifest IS the secret batch, without its content or salt.
    assert.equal(w.withheld, true);
    assert.equal(w.manifest.digest, secret.manifest.digest);
    assert.equal(w.salt, undefined);
    assert.ok(!JSON.stringify(pub).includes(secret.salt));

    // The attack: hash every guess the way an unsalted digest would be made.
    const guesses = ['4000', '5000', '6000'].map((g) => sha256hex(toJsonl([fact('alice', 'salary', g)])));
    assert.ok(!guesses.includes(w.manifest.digest), 'a guess confirmed the secret');
    // Positive control 3: the guess procedure is right — with the salt, the true guess matches.
    assert.equal(batchDigest(secret.salt, toJsonl([fact('alice', 'salary', '5000')])), w.manifest.digest);
    // The count is visible (the signature covers it): it tells how many facts, never which.
    assert.equal(w.manifest.count, 1);
  } finally { await a.stop(); }
});

/** A TLS-terminating proxy, minus the TLS: it forwards to `backend` over plain
 *  http and rewrites Host to the backend's, as nginx's proxy_pass does. */
async function proxy(backend: string): Promise<{ url: string; close: () => Promise<void> }> {
  const b = new URL(backend);
  const server = http.createServer((req, res) => {
    const up = http.request({ host: b.hostname, port: b.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: b.host, 'x-forwarded-proto': 'https' } }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  const url = await listen(server, 0);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

/** Send a request signed for `signedFor` to `via` with the given Host, the way a
 *  client's request reaches the proxy after DNS and TLS. */
function send(via: string, host: string, signedFor: string, who: LocalIdentity, body: string, now: number): Promise<number> {
  const v = new URL(via);
  const h = signRequest(who, 'POST', signedFor, body, now);
  return new Promise((ok, no) => {
    const r = http.request({ host: v.hostname, port: v.port, method: 'POST', path: new URL(signedFor).pathname,
      headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...h } }, (res) => { res.resume(); ok(res.statusCode!); });
    r.on('error', no);
    r.end(body);
  });
}

test('a request signed for the public https URL verifies at a node listening on plain http behind a proxy', async () => {
  const PUBLIC = 'https://enox.example.org';
  const a = await start(tmpDir('proxy-a'), 'node-a', { publicUrl: PUBLIC });
  const plain = await start(tmpDir('proxy-p'), 'node-p');          // the same setup with no public URL configured
  const bob = identityAt(tmpDir('proxy-bob'), 'bob');
  const pa = await proxy(a.url);
  const pp = await proxy(plain.url);
  try {
    for (const n of [a, plain]) {
      assert.equal((await post(n.url, '/identities', bob.identityChain())).status, 200);
      assert.equal((await post(n.url, '/batches', batch(n.me, [fact('alice', 'knows', 'bob'), grant('bob', iso(T0 + DAY))], null, iso(n.clock.t)))).status, 201);
    }
    const body = (n: typeof a) => JSON.stringify({ query: `edge[${bookOf(n === a ? 'node-a' : 'node-p')}](F, S, R, T)` });
    // Through the proxy, signed for the public https URL: verified, and bob reads.
    assert.equal(await send(pa.url, 'enox.example.org', `${PUBLIC}/ask`, bob, body(a), a.clock.t), 200);
    // Control: the same request at a node that trusts the request's own scheme and Host fails.
    assert.equal(await send(pp.url, 'enox.example.org', `${PUBLIC}/ask`, bob, body(plain), plain.clock.t), 401);
    // A signature for some other origin does not verify at the configured one.
    assert.equal(await send(pa.url, 'enox.example.org', 'https://evil.example.org/ask', bob, body(a), a.clock.t), 401);
    assert.equal(await send(pa.url, 'enox.example.org', 'http://enox.example.org/ask', bob, body(a), a.clock.t), 401);
  } finally { await pa.close(); await pp.close(); await a.stop(); await plain.stop(); }
});

test('a revoked grant answers 410 on the next read, while facts read before the revocation still verify against their batch digest', async () => {
  const a = await start(tmpDir('revoke-a'), 'node-a');
  const bob = identityAt(tmpDir('revoke-bob'), 'bob');
  const carol = identityAt(tmpDir('revoke-carol'), 'carol');
  const q = { query: `edge[${bookOf('node-a')}](F, S, R, T)` };
  try {
    await vouch(a, bob, carol);
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), fact('alice', 'owns', 'x')], () => a.clock.t);
    await publish(a.url, a.me, [grant('bob', iso(T0 + DAY))], () => a.clock.t);
    // What bob reads while granted: the answers, and the signed batches they stand on.
    const read = await post(a.url, '/ask', q, { as: bob });
    assert.equal(read.status, 200);
    const seen = (read.body.rows as { cells: string[] }[]).map((r) => r.cells[0]!);
    const feed = (await get(a.url, '/feeds/node-a', { as: bob })).body as { identity: IdentityDoc[]; batches: { manifest: Manifest; jsonl: string; salt: string }[] };
    assert.ok(feed.batches.every((x) => typeof x.jsonl === 'string'), 'bob was given the batches whole');

    // node-a revokes: the grant re-asserted at confidence 0.
    await publish(a.url, a.me, [{ ...grant('bob', iso(T0 + DAY)), confidence: 0 }], () => a.clock.t);
    const next = await post(a.url, '/ask', q, { as: bob });
    assert.equal(next.status, 410);
    assert.equal(next.body.error, 'grant_revoked');
    // Control: one never granted is refused, not told of a revocation.
    assert.equal((await post(a.url, '/ask', q, { as: carol })).status, 403);

    // What bob read before stays attested: each batch matches its digest and
    // the publisher's signature, and every fact he was answered is in one.
    const key = feed.identity[feed.identity.length - 1]!.doc.keys[0]!;
    const held = new Set<string>();
    for (const x of feed.batches) {
      assert.equal(batchDigest(x.salt, x.jsonl), x.manifest.digest);
      assert.ok(verifyManifestSig(x.manifest, key));
      for (const l of x.jsonl.split('\n').filter(Boolean)) held.add(factId(JSON.parse(l)));
    }
    for (const F of seen) assert.ok(held.has(F), `fact ${F} is attested by a batch`);
    // Positive control of the check: one changed byte no longer verifies.
    const x0 = feed.batches[0]!;
    assert.notEqual(batchDigest(x0.salt, x0.jsonl.replace('alice', 'alicf')), x0.manifest.digest);
  } finally { await a.stop(); }
});
