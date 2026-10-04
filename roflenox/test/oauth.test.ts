// OAuth for hosted MCP clients (r_mcp_oauth): a claude.ai-style connector
// registers itself, the owner approves on the authorize page with the operator
// secret, and the token it gets reaches /mcp — and nothing else, and no one else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, listen } from '../src/http.ts';
import { sourceKey, sourceOf } from '../src/oauth.ts';
import { publish } from '../src/client.ts';
import { answerSearches } from '../executors/embedder/embedder.ts';
import { HASH } from '../executors/embedder/embed.ts';
import { DAY, grant, identityAt, iso, post, start, tmpDir, type Clock, type Running } from './helpers.ts';

const PUBLIC = 'https://enox.example.org';
const RESOURCE = `${PUBLIC}/mcp`;
const CALLBACK = 'https://connector.example.org/api/mcp/auth_callback';
/** Every lifetime in milliseconds on the injected clock: nothing here waits. */
const OAUTH = { codeTtlMs: 30, accessTtlMs: 50, refreshTtlMs: 500, maxFailures: 3, failWindowMs: 100 };

const verifier = () => crypto.randomBytes(32).toString('base64url');
const s256 = (v: string) => crypto.createHash('sha256').update(v).digest('base64url');

async function register(a: Running, body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`${a.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Connector', redirect_uris: [CALLBACK], ...body }) });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

function authParams(client: string, v: string, o: Record<string, string> = {}): Record<string, string> {
  return { response_type: 'code', client_id: client, redirect_uri: CALLBACK, code_challenge: s256(v), code_challenge_method: 'S256',
    state: 'st-1', resource: RESOURCE, scope: 'mcp', ...o };
}

/** The owner's POST on the authorize page: the status, and where it sends the browser. */
async function approve(a: Running | string, params: Record<string, string>, secret: string | null, headers: Record<string, string> = {}) {
  const f = new URLSearchParams({ ...params, decision: 'approve', ...(secret === null ? {} : { secret }) });
  const r = await fetch(`${typeof a === 'string' ? a : a.url}/authorize`, { method: 'POST', body: f, redirect: 'manual', headers });
  const location = r.headers.get('location');
  return { status: r.status, location: location ? new URL(location) : null, html: await r.text() };
}

async function tokenCall(a: Running, form: Record<string, string>) {
  const r = await fetch(`${a.url}/token`, { method: 'POST', body: new URLSearchParams(form) });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

const redeem = (a: Running, client: string, code: string, v: string, o: Record<string, string> = {}) =>
  tokenCall(a, { grant_type: 'authorization_code', code, code_verifier: v, client_id: client, redirect_uri: CALLBACK, resource: RESOURCE, ...o });

async function mcp(a: Running, bearer: string | null, method = 'tools/list') {
  const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });
  return { status: r.status, auth: r.headers.get('www-authenticate'), body: await r.json() as Record<string, any> };
}

/** What of the machine a page shows: its paths, its host name, key files and
 *  token — as substrings — and the OS user name as a whole word only (on a
 *  host whose user is "dev", "developer" is not a leak). */
function machineLeaks(html: string, dir: string, token: string): string[] {
  const word = (w: string) => new RegExp(`(^|[^A-Za-z0-9_.-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`);
  const user = os.userInfo().username;
  return [...[dir, os.homedir(), os.hostname(), 'operator-token', 'key/', token].filter((s) => html.includes(s)),
    ...(word(user).test(html) ? [user] : [])];
}

/** The whole flow for one client: registered, approved, redeemed. */
async function connect(a: Running, name = 'Connector') {
  const client = (await register(a, { client_name: name })).body.client_id as string;
  const v = verifier();
  const resource = a.node.oauth.resource!;
  const ok = await approve(a, authParams(client, v, { resource }), a.node.operatorToken());
  assert.equal(ok.status, 302, ok.html);
  const t = await redeem(a, client, ok.location!.searchParams.get('code')!, v, { resource });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { client, access: t.body.access_token as string, refresh: t.body.refresh_token as string };
}

test('a client registered dynamically completes authorize with the owner\'s secret, PKCE S256 and its redirect_uri, gets an access token, and lists tools over /mcp with it', async () => {
  const a = await start(tmpDir('oauth-flow'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    // Discovery, as the MCP authorization spec walks it: a 401 naming the
    // resource metadata, which names the server, whose metadata names the rest.
    const anon = await mcp(a, null);
    assert.equal(anon.status, 401);
    const rm = /resource_metadata="([^"]+)"/.exec(anon.auth ?? '')?.[1];
    assert.equal(rm, `${PUBLIC}/.well-known/oauth-protected-resource/mcp`);
    const prm = await (await fetch(`${a.url}${new URL(rm!).pathname}`)).json() as Record<string, any>;
    assert.deepEqual([prm.resource, prm.authorization_servers], [RESOURCE, [PUBLIC]]);
    const asm = await (await fetch(`${a.url}/.well-known/oauth-authorization-server`)).json() as Record<string, any>;
    assert.equal(asm.issuer, PUBLIC);
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    assert.equal(asm.registration_endpoint, `${PUBLIC}/register`);

    const reg = await register(a);
    assert.equal(reg.status, 201);
    assert.deepEqual(reg.body.redirect_uris, [CALLBACK]);
    const client = reg.body.client_id as string;
    const v = verifier();
    const params = authParams(client, v);

    // The page names the client and the exact host it will send the owner back to,
    // and says nothing about the machine: no paths, user names or key locations.
    const page = await fetch(`${a.url}/authorize?${new URLSearchParams(params)}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.match(html, /<b>Connector<\/b>/);
    assert.match(html, /<b>connector\.example\.org<\/b>/);
    assert.deepEqual(machineLeaks(html, a.dir, a.node.operatorToken()), [], 'the authorize page shows nothing of the machine');
    // The check can say no: a page naming this user, or this home, is caught.
    assert.deepEqual(machineLeaks(`<p>served by ${os.userInfo().username}.</p>`, a.dir, 'x'), [os.userInfo().username]);
    assert.deepEqual(machineLeaks(`<p>${os.homedir()}/node</p>`, a.dir, 'x').includes(os.homedir()), true);

    const ok = await approve(a, params, a.node.operatorToken());
    assert.equal(ok.status, 302);
    assert.equal(`${ok.location!.origin}${ok.location!.pathname}`, CALLBACK);
    assert.equal(ok.location!.searchParams.get('state'), 'st-1');
    assert.equal(ok.location!.searchParams.get('iss'), PUBLIC);
    const code = ok.location!.searchParams.get('code')!;
    const t = await redeem(a, client, code, v);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.token_type, 'Bearer');
    assert.equal(t.body.expires_in, 1);  // 50 ms, rounded up to whole seconds

    const listed = await mcp(a, t.body.access_token);
    assert.equal(listed.status, 200);
    const names = (listed.body.result.tools as { name: string }[]).map((x) => x.name);
    assert.ok(names.includes('ask') && names.includes('oauth_grants'), names.join(','));
    // Through the owner's grant: an operator tool answers (a write, signed as
    // its session, r_session_identity) — but the grant list is the owner's own
    // credential's alone.
    const call = async (name: string, args: Record<string, unknown>) => (await (await fetch(`${a.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) })).json()) as any;
    const wrote = JSON.parse((await call('assert', { facts: [{ source: 'a', relation: 'zz_note', target: 'b', perspective: 'zz', confidence: 1 }] })).result.content[0].text);
    assert.equal(wrote.admitted, true);
    assert.equal((await call('oauth_grants', {})).result.isError, true);
    const grants = a.node.oauth.grants();
    assert.deepEqual(grants.map((g: any) => [g.client, g.redirect_host, g.revoked_at]), [['Connector', 'connector.example.org', null]]);

    // The existing credentials keep working at /mcp: the operator's bearer, and a signed request.
    assert.equal((await mcp(a, a.node.operatorToken())).status, 200);
    assert.equal((await post(a.url, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { as: a.me })).status, 200);
    // The OAuth token is for /mcp only.
    const op = await fetch(`${a.url}/op/health`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.access_token}` }, body: '{}' });
    assert.equal(op.status, 401);

    // Stored only as hashes, in a file only its owner reads.
    const file = path.join(a.dir, 'oauth', 'state.json');
    const stored = fs.readFileSync(file, 'utf8');
    for (const s of [t.body.access_token, t.body.refresh_token, code]) assert.ok(!stored.includes(s), 'a token is stored in the clear');
    assert.ok(stored.includes(crypto.createHash('sha256').update(t.body.access_token).digest('hex')), 'positive control: the hash is there');
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { await a.stop(); }
});

