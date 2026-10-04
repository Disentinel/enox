// Sessions (r_session_identity): each OAuth grant the owner approves writes
// as its own identity, delegated by the owner; a session's token never acts
// for the owner's keys or credentials, and a new owner key ends every session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { LocalIdentity } from '../src/identity.ts';
import { batch, DAY, exportRule, get, grant, identityAt, iso, post, start, tmpDir, vouch, type Running } from './helpers.ts';
import { publish } from '../src/client.ts';
import { bookOf } from '../src/identity.ts';

const PUBLIC = 'https://enox.example.org';
const CALLBACK = 'https://connector.example.org/api/mcp/auth_callback';
const OAUTH = { accessTtlMs: 3_600_000, refreshTtlMs: 86_400_000 };

/** The whole OAuth flow for one client: registered, approved by the owner, redeemed. */
async function connect(a: Running, name: string): Promise<string> {
  const reg = await fetch(`${a.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [CALLBACK] }) });
  const client = ((await reg.json()) as { client_id: string }).client_id;
  const v = crypto.randomBytes(32).toString('base64url');
  const resource = a.node.oauth.resource!;
  const f = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: crypto.createHash('sha256').update(v).digest('base64url'),
    code_challenge_method: 'S256', state: 's', resource, scope: 'mcp', decision: 'approve', secret: a.node.operatorToken() });
  const ok = await fetch(`${a.url}/authorize`, { method: 'POST', body: f, redirect: 'manual' });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(`${a.url}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client, redirect_uri: CALLBACK, resource }) });
  return ((await t.json()) as { access_token: string }).access_token;
}

type Reply = { status: number; text: string; isError: boolean; rpcError?: string };
async function tool(a: Running, bearer: string, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, text, isError: true };
  const j = JSON.parse(text) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (j.error) return { status: 200, text: j.error.message, isError: true, rpcError: j.error.message };
  return { status: 200, text: j.result!.content[0]!.text, isError: j.result!.isError === true };
}
const ok = <T>(r: Reply): T => { assert.equal(r.isError, false, r.text); return JSON.parse(r.text) as T; };
const grantOf = (a: Running, token: string) => a.node.oauth.grantOf(token)!;
const note = (s: string) => ({ source: s, relation: 'zz_note', target: 'x', perspective: 'zz', confidence: 1 });

test('two OAuth sessions write as two distinct identities delegated by the owner, neither can sign as the other or as the owner, and a revoked session can no longer write', async () => {
  const a = await start(tmpDir('sessions'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    const ta = await connect(a, 'Session A'), tb = await connect(a, 'Session B');
    // Each claims, in its write, to be the owner: the signer is its own session all the same.
    type Added = { asserted_by: string; claimed_by: string; edge_id: string; batch: { digest: string } };
    const wa = ok<Added>(await tool(a, ta, 'add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', asserted_by: 'node-a' }));
    const wb = ok<Added>(await tool(a, tb, 'add_assertion', { source: 'Alpha', target: 'Gamma', relation: 'uses', asserted_by: a.node.sessionName(grantOf(a, ta)) }));
    const sa = a.node.sessionName(grantOf(a, ta)), sb = a.node.sessionName(grantOf(a, tb));
    assert.match(sa, /^s[0-9a-f]{10}\.node-a$/);
    assert.notEqual(sa, sb);
    assert.deepEqual([wa.asserted_by, wa.claimed_by], [sa, 'node-a'], 'a claim to be the owner stays a claim');
    assert.deepEqual([wb.asserted_by, wb.claimed_by], [sb, sa], 'a claim to be another session stays a claim');
    // assert is signed as the session too; its batch is in the session's own chain.
    const r = ok<{ identity: string; digest: string }>(await tool(a, ta, 'assert', { facts: [note('from-a')] }));
    assert.equal(r.identity, sa);
    const chainOf = async (id: string) => ((await post(a.url, '/op/chain', { identity: id, limit: 1000 })).body as { digests: string[] }).digests;
    assert.ok((await chainOf(sa)).includes(r.digest));
    assert.ok(!(await chainOf('node-a')).includes(r.digest), 'not the owner\'s');
    // Both delegated by the owner.
    for (const s of [sa, sb]) {
      const docs = (await post(a.url, '/op/identity_chain', { identity: s })).body as unknown as { doc: { delegated_by?: string } }[];
      assert.equal(docs.at(-1)!.doc.delegated_by, 'node-a', s);
      assert.equal(((await post(a.url, '/ask', { query: `live(F, ${JSON.stringify(s)}, "roflenox:delegate", U)` })).body.rows as unknown[]).length, 1, `${s}: one delegation in force`);
    }
    // A batch signed with A's key but naming B, or the owner, is refused.
    const owner = LocalIdentity.load(a.dir)!;
    const keyA = LocalIdentity.derive(owner, sa, `${grantOf(a, ta)} ${owner.keyId}`, new Date(a.clock.t));
    for (const as of [sb, 'node-a']) {
      const forged = batch(keyA, [note('forged')], null, iso(a.clock.t));
      const m = { ...forged.manifest, identity: as };
      const res = await post(a.url, '/batches', { manifest: m, jsonl: forged.jsonl, salt: forged.salt });
      assert.notEqual(res.status, 201, `${as}: ${JSON.stringify(res.body)}`);
    }
    // ...and A's own key, posting as A, is a session write like any other.
    const prev = (await chainOf(sa)).at(-1)!;
    assert.equal((await post(a.url, '/batches', batch(keyA, [note('direct')], prev, iso(a.clock.t)))).status, 201);

    // Revoked: A's token no longer reaches /mcp, and its key can no longer sign.
    const rev = ok<{ revoked: boolean; session_retired: boolean }>(await tool(a, a.node.operatorToken(), 'oauth_revoke', { grant: grantOf(a, ta) }));
    assert.deepEqual([rev.revoked, rev.session_retired], [true, true]);
    assert.equal((await tool(a, ta, 'assert', { facts: [note('after')] })).status, 401);
    const late = await post(a.url, '/batches', batch(keyA, [note('late')], (await chainOf(sa)).at(-1)!, iso(a.clock.t)));
    assert.equal(late.status, 422);
    assert.equal(late.body.error, 'not_delegated');
    // B writes on.
    assert.equal(ok<{ identity: string }>(await tool(a, tb, 'assert', { facts: [note('b on')] })).identity, sb);
  } finally { await a.stop(); }
});

