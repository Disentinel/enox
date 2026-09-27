// Admission: signature, chain, book scoping, freshness, provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookOf } from '../src/identity.ts';
import { canonicalize } from '../src/jcs.ts';
import { MAX_ENTITY, MAX_RELATION, newSalt } from '../src/facts.ts';
import { Log } from '../src/log.ts';
import { RoflenoxNode } from '../src/node.ts';
import { batch, fact, get, identityAt, iso, post, start, T0, tmpDir } from './helpers.ts';

test('a batch with one byte changed is rejected', async () => {
  const a = await start(tmpDir('byte'), 'node-a');
  try {
    const good = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
    // In the facts: one byte of the JSONL.
    const i = good.jsonl.indexOf('bob');
    const facts = { ...good, jsonl: `${good.jsonl.slice(0, i)}c${good.jsonl.slice(i + 1)}` };
    const r1 = await post(a.url, '/batches', facts);
    assert.equal(r1.status, 422);
    assert.equal(r1.body.error, 'digest_mismatch');
    // In the manifest: one character of claimed_at (still a valid time).
    const m = { ...good.manifest, claimed_at: good.manifest.claimed_at.replace(/\.000Z$/, '.001Z') };
    const r2 = await post(a.url, '/batches', { ...good, manifest: m });
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, 'bad_signature');
    // In the signature itself.
    const s = good.manifest.sig;
    const flipped = (s[5] === 'A' ? 'B' : 'A');
    const r3 = await post(a.url, '/batches', { ...good, manifest: { ...good.manifest, sig: s.slice(0, 5) + flipped + s.slice(6) } });
    assert.equal(r3.status, 422);
    assert.equal(r3.body.error, 'bad_signature');
    // Nothing of any of them was admitted; the untouched batch then is.
    assert.equal((await get(a.url, '/health')).body.facts, 0);
    assert.equal((await post(a.url, '/batches', good)).status, 201);
    assert.equal((await get(a.url, '/health')).body.facts, 1);
  } finally { await a.stop(); }
});

test('a batch inserted into the middle of a chain is rejected', async () => {
  const a = await start(tmpDir('chain'), 'node-a');
  try {
    const b1 = batch(a.me, [fact('a', 'r', '1')], null, iso(a.clock.t));
    const b2 = batch(a.me, [fact('a', 'r', '2')], b1.manifest.digest, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    assert.equal((await post(a.url, '/batches', b2)).status, 201);
    // A validly signed batch that claims to follow b1 — i.e. to sit between b1 and b2.
    const mid = batch(a.me, [fact('a', 'r', 'inserted')], b1.manifest.digest, iso(a.clock.t));
    const r = await post(a.url, '/batches', mid);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'chain_mismatch');
    // A second "first" batch (prev null) is the same attack at the start.
    const r0 = await post(a.url, '/batches', batch(a.me, [fact('a', 'r', 'first')], null, iso(a.clock.t)));
    assert.equal(r0.status, 409);
    // prev is signed: rewriting it on the real b2 breaks the signature.
    const b3 = batch(a.me, [fact('a', 'r', '3')], b1.manifest.digest, iso(a.clock.t));
    const r3 = await post(a.url, '/batches', { ...b3, manifest: { ...b3.manifest, prev: b2.manifest.digest } });
    assert.equal(r3.status, 422);
    assert.equal(r3.body.error, 'bad_signature');
    const ask = await post(a.url, '/ask', { query: 'edge(F, S, R, T)' });
    assert.deepEqual((ask.body.rows as { cells: unknown[] }[]).map((x) => x.cells[3]).sort(), ['1', '2']);
  } finally { await a.stop(); }
});