test('authorize without the owner\'s secret, with a wrong secret, with plain PKCE, with a redirect_uri other than the registered one, or a code redeemed twice or by another client, yields no token', async () => {
  const a = await start(tmpDir('oauth-attacks'), 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  try {
    const secret = a.node.operatorToken();
    // The lure: a client names itself anything; the page escapes it and shows where it really sends you.
    const lure = (await register(a, { client_name: 'Claude <script>x()</script>', redirect_uris: ['https://evil.example.net/cb'] })).body.client_id as string;
    const lv = verifier();
    const lurePage = await (await fetch(`${a.url}/authorize?${new URLSearchParams(authParams(lure, lv, { redirect_uri: 'https://evil.example.net/cb' }))}`)).text();
    assert.ok(!lurePage.includes('<script>'), 'the client name is escaped');
    assert.match(lurePage, /<b>evil\.example\.net<\/b>/);
    // Registration refuses redirect URIs a code could leak through.
    assert.equal((await register(a, { redirect_uris: ['http://evil.example.net/cb'] })).status, 400);
    assert.equal((await register(a, { redirect_uris: ['https://evil.example.net/cb#frag'] })).status, 400);

    const client = (await register(a)).body.client_id as string;
    const v = verifier();
    const params = authParams(client, v);
    // No secret, a wrong one (short, and the right length): a page again, no code, no redirect.
    for (const s of [null, '', 'guess', 'x'.repeat(secret.length)]) {
      const r = await approve(a, params, s);
      assert.equal(r.location, null, `secret ${JSON.stringify(s)} redirected`);
      assert.ok(r.status === 401 || r.status === 429, `${r.status}`);
    }
    // Rate-limited: past three wrong secrets even the right one is refused, until the window passes.
    const locked = await approve(a, params, secret);
    assert.equal(locked.status, 429);
    assert.equal(locked.location, null);
    a.clock.t += 101;
    assert.equal((await approve(a, params, secret)).status, 302, 'positive control: the window passed');

    // Plain PKCE, or none: sent back with an error, never a code.
    for (const o of [{ code_challenge_method: 'plain', code_challenge: v }, { code_challenge_method: '' }]) {
      const r = await approve(a, { ...params, ...o }, secret);
      assert.equal(r.location?.searchParams.get('error'), 'invalid_request');
      assert.equal(r.location?.searchParams.get('code'), null);
    }
    // A redirect_uri the client did not register: no redirect at all, to anywhere.
    for (const redirect_uri of ['https://evil.example.net/cb', `${CALLBACK}/x`, 'https://connector.example.org/other']) {
      const r = await approve(a, { ...params, redirect_uri }, secret);
      assert.equal(r.status, 400);
      assert.equal(r.location, null);
      assert.equal((await fetch(`${a.url}/authorize?${new URLSearchParams({ ...params, redirect_uri })}`, { redirect: 'manual' })).status, 400);
    }
    // A token for another resource is not asked for here.
    assert.equal((await approve(a, { ...params, resource: 'https://other.example.org/mcp' }, secret)).location?.searchParams.get('error'), 'invalid_target');

    const fresh = async () => (await approve(a, params, secret)).location!.searchParams.get('code')!;
    // Redeemed twice: the second gets nothing, and what the first got is revoked.
    const c1 = await fresh();
    const first = await redeem(a, client, c1, v);
    assert.equal(first.status, 200);
    assert.equal((await mcp(a, first.body.access_token)).status, 200);
    assert.equal((await redeem(a, client, c1, v)).body.error, 'invalid_grant');
    assert.equal((await mcp(a, first.body.access_token)).status, 401, 'a replayed code revokes what it bought');
    // Redeemed by another client, or with the wrong verifier, or the wrong redirect_uri: nothing — and the code is spent.
    const other = (await register(a, { client_name: 'Other' })).body.client_id as string;
    for (const bad of [{ client_id: other }, { code_verifier: verifier() }, { redirect_uri: `${CALLBACK}/x` }, { code_verifier: '' }]) {
      const c = await fresh();
      const r = await redeem(a, client, c, v, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.access_token, undefined);
      assert.equal((await redeem(a, client, c, v)).status, 400, 'the code was spent by the failed try');
    }
    // A code older than its lifetime.
    const late = await fresh();
    a.clock.t += 31;
    assert.equal((await redeem(a, client, late, v)).body.error, 'invalid_grant');
    // Positive control: the same steps, done right, still give a token.
    assert.equal((await redeem(a, client, await fresh(), v)).status, 200);
  } finally { await a.stop(); }
});

test('a reused refresh token revokes its family, a revoked or expired access token gets 401, and an access token minted for another resource is refused', async () => {
  const dir = tmpDir('oauth-tokens');
  let a = await start(dir, 'node-a', { publicUrl: PUBLIC, oauth: OAUTH });
  const b = await start(tmpDir('oauth-tokens-b'), 'node-b', { publicUrl: 'https://other.example.org', oauth: OAUTH });
  try {
    // Refresh rotates; the old refresh token presented again ends the whole family.
    const g = await connect(a);
    const next = await tokenCall(a, { grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.client });
    assert.equal(next.status, 200);
    assert.notEqual(next.body.refresh_token, g.refresh);
    assert.equal((await mcp(a, next.body.access_token)).status, 200);
    // …only by the client it was issued to.
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: next.body.refresh_token, client_id: 'someone-else' })).status, 400);
    const replay = await tokenCall(a, { grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.client });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await mcp(a, next.body.access_token)).status, 401, 'the family\'s access token is revoked');
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: next.body.refresh_token, client_id: g.client })).status, 400, 'and its newest refresh token');
    const listed = (await post(a.url, '/op/oauth_grants', {})).body.grants as { revoked_at: string | null; revoked_why?: string }[];
    assert.equal(listed[0]!.revoked_why, 'refresh token reused');

    // Revoked by the owner: 401 at once, with the resource metadata to start again.
    const h = await connect(a);
    assert.equal((await mcp(a, h.access)).status, 200);
    const grant = ((await post(a.url, '/op/oauth_grants', {})).body.grants as { grant: string; revoked_at: string | null }[]).find((x) => !x.revoked_at)!.grant;
    assert.equal((await post(a.url, '/op/oauth_revoke', { grant })).status, 200);
    const revoked = await mcp(a, h.access);
    assert.equal(revoked.status, 401);
    assert.match(revoked.auth ?? '', /error="invalid_token"/);
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: h.refresh, client_id: h.client })).status, 400);
    // Only the owner lists and revokes.
    assert.equal((await post(a.url, '/op/oauth_grants', {}, { as: null })).status, 403);

    // Expired: 401 past its lifetime (50 ms on the injected clock).
    const e = await connect(a);
    assert.equal((await mcp(a, e.access)).status, 200);
    a.clock.t += 51;
    assert.equal((await mcp(a, e.access)).status, 401);

    // Minted for another resource: another server's token, and this node's own
    // token once the node answers at another address.
    const other = await connect(b);
    assert.equal((await mcp(b, other.access)).status, 200, 'positive control: it works where it was minted');
    assert.equal((await mcp(a, other.access)).status, 401);
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: other.refresh, client_id: other.client })).status, 400);
    const mine = await connect(a);
    await a.stop();
    const clock = a.clock;
    a = await start(dir, 'node-a', { publicUrl: 'https://moved.example.org', oauth: OAUTH, clock });
    assert.equal((await mcp(a, mine.access)).status, 401, 'a token for https://enox.example.org/mcp at https://moved.example.org');
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: mine.refresh, client_id: mine.client, resource: RESOURCE })).body.error, 'invalid_target');
    assert.equal((await tokenCall(a, { grant_type: 'refresh_token', refresh_token: mine.refresh, client_id: mine.client })).body.error, 'invalid_grant', 'its grant was for the old address');
  } finally { await a.stop(); await b.stop(); }
});