test('a session token is refused for operator_token, the OAuth grant list and revocation, and after the owner\'s key rotates no session identity can write until approved again', async () => {
  const a = await start(tmpDir('sessions-owner'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    const ta = await connect(a, 'Session A'), tb = await connect(a, 'Session B');
    ok(await tool(a, ta, 'assert', { facts: [note('a')] }));
    ok(await tool(a, tb, 'assert', { facts: [note('b')] }));
    const sa = a.node.sessionName(grantOf(a, ta)), sb = a.node.sessionName(grantOf(a, tb));
    // The worst case first: a session asking for the owner's token gets nothing.
    const leak = await tool(a, ta, 'operator_token');
    assert.equal(leak.isError, true);
    assert.ok(!leak.text.includes(a.node.operatorToken()), 'the owner token never reaches a session');
    for (const [name, args] of [['oauth_grants', {}], ['oauth_revoke', { grant: grantOf(a, tb) }], ['rotate', {}], ['recover', { code: 'x' }], ['checkpoint', { out: '/tmp/x' }]] as const) {
      const r = await tool(a, ta, name, args);
      assert.equal(r.isError, true, name);
      assert.doesNotMatch(r.text, /"grants"|revoked":true/, name);
    }
    assert.equal(a.node.oauth.grantOf(tb) !== null, true, 'B was not revoked by A');
    // Ordinary writes stay allowed, retract_node included, signed as the session.
    const ab = ok<{ source: string; asserted_by: string }>(await tool(a, ta, 'add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses' }));
    assert.equal(ab.asserted_by, sa);
    ok(await tool(a, ta, 'retract_node', { node_id: ab.source }));
    // The owner's own credential still lists and revokes.
    assert.equal(ok<{ grants: unknown[] }>(await tool(a, a.node.operatorToken(), 'oauth_grants')).grants.length, 2);

    // The owner's key rotates: every session ends — its token and its identity.
    const owner = LocalIdentity.load(a.dir)!;
    const keyA = LocalIdentity.derive(owner, sa, `${grantOf(a, ta)} ${owner.keyId}`, new Date(a.clock.t));
    const prevA = ((await post(a.url, '/op/chain', { identity: sa, limit: 1000 })).body as { head: string }).head;
    a.clock.t += 1000;
    const next = owner.rotate(a.dir, new Date(a.clock.t));
    await a.node.introduce(next.identityChain(), 'node-a');
    for (const t of [ta, tb]) assert.equal((await tool(a, t, 'assert', { facts: [note('after rotation')] })).status, 401);
    const late = await post(a.url, '/batches', batch(keyA, [note('late')], prevA, iso(a.clock.t)));
    assert.equal(late.body.error, 'not_delegated');
    for (const s of [sa, sb]) assert.deepEqual((await post(a.url, '/ask', { query: `live(F, ${JSON.stringify(s)}, "roflenox:delegate", U)` })).body.rows, [], s);
    // Approved again: a new session, under the new key, writes.
    const tc = await connect(a, 'Session A again');
    const w = ok<{ identity: string }>(await tool(a, tc, 'assert', { facts: [note('approved again')] }));
    assert.match(w.identity, /^s[0-9a-f]{10}\.node-a$/);
    assert.ok(![sa, sb].includes(w.identity));
  } finally { await a.stop(); }
});

test('a reader granted the owner\'s book reads what a session wrote while delegated, still reads it after the session is revoked, and a stranger reads none of it', async () => {
  const a = await start(tmpDir('sessions-read'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    const reader = identityAt(tmpDir('sessions-read-r'), 'reader');
    const stranger = identityAt(tmpDir('sessions-read-s'), 'stranger');
    await vouch(a, reader, stranger);
    await publish(a.url, a.me, [grant('reader', iso(a.clock.t + DAY))], () => a.clock.t);
    const ta = await connect(a, 'Session A');
    const w = ok<{ identity: string; digest: string }>(await tool(a, ta, 'assert', { facts: [note('written by a session')] }));
    const sa = w.identity;
    const asks = (as: LocalIdentity | null) => post(a.url, '/ask', { query: 'edge(F, "written by a session", R, T)' }, { as });
    const feedOf = (as: LocalIdentity | null) => get(a.url, `/feeds/${sa}`, { as });
    const sees = async (as: LocalIdentity | null) => ((await asks(as)).body.rows as { identity: string }[]).map((r) => r.identity);
    // The reader granted the owner's book reads it, by ask and by feed.
    assert.deepEqual(await sees(reader), [sa]);
    const feed = await feedOf(reader);
    assert.equal(feed.status, 200);
    assert.ok((feed.body.batches as { jsonl?: string }[]).some((b) => b.jsonl?.includes('written by a session')));
    // A stranger, and nobody, read none of it.
    for (const as of [stranger, null]) {
      assert.deepEqual(await sees(as), [], `${as?.name ?? 'anonymous'}`);
      assert.equal((await feedOf(as)).status, 404);
      assert.equal((await post(a.url, '/ask', { query: `edge[${bookOf(sa)}](F, S, R, T)` }, { as })).status, as ? 403 : 404, 'the book, named');
    }
    // Revoked: the session writes no more, and what it wrote is still read.
    ok(await tool(a, a.node.operatorToken(), 'oauth_revoke', { grant: grantOf(a, ta) }));
    assert.deepEqual(await sees(reader), [sa]);
    assert.equal((await feedOf(reader)).status, 200);
    // The owner's key rotates (every session ends): still read.
    const owner = LocalIdentity.load(a.dir)!;
    a.clock.t += 1000;
    await a.node.introduce(owner.rotate(a.dir, new Date(a.clock.t)).identityChain(), 'node-a');
    assert.deepEqual(await sees(reader), [sa]);
    // An export of the owner's covers it too: exported to the public, a stranger reads that relation.
    await publish(a.url, LocalIdentity.load(a.dir)!, [exportRule('zz_note', 'public')], () => a.clock.t);
    assert.deepEqual(await sees(stranger), [sa]);
    // Another delegate of the owner's is not a session: its book stays its own.
    const agent = LocalIdentity.create(tmpDir('sessions-read-a'), 'helper.node-a', new Date(a.clock.t - DAY), { delegatedBy: 'node-a' });
    await publish(a.url, LocalIdentity.load(a.dir)!, [{ source: 'helper.node-a', relation: 'roflenox:delegate', target: iso(a.clock.t + DAY), perspective: 'policy', confidence: 1 }], () => a.clock.t);
    assert.equal((await post(a.url, '/batches', batch(agent, [note('written by a helper')], null, iso(a.clock.t)))).status, 201);
    assert.deepEqual(((await post(a.url, '/ask', { query: 'edge(F, "written by a helper", R, T)' }, { as: reader })).body.rows as unknown[]), []);
  } finally { await a.stop(); }
});

test('a session that deletes an edge the owner or another session asserted removes it from live and from every Enox read alike, and conf shows it retired', async () => {
  const a = await start(tmpDir('sessions-delete'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    const op = a.node.operatorToken();
    const ta = await connect(a, 'Session A'), tb = await connect(a, 'Session B');
    type Added = { fact_id: string; edge_id: string; source: string; target: string };
    const askRows = async (query: string) => ((await post(a.url, '/ask', { query })).body.rows as { identity: string; cells: (string | number)[] }[]);
    const outgoing = async (id: string) => ok<{ outgoing: { relation: string; confidence: number }[] }>(await tool(a, op, 'query_graph', { node_id: id })).outgoing;
    // The owner's edge, deleted by session A.
    const own = ok<Added>(await tool(a, op, 'add_assertion', { source: 'OwnerNode', target: 'OwnerTarget', relation: 'depends_on' }));
    const liveOf = (x: Added) => askRows(`live(F, ${JSON.stringify(x.source)}, "depends_on", T)`);
    assert.equal((await liveOf(own)).length, 1);
    // A first changes its confidence: the owner's edge reads it everywhere.
    ok(await tool(a, ta, 'update_assertion', { fact_id: own.fact_id, confidence: 0.4 }));
    assert.deepEqual((await outgoing(own.source)).map((e) => e.confidence), [0.4]);
    assert.deepEqual((await askRows(`conf(${JSON.stringify(own.edge_id)}, C)`)).map((r) => [r.identity, r.cells[0]]).filter(([i]) => i === 'node-a'), [['node-a', 400]]);
    assert.equal((await tool(a, ta, 'delete_assertion', { fact_id: own.fact_id })).isError, false);
    assert.deepEqual(await outgoing(own.source), [], 'gone from the Enox view');
    assert.deepEqual(await liveOf(own), [], 'gone from live');
    assert.doesNotMatch((await tool(a, op, 'explore', { entity: 'OwnerNode' })).text, /depends_on/);
    assert.ok(!ok<{ relation: string; source_id: string }[]>(await tool(a, op, 'recent_activity', { limit: 100 })).some((e) => e.source_id === own.source && e.relation === 'depends_on'));
    for (const r of await askRows(`conf(${JSON.stringify(own.edge_id)}, C)`)) assert.equal(r.cells[0], 0, `conf in ${r.identity}'s book: retired`);
    assert.equal((await askRows(`edge(${JSON.stringify(own.edge_id)}, S, R, T)`)).length >= 1, true, 'history stays in edge');

    // Session B's edge, deleted by session A: the same.
    const bs = ok<Added>(await tool(a, tb, 'add_assertion', { source: 'BNode', target: 'BTarget', relation: 'depends_on' }));
    assert.equal((await liveOf(bs)).length, 1);
    assert.equal((await tool(a, ta, 'delete_assertion', { fact_id: bs.edge_id })).isError, false);
    assert.deepEqual(await outgoing(bs.source), []);
    assert.deepEqual(await liveOf(bs), []);
    for (const r of await askRows(`conf(${JSON.stringify(bs.edge_id)}, C)`)) assert.equal(r.cells[0], 0, `conf in ${r.identity}'s book`);

    // A session's new description of the owner's entity is the one value, in live and in the view.
    ok(await tool(a, op, 'update_node', { node_id: own.source, description: 'by the owner' }));
    ok(await tool(a, tb, 'update_node', { node_id: own.source, description: 'by session B' }));
    assert.deepEqual((await askRows(`live(F, ${JSON.stringify(own.source)}, "enox:description", T)`)).map((r) => r.cells[1]), ['by session B']);
    assert.equal(ok<{ node: { description: string } }>(await tool(a, op, 'query_graph', { node_id: own.source })).node.description, 'by session B');

    // Anyone else's retraction is their own: another delegate of the owner deletes nothing of the owner's.
    const kept = ok<Added>(await tool(a, op, 'add_assertion', { source: 'KeptNode', target: 'KeptTarget', relation: 'depends_on' }));
    const helper = LocalIdentity.create(tmpDir('sessions-delete-h'), 'helper.node-a', new Date(a.clock.t - DAY), { delegatedBy: 'node-a' });
    await publish(a.url, LocalIdentity.load(a.dir)!, [{ source: 'helper.node-a', relation: 'roflenox:delegate', target: iso(a.clock.t + DAY), perspective: 'policy', confidence: 1 }], () => a.clock.t);
    const raw = (await askRows(`edge(${JSON.stringify(kept.edge_id)}, S, R, T)`))[0]!.cells;
    assert.equal((await post(a.url, '/batches', batch(helper, [{ source: String(raw[0]), relation: String(raw[1]), target: String(raw[2]), perspective: 'enox', confidence: 0 }], null, iso(a.clock.t)))).status, 201);
    assert.equal((await liveOf(kept)).filter((r) => r.identity === 'node-a').length, 1, 'the owner\'s edge is still live');
    assert.deepEqual((await outgoing(kept.source)).length, 1, 'and in the Enox view');
  } finally { await a.stop(); }
});
