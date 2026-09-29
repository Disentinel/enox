// OAuth for hosted MCP clients (r_mcp_oauth): a claude.ai-style connector
// registers itself, the owner approves on the authorize page with the operator
// secret, and the token it gets reaches /mcp — and nothing else, and no one else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { post, start, tmpDir, type Running } from './helpers.ts';

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
async function approve(a: Running, params: Record<string, string>, secret: string | null) {
  const f = new URLSearchParams({ ...params, decision: 'approve', ...(secret === null ? {} : { secret }) });
  const r = await fetch(`${a.url}/authorize`, { method: 'POST', body: f, redirect: 'manual' });
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
    for (const secretish of [a.dir, os.homedir(), os.userInfo().username, os.hostname(), 'operator-token', 'key/', a.node.operatorToken()]) {
      assert.ok(!html.includes(secretish), `the authorize page shows ${secretish}`);
    }

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
    // As the owner: an operator-only tool answers.
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'oauth_grants', arguments: {} } }) });
    const grants = JSON.parse(((await r.json()) as any).result.content[0].text).grants;
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