test('wrong secrets from one address lock that address only: the owner approves from another address meanwhile, and a forwarded address from a non-loopback peer is ignored', async () => {
  const a = await start(tmpDir('oauth-lockout'), 'node-a', { publicUrl: PUBLIC, oauth: { ...OAUTH, maxFailuresTotal: 12 } });
  const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
  const lan = lanIp ? createServer(a.node) : null;
  try {
    const secret = a.node.operatorToken();
    const client = (await register(a)).body.client_id as string;
    const params = authParams(client, verifier());
    // As nginx on this machine forwards them: the TCP peer is loopback, the address is in the headers.
    const from = (ip: string) => ({ 'x-real-ip': ip, 'x-forwarded-for': ip });
    const STRANGER = '198.51.100.7';
    const OWNER = '203.0.113.9';

    for (let i = 0; i < 3; i++) assert.equal((await approve(a, params, 'wrong', from(STRANGER))).status, 401);
    assert.equal((await approve(a, params, secret, from(STRANGER))).status, 429, 'the stranger\'s address is locked, even with the right secret');
    // Meanwhile the owner, at another address, approves.
    assert.equal((await approve(a, params, secret, from(OWNER))).status, 302);
    // A client-written X-Forwarded-For prefix does not move the stranger: the proxy's own last entry counts.
    assert.equal((await approve(a, params, secret, { 'x-forwarded-for': `${OWNER}, ${STRANGER}` })).status, 429);
    assert.equal((await approve(a, params, secret, { 'x-forwarded-for': `${STRANGER}, ${OWNER}` })).status, 302);

    // A forwarded address from a peer that is not loopback is that peer's claim, and ignored.
    assert.equal(sourceOf({ socket: { remoteAddress: '192.0.2.50' }, headers: from(OWNER) } as never), '192.0.2.50');
    assert.equal(sourceKey(sourceOf({ socket: { remoteAddress: '::ffff:192.0.2.50' }, headers: { 'x-forwarded-for': OWNER } } as never)), '192.0.2.50');
    assert.equal(sourceOf({ socket: { remoteAddress: '127.0.0.1' }, headers: from(OWNER) } as never), OWNER, 'positive control: from loopback it is trusted');
    assert.equal(sourceOf({ socket: { remoteAddress: '127.0.0.1' }, headers: {} } as never), '127.0.0.1');
    if (lan && lanIp) {
      // Live, over a real non-loopback socket: a peer at the LAN address that
      // claims fresh addresses is still counted as itself.
      const at = await listen(lan, 0, lanIp);
      for (let i = 0; i < 3; i++) assert.equal((await approve(at, params, 'wrong', from(`192.0.2.${i + 1}`))).status, 401);
      assert.equal((await approve(at, params, secret, from('192.0.2.99'))).status, 429, 'a forged forwarded address spends nobody else\'s allowance');
      assert.equal((await approve(a, params, secret, from('192.0.2.99'))).status, 302, 'and that address, really forwarded, is untouched');
    }

    // The node-wide ceiling: past it, an address that has failed may not try
    // again; a fresh one — the owner's — still may.
    for (let n = 0; n < 12; n++) assert.equal((await approve(a, params, 'wrong', from(`10.0.0.${n + 1}`))).status, 401);
    assert.equal((await approve(a, params, secret, from('10.0.0.1'))).status, 429, 'an address that failed is stopped at the ceiling');
    assert.equal((await approve(a, params, secret, from('10.9.9.9'))).status, 302, 'a fresh address is not');
    a.clock.t += 101;
    assert.equal((await approve(a, params, secret, from('10.0.0.1'))).status, 302, 'positive control: the window passed');
    assert.equal((await approve(a, params, secret, from(STRANGER))).status, 302, 'and the stranger\'s lock with it');
  } finally {
    if (lan?.listening) await new Promise<void>((r) => lan.close(() => r()));
    await a.stop();
  }
});