test('a batch signed by B that writes into the book of A is refused', async () => {
  const a = await start(tmpDir('book'), 'node-a');
  const bDir = tmpDir('book-b');
  const b = identityAt(bDir, 'node-b');
  try {
    assert.equal((await post(a.url, '/batches', batch(a.me, [fact('alice', 'owns', 'x')], null, iso(a.clock.t)))).status, 201);
    const head = (await get(a.url, '/health')).body.heads as Record<string, string>;

    // 1. B signs a manifest that names A as its identity: B's key is not A's.
    const forged = batch(b, [fact('alice', 'owns', 'everything')], head['node-a']!, iso(a.clock.t));
    const asA = { manifest: { ...forged.manifest, identity: 'node-a' }, jsonl: forged.jsonl };
    const r1 = await post(a.url, '/batches', asA);
    assert.equal(r1.status, 422);
    assert.match(String(r1.body.error), /bad_signature|unknown_key/);

    // 2. ...and offers its own identity document relabelled as A's.
    const doc = b.identityDoc();
    const r2 = await post(a.url, '/batches', { ...asA, identity: { ...doc, doc: { ...doc.doc, identity: 'node-a' } } });
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, 'bad_identity_doc');

    // 2b. B mints a key of its own under the NAME node-a, with a correctly
    //     self-signed identity document. The name is pinned to A's key.
    const impostor = identityAt(tmpDir('book-impostor'), 'node-a');
    const r2b = await post(a.url, '/batches', batch(impostor, [fact('alice', 'owns', 'everything')], head['node-a']!, iso(a.clock.t)));
    assert.equal(r2b.status, 409);
    assert.equal(r2b.body.error, 'key_changed');

    // 3. A fact cannot name a book: an extra field is refused before anything else.
    const withBook = forged.jsonl.replace('{', `{"book":"${bookOf('node-a')}",`);
    const r3 = await post(a.url, '/batches',
      { manifest: b.signBatch(withBook, null, iso(a.clock.t), forged.salt), jsonl: withBook, salt: forged.salt, identity: b.identityDoc() });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'malformed_fact');

    // 4. B's legitimate batch whose strings try to break out into A's book
    //    lands in B's book, verbatim, and A's book is unchanged.
    const payload = `x"). edge[${bookOf('node-a')}]("f", "alice", "owns", "everything`;
    const own = batch(b, [fact(payload, 'r', 't\\"\n')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', own)).status, 201);
    const rows = ((await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows) as { identity: string; cells: unknown[] }[];
    assert.deepEqual(rows.filter((r) => r.identity === 'node-a').map((r) => r.cells.slice(1)), [['alice', 'owns', 'x']]);
    assert.deepEqual(rows.filter((r) => r.identity === 'node-b').map((r) => r.cells.slice(1)), [[payload, 'r', 't\\"\n']]);
    const inA = await post(a.url, '/ask', { query: `edge[${bookOf('node-a')}](F, S, R, T)` });
    assert.equal((inA.body.rows as unknown[]).length, 1);
  } finally { await a.stop(); }
});

test('a batch claiming a time outside the window is marked stale and a re-attestation is requested', async () => {
  const a = await start(tmpDir('stale'), 'node-a', { freshnessSec: 300 });
  try {
    const t = a.clock.t;
    for (const claimed of [t - 301_000, t + 301_000]) {
      const r = await post(a.url, '/batches', batch(a.me, [fact('a', 'r', 'b')], null, iso(claimed)));
      assert.equal(r.status, 422);
      assert.equal(r.body.error, 'stale');
      assert.match(String(r.body.message), /re-attestation requested/);
    }
    assert.equal((await get(a.url, '/health')).body.facts, 0);
    // Inside the window, at its edge, is admitted.
    assert.equal((await post(a.url, '/batches', batch(a.me, [fact('a', 'r', 'b')], null, iso(t - 300_000)))).status, 201);
  } finally { await a.stop(); }
});

test('createAssertion requires asserted_by: a batch with no identity or signature is not admitted', async () => {
  const a = await start(tmpDir('unsigned'), 'node-a');
  try {
    const good = batch(a.me, [fact('a', 'r', 'b')], null, iso(a.clock.t));
    const { sig: _sig, ...noSig } = good.manifest;
    for (const body of [
      { jsonl: good.jsonl },                                         // no manifest at all
      { manifest: noSig, jsonl: good.jsonl, identity: good.identity }, // no signature
      { manifest: { ...good.manifest, sig: '' }, jsonl: good.jsonl, identity: good.identity },
      { manifest: good.manifest, jsonl: good.jsonl },                // identity never introduced
    ]) {
      const r = await post(a.url, '/batches', body);
      assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    }
    assert.equal((await get(a.url, '/health')).body.facts, 0);
    // The signed one is admitted, and the fact answers as its signer's.
    assert.equal((await post(a.url, '/batches', good)).status, 201);
    const rows = (await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as { identity: string; cells: string[] }[];
    assert.deepEqual(rows.map((r) => r.identity), ['node-a']);
    const why = await post(a.url, '/op/why', { literal: `edge("${rows[0]!.cells[0]}", "a", "r", "b")` });
    assert.deepEqual((why.body as unknown as { identity: string; holds: boolean }[]).map((e) => [e.identity, e.holds]), [['node-a', true]]);
  } finally { await a.stop(); }
});

test('a batch whose JSONL is not canonical is refused, naming the line', async () => {
  const a = await start(tmpDir('canon'), 'node-a');
  try {
    const good = batch(a.me, [fact('a', 'r', 'b')], null, iso(a.clock.t));
    const loose = '{"source":"a", "relation":"r","target":"b","perspective":"test","confidence":0.9}\n';
    const m = a.me.signBatch(loose, null, iso(a.clock.t), good.salt);
    const r = await post(a.url, '/batches', { manifest: m, jsonl: loose, salt: good.salt, identity: good.identity });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'non_canonical');
    assert.match(String(r.body.message), /line 1/);
  } finally { await a.stop(); }
});

test('a batch whose prev was rewritten after signing is rejected', async () => {
  const a = await start(tmpDir('prev'), 'node-a');
  try {
    const b1 = batch(a.me, [fact('a', 'r', '1')], null, iso(a.clock.t));
    const b2 = batch(a.me, [fact('a', 'r', '2')], b1.manifest.digest, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    assert.equal((await post(a.url, '/batches', b2)).status, 201);
    // Signed as the next batch after b1 — a fork of the chain. Rewriting its prev
    // to the real head would make the chain check pass; the signature must not.
    const fork = batch(a.me, [fact('a', 'r', 'forked')], b1.manifest.digest, iso(a.clock.t));
    const r = await post(a.url, '/batches', { ...fork, manifest: { ...fork.manifest, prev: b2.manifest.digest } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'bad_signature');
    // A first batch re-labelled as a successor is the same forgery.
    const orphan = batch(a.me, [fact('a', 'r', 'orphan')], null, iso(a.clock.t));
    const r2 = await post(a.url, '/batches', { ...orphan, manifest: { ...orphan.manifest, prev: b2.manifest.digest } });
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, 'bad_signature');
    assert.equal((await get(a.url, '/health')).body.facts, 2);
  } finally { await a.stop(); }
});

test('a batch line that is not a relation between two entities is refused', async () => {
  const a = await start(tmpDir('relation'), 'node-a');
  try {
    const line = (o: unknown) => `${canonicalize(o)}\n`;
    const rel = (source: string, relation: string, target: string) => ({ source, relation, target, perspective: 'test', confidence: 0.9 });
    const send = async (jsonl: string) => {
      const salt = newSalt();
      const manifest = a.me.signBatch(jsonl, a.node.head(a.me.name), iso(a.clock.t), salt);
      return post(a.url, '/batches', { manifest, jsonl, salt, identity: a.me.identityChain() });
    };
    const refused: [string, string, string][] = [
      ['a triple written as an array', line(['alice', 'knows', 'bob']), 'malformed_fact'],
      ['a document', line({ title: 'Notes', body: 'Alice knows Bob.', perspective: 'test', confidence: 0.9 }), 'malformed_fact'],
      ['no target', line({ source: 'alice', relation: 'knows', perspective: 'test', confidence: 0.9 }), 'malformed_fact'],
      ['a source that is not a name', line({ ...rel('x', 'knows', 'bob'), source: { name: 'alice' } }), 'malformed_fact'],
      ['a blank source', line(rel('   ', 'knows', 'bob')), 'not_a_relation'],
      ['a blank relation', line(rel('alice', ' \t', 'bob')), 'not_a_relation'],
      ['a blank target', line(rel('alice', 'knows', '  ')), 'not_a_relation'],
      ['a document as the source', line(rel('Meeting notes\n\nAlice said she knows Bob.', 'mentions', 'bob')), 'not_a_relation'],
      ['a document as the relation', line(rel('alice', 'knows\nand also met', 'bob')), 'not_a_relation'],
      ['a source longer than an entity', line(rel('a'.repeat(MAX_ENTITY + 1), 'knows', 'bob')), 'not_a_relation'],
      ['a relation longer than a type', line(rel('alice', 'r'.repeat(MAX_RELATION + 1), 'bob')), 'not_a_relation'],
      ['a good line, then a bad one', line(rel('alice', 'knows', 'bob')) + line(rel('alice', '', 'carol')), 'malformed_fact'],
    ];
    for (const [what, jsonl, error] of refused) {
      const r = await send(jsonl);
      assert.equal(r.status, 400, what);
      assert.equal(r.body.error, error, `${what}: ${String(r.body.message)}`);
      assert.match(String(r.body.message), jsonl.split('\n').length > 2 ? /^line 2/ : /^line 1/, what);
    }
    assert.equal((await get(a.url, '/health')).body.facts, 0, 'nothing of a refused batch was admitted');
    // Through the operation surface too (the MCP assert tool is the same op).
    const op = await post(a.url, '/op/assert', { facts: [rel('alice', 'knows', '')] });
    assert.equal(op.status, 400);
    const op2 = await post(a.url, '/op/assert', { facts: [rel('alice\nbob', 'knows', 'carol')] });
    assert.equal(op2.body.error, 'not_a_relation');
    // Controls: a relation between two entities is admitted, and so is a
    // relation to a VALUE — a long, multi-line description is a target.
    const description = `${'A long description.\n'.repeat(400)}`;
    const ok = await send(line(rel('alice', 'knows', 'bob')) + line(rel('alice', 'enox:description', description)));
    assert.equal(ok.status, 201, String(ok.body.message));
    assert.equal((await get(a.url, '/health')).body.facts, 2);
  } finally { await a.stop(); }

  // The rule is admission's: a log that already holds such a line (written
  // before the rule) still opens — replay does not judge it again.
  const dir = tmpDir('relation-old-log');
  const me = identityAt(dir, 'old');
  const log = new Log(dir);
  log.open();
  const jsonl = `${canonicalize({ confidence: 0.5, perspective: 'test', relation: 'knows', source: 'alice', target: '  ' })}\n`;
  const salt = newSalt();
  log.append(me.signBatch(jsonl, null, iso(T0), salt), jsonl, iso(T0), me.identityDoc(), { salt });
  const n = await RoflenoxNode.open({ dataDir: dir, now: () => T0 + 60_000 });
  try { assert.equal((n.health() as { facts: number }).facts, 1); } finally { await n.close(); }
});