test('a hundred and one wrong secrets from distinct IPv6 addresses in one /64 lock that /64 only, and the owner at a fresh address still approves after any number of wrong secrets from other addresses', async () => {
  const a = await start(tmpDir('oauth-v6'), 'node-a', { publicUrl: PUBLIC, oauth: { ...OAUTH, maxFailuresTotal: 12 } });
  try {
    const secret = a.node.operatorToken();
    const client = (await register(a)).body.client_id as string;
    const params = authParams(client, verifier());
    const from = (ip: string) => ({ 'x-real-ip': ip });

    // 101 addresses of one /64, one wrong secret each: three are heard, then the /64 is locked.
    const got: number[] = [];
    for (let i = 1; i <= 101; i++) got.push((await approve(a, params, 'wrong', from(`2001:db8:1:1::${i.toString(16)}`))).status);
    assert.deepEqual([got.filter((x) => x === 401).length, got.filter((x) => x === 429).length], [3, 98]);
    assert.equal((await approve(a, params, secret, from('2001:db8:1:1:ffff:ffff:ffff:fffe'))).status, 429, 'the whole /64, even with the right secret');
    // …that /64 only: the neighbouring /64 and the owner's IPv4 are clean.
    assert.equal((await approve(a, params, secret, from('2001:db8:1:2::1'))).status, 302);
    assert.equal((await approve(a, params, secret, from('203.0.113.9'))).status, 302);
    // IPv4-mapped addresses stay IPv4 addresses, each its own.
    assert.equal(sourceKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(sourceKey('::ffff:c633:6407'), '198.51.100.7');
    assert.notEqual(sourceKey('::ffff:198.51.100.7'), sourceKey('::ffff:198.51.100.8'));
    assert.equal(sourceKey('2001:DB8:1:1:ffff::65'), sourceKey('2001:db8:1:1::1'));

    // Any number of wrong secrets from other addresses — far past the node-wide
    // ceiling, spread over 100 /64s and 100 IPv4 addresses — and the owner, at
    // an address of their own, still approves.
    for (let i = 0; i < 100; i++) {
      assert.notEqual((await approve(a, params, 'wrong', from(`2001:db8:${(i + 16).toString(16)}:1::1`))).status, 302);
      assert.notEqual((await approve(a, params, 'wrong', from(`10.1.${i >> 8}.${i & 255}`))).status, 302);
    }
    // The crowd is slowed: past the ceiling, an address that failed once is not heard again.
    assert.equal((await approve(a, params, secret, from('10.1.0.99'))).status, 429);
    assert.equal((await approve(a, params, secret, from('2001:db8:1000:1::1'))).status, 302, 'the owner, at a fresh IPv6 address');
    assert.equal((await approve(a, params, secret, from('192.0.2.200'))).status, 302, 'the owner, at a fresh IPv4 address');
  } finally { await a.stop(); }
});

test('a write over OAuth without asserted_by is claimed by the approved client\'s name, and every read tool shows asserted_by and claimed_by on that edge', async () => {
  // The wall clock: the embedder (below) signs with it. Lifetimes long enough not to matter.
  const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;
  const a = await start(tmpDir('oauth-claims'), 'node-a', { publicUrl: PUBLIC, oauth: { ...OAUTH, codeTtlMs: 600_000, accessTtlMs: 600_000, refreshTtlMs: 600_000 }, clock: wall });
  try {
    const { access } = await connect(a, 'Claude');
    let id = 0;
    const call = async (bearer: string, name: string, args: Record<string, unknown>) => {
      const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      const j = await r.json() as { result: { content: { text: string }[]; isError?: boolean } };
      assert.notEqual(j.result.isError, true, j.result.content[0]!.text);
      const text = j.result.content[0]!.text;
      try { return JSON.parse(text); } catch { return text; }
    };
    const w = await call(access, 'add_assertion', { source: 'Roflenox', target: 'Enox', relation: 'supersedes', context: 'a signed log replaces the database' });
    // Signed by the client's session identity (r_session_identity), claimed by the client.
    const session = a.node.sessionName(a.node.oauth.grantOf(access)!);
    assert.deepEqual([w.asserted_by, w.claimed_by], [session, 'Claude'], 'the write claims the approved client');
    // An author the caller names is its claim; the operator's own token claims "operator".
    const named = await call(access, 'add_assertion', { source: 'Roflenox', target: 'ROFL', relation: 'depends_on', asserted_by: 'agent:planner' });
    assert.equal(named.claimed_by, 'agent:planner');
    const op = await call(a.node.operatorToken(), 'remember', { subject: 'Roflenox', fact: 'Roflenox keeps every write as a signed batch' });
    assert.equal(op.claimed_by, 'operator');
    const blank = await call(access, 'add_assertion', { source: 'Enox', target: 'ROFL', relation: 'about', asserted_by: '  ' });
    assert.equal(blank.claimed_by, 'Claude', 'a blank author is no author');
    const both = (e: { asserted_by?: unknown; claimed_by?: unknown } | undefined, tool: string) =>
      assert.deepEqual([e?.asserted_by, e?.claimed_by], [session, 'Claude'], `${tool}: ${JSON.stringify(e)}`);
    const isIt = (e: { relation: string; target_name?: string; target?: string }) => e.relation === 'supersedes';

    const q = await call(access, 'query_graph', { node_id: w.source });
    both(q.outgoing.find(isIt), 'query_graph');
    const recent = await call(access, 'recent_activity', {}) as { relation: string }[];
    both(recent.find(isIt), 'recent_activity');
    const rec = await call(access, 'recall', { query: 'Roflenox' });
    both(rec.edges.find(isIt), 'recall');
    for (const [tool, args] of [['explore', { entity: 'Roflenox' }], ['traverse', { entity: 'Roflenox', max_depth: 1 }]] as const) {
      const text = await call(access, tool, args) as string;
      const line = text.split('\n').find((l) => l.includes('--[supersedes]--> Enox'));
      assert.ok(line?.includes(`[by ${session}, claims "Claude"]`), `${tool}: ${line}`);
    }
    // semantic_search, once an embedder has answered.
    const exDir = tmpDir('oauth-claims-e');
    const ex = identityAt(exDir, 'embedder');
    assert.equal((await post(a.url, '/identities', ex.identityChain(), { as: a.me, now: wall.t })).status, 200);
    await publish(a.url, a.me, [{ source: 'embedder', relation: 'roflenox:embedder', target: 'search', perspective: 'enox', confidence: 1 },
      grant('embedder', iso(Date.now() + DAY))]);
    assert.equal((await call(a.node.operatorToken(), 'semantic_search', { query: 'Roflenox supersedes Enox', include_edges: true })).index, 'pending');
    assert.equal(await answerSearches(a.url, ex, HASH), 1);
    const sem = await call(access, 'semantic_search', { query: 'Roflenox supersedes Enox', include_edges: true });
    both(sem.edges.find(isIt), 'semantic_search');
  } finally { await a.stop(); }
});
