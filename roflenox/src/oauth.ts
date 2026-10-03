// OAuth 2.1 for hosted MCP clients (r_mcp_oauth): the MCP authorization flow
// (2025-06-18) — RFC 9728 protected-resource metadata, RFC 8414 server
// metadata, RFC 7591 dynamic registration, authorization code with PKCE S256
// only, RFC 8707 resource binding, and a 401 naming resource_metadata. It is
// on only for a node with a public URL, and serves exactly one person: the
// owner. Anyone may register a client; nothing is granted until the owner
// types the operator secret on the authorize page.
//
// A token acts as the node's own identity, through a GRANT the owner lists and
// revokes (the oauth_grants / oauth_revoke operations). Access tokens are
// short-lived and bound to this node's /mcp; refresh tokens rotate on every
// use, and a refresh token presented twice revokes its whole grant. Tokens and
// codes are kept only as SHA-256 hashes: in <data>/oauth/state.json (0600,
// written atomically) and, for codes, in memory — a code lives at most a
// minute, so a restart simply voids the outstanding ones.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type * as http from 'node:http';
import * as path from 'node:path';

export interface OAuthOptions {
  /** How long a code may wait to be redeemed (ms; at most, and default, 60 s). */
  codeTtlMs?: number;
  /** Access token lifetime (ms; default 1 h). */
  accessTtlMs?: number;
  /** Refresh token lifetime (ms; default 30 days). */
  refreshTtlMs?: number;
  /** Wrong secrets one source address may send per window before the page
   *  refuses its every try (default 5 per 15 min; r_oauth_lockout). */
  maxFailures?: number;
  /** Wrong secrets from all sources together per window (default 100). Past
   *  it, a source that has failed in the window may not try again; a source
   *  with no failure of its own is never refused, so no crowd locks out the owner. */
  maxFailuresTotal?: number;
  /** Sources remembered at most (default 10000); the oldest is forgotten first. */
  maxSources?: number;
  failWindowMs?: number;
  /** Registered clients kept (default 100); the oldest with no grant makes room. */
  maxClients?: number;
}

interface Client { name: string; redirect_uris: string[]; created_at: string }
interface Grant { client_id: string; redirect_uri: string; resource: string; created_at: string; revoked_at: string | null; revoked_why?: string }
interface State {
  clients: Record<string, Client>;
  grants: Record<string, Grant>;
  /** token hash → its grant, expiry (ms) and audience. */
  access: Record<string, { grant: string; exp: number; aud: string }>;
  /** token hash → its grant and expiry; `used` once rotated, kept to catch a replay. */
  refresh: Record<string, { grant: string; exp: number; used: boolean }>;
}
interface Code { client_id: string; redirect_uri: string; challenge: string; exp: number; grant: string | null }

const MINUTE = 60_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const token = (kind: string) => `rfx_${kind}_${crypto.randomBytes(32).toString('base64url')}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const empty = (): State => ({ clients: {}, grants: {}, access: {}, refresh: {} });

export class OAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, description: string) { super(description); this.status = status; this.code = code; }
}

export class OAuth {
  /** https://host/mcp — what every token is minted for; null: OAuth is off. */
  readonly resource: string | null;
  readonly issuer: string | null;
  private readonly file: string;
  private readonly now: () => number;
  private readonly secret: () => string;
  private readonly codeTtl: number;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly maxFailures: number;
  private readonly maxFailuresTotal: number;
  private readonly maxSources: number;
  private readonly failWindow: number;
  private readonly maxClients: number;
  private state: State;
  /** code hash → its binding. Redeemed codes stay (grant set) until they expire, to catch a replay. */
  private readonly codes = new Map<string, Code>();
  /** Wrong secrets in the window: source (sourceKey) → times; at most maxSources of them. */
  private readonly failures = new Map<string, number[]>();
  readonly warnings: string[] = [];

  constructor(dataDir: string, publicOrigin: string | null, secret: () => string, now: () => number, o: OAuthOptions = {}) {
    this.issuer = publicOrigin;
    this.resource = publicOrigin ? `${publicOrigin}/mcp` : null;
    this.file = path.join(dataDir, 'oauth', 'state.json');
    this.secret = secret;
    this.now = now;
    this.codeTtl = Math.min(o.codeTtlMs ?? MINUTE, MINUTE);
    this.accessTtl = o.accessTtlMs ?? 60 * MINUTE;
    this.refreshTtl = o.refreshTtlMs ?? 30 * 24 * 60 * MINUTE;
    this.maxFailures = o.maxFailures ?? 5;
    this.maxFailuresTotal = o.maxFailuresTotal ?? 100;
    this.maxSources = o.maxSources ?? 10_000;
    this.failWindow = o.failWindowMs ?? 15 * MINUTE;
    this.maxClients = o.maxClients ?? 100;
    this.state = empty();
    if (fs.existsSync(this.file)) {
      try { this.state = { ...empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch {
        // Losing this file revokes every grant; it never grants anything.
        this.warnings.push('oauth state unreadable: every OAuth grant is void and clients must connect again');
      }
    }
  }

  private save(): void {
    const t = this.now();
    for (const [h, a] of Object.entries(this.state.access)) if (a.exp <= t) delete this.state.access[h];
    for (const [h, r] of Object.entries(this.state.refresh)) if (r.exp <= t) delete this.state.refresh[h];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const d = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  }

  // ---- metadata --------------------------------------------------------------

  /** RFC 9728: where this resource's tokens come from. */
  resourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] };
  }

  /** RFC 8414. */
  serverMetadata() {
    const i = this.issuer!;
    return {
      issuer: i, authorization_endpoint: `${i}/authorize`, token_endpoint: `${i}/token`, registration_endpoint: `${i}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** The WWW-Authenticate of a 401 at /mcp. */
  challenge(invalid: boolean): string {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource/mcp"${invalid ? ', error="invalid_token"' : ''}`;
  }

  // ---- registration (RFC 7591) -----------------------------------------------

  register(body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris: one to five URIs');
    for (const u of uris) {
      let url: URL;
      try { url = new URL(u as string); } catch { throw new OAuthError(400, 'invalid_redirect_uri', 'a redirect URI is not a URL'); }
      const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !loopback) || url.hash || (u as string).length > 2000) {
        throw new OAuthError(400, 'invalid_redirect_uri', 'a redirect URI is https (or http on loopback) with no fragment');
      }
    }
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : 'unnamed client';
    const ids = Object.keys(this.state.clients);
    if (ids.length >= this.maxClients) {
      const held = new Set(Object.values(this.state.grants).filter((g) => !g.revoked_at).map((g) => g.client_id));
      const spare = ids.filter((id) => !held.has(id)).sort((x, y) => this.state.clients[x]!.created_at.localeCompare(this.state.clients[y]!.created_at))[0];
      if (!spare) throw new OAuthError(429, 'too_many_clients', 'no room for another client');
      delete this.state.clients[spare];
    }
    const id = crypto.randomBytes(16).toString('base64url');
    const at = this.now();
    this.state.clients[id] = { name, redirect_uris: uris as string[], created_at: new Date(at).toISOString() };
    this.save();
    return {
      client_id: id, client_id_issued_at: Math.floor(at / 1000), client_name: name, redirect_uris: uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    };
  }

  // ---- authorize -------------------------------------------------------------

  /** The client and redirect_uri of an authorization request, or an error to
   *  SHOW (never redirect to an unverified URI). */
  private checkClient(q: URLSearchParams): { client: Client; redirect: string } {
    const client = this.state.clients[q.get('client_id') ?? ''];
    if (!client) throw new OAuthError(400, 'invalid_client', 'this client is not registered here');
    const asked = q.get('redirect_uri');
    const redirect = asked ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : '');
    if (!client.redirect_uris.includes(redirect)) throw new OAuthError(400, 'invalid_request', 'redirect_uri is not one this client registered');
    return { client, redirect };
  }

  /** What is wrong with the rest of the request, sent back to the client. */
  private checkRequest(q: URLSearchParams): string | null {
    if (q.get('response_type') !== 'code') return 'unsupported_response_type';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '')) return 'invalid_request';
    const r = q.get('resource');
    if (r !== null && !this.isResource(r)) return 'invalid_target';
    return null;
  }

  private isResource(r: string): boolean {
    return r === this.resource || r === `${this.resource}/`;
  }

  private back(redirect: string, q: URLSearchParams, p: Record<string, string>): string {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    if (q.get('state') !== null) u.searchParams.set('state', q.get('state')!);
    u.searchParams.set('iss', this.issuer!);
    return u.toString();
  }

  /** GET /authorize: the page, or where to send the client back with an error. */
  authorizePage(q: URLSearchParams): { status: number; html?: string; location?: string } {
    const { client, redirect } = this.checkClient(q);
    const bad = this.checkRequest(q);
    if (bad) return { status: 302, location: this.back(redirect, q, { error: bad }) };
    return { status: 200, html: this.page(client, redirect, q, null) };
  }

  /** POST /authorize: the owner's answer, from the address `from` (see
   *  sourceOf). A code only for the right secret. */
  approve(form: URLSearchParams, from: string): { status: number; html?: string; location?: string } {
    const source = sourceKey(from);
    const { client, redirect } = this.checkClient(form);
    const bad = this.checkRequest(form);
    if (bad) return { status: 302, location: this.back(redirect, form, { error: bad }) };
    const t = this.now();
    let total = 0;
    for (const [src, times] of this.failures) {
      const live = times.filter((f) => f > t - this.failWindow);
      if (live.length) { this.failures.set(src, live); total += live.length; } else this.failures.delete(src);
    }
    // Wrong secrets lock out the source that sent them, not the owner at
    // another one. Past the node-wide ceiling a source that has failed may
    // not try again, but a clean one always may (r_oauth_lockout).
    const mine = this.failures.get(source)?.length ?? 0;
    if (mine >= this.maxFailures || (mine > 0 && total >= this.maxFailuresTotal)) {
      return { status: 429, html: this.page(client, redirect, form, 'Too many wrong secrets. Try again later.') };
    }
    if (form.get('decision') === 'deny') return { status: 302, location: this.back(redirect, form, { error: 'access_denied' }) };
    // Both sides hashed first: equal lengths, and the time spent says nothing about the secret.
    const given = crypto.createHash('sha256').update(form.get('secret') ?? '').digest();
    const want = crypto.createHash('sha256').update(this.secret()).digest();
    if (!crypto.timingSafeEqual(given, want)) {
      if (!this.failures.has(source) && this.failures.size >= this.maxSources) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(source, [...(this.failures.get(source) ?? []), t]);
      return { status: 401, html: this.page(client, redirect, form, 'Not approved: that is not the operator secret.') };
    }
    const code = token('code');
    this.codes.set(sha(code), { client_id: form.get('client_id')!, redirect_uri: redirect, challenge: form.get('code_challenge')!, exp: t + this.codeTtl, grant: null });
    return { status: 302, location: this.back(redirect, form, { code }) };
  }

  private page(client: Client, redirect: string, q: URLSearchParams, note: string | null): string {
    const keep = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']
      .filter((k) => q.get(k) !== null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(k === 'redirect_uri' ? redirect : q.get(k)!)}">`).join('\n');
    const host = new URL(redirect).host;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve connection</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
code,b{word-break:break-all}.note{color:#a40000}input[type=password]{width:100%;font:inherit;padding:.4rem}button{font:inherit;padding:.4rem 1rem;margin:.6rem .4rem 0 0}</style></head>
<body>
<h1>Approve connection</h1>
<p><b>${esc(client.name)}</b> asks to use this node's MCP endpoint as its owner.</p>
<p>If you approve, you are sent back to <b>${esc(host)}</b><br><code>${esc(redirect)}</code></p>
<p>Approve only if you started this connection yourself and you know that address.</p>
${note ? `<p class="note">${esc(note)}</p>` : ''}
<form method="post" action="/authorize">
${keep}
<label>Operator secret (print it on the node's machine with <code>roflenox operator_token</code>)<br>
<input type="password" name="secret" autocomplete="off" autofocus></label><br>
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>
`;
  }

  // ---- token -----------------------------------------------------------------

  token(form: URLSearchParams) {
    const r = form.get('resource');
    if (r !== null && !this.isResource(r)) throw new OAuthError(400, 'invalid_target', 'this server issues tokens only for its own /mcp');
    if (form.get('grant_type') === 'authorization_code') return this.redeem(form);
    if (form.get('grant_type') === 'refresh_token') return this.rotate(form);
    throw new OAuthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  }

  private redeem(form: URLSearchParams) {
    const t = this.now();
    for (const [h, c] of this.codes) if (c.exp <= t) this.codes.delete(h);
    const h = sha(form.get('code') ?? '');
    const c = this.codes.get(h);
    const invalid = () => new OAuthError(400, 'invalid_grant', 'the code is unknown, expired, used, or not this client\'s');
    if (!c) throw invalid();
    if (c.grant !== null) {
      // A code presented twice: whatever it bought is revoked (RFC 6749 §4.1.2).
      this.revoke(c.grant, 'authorization code replayed');
      throw invalid();
    }
    // Any attempt spends the code: a thief who tries it first leaves the owner nothing to lose but a retry.
    c.grant = '';
    const verifier = form.get('code_verifier') ?? '';
    const pkce = /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && crypto.createHash('sha256').update(verifier).digest('base64url') === c.challenge;
    if (form.get('client_id') !== c.client_id || form.get('redirect_uri') !== c.redirect_uri || !pkce || !this.state.clients[c.client_id]) throw invalid();
    const grant = crypto.randomBytes(12).toString('base64url');
    this.state.grants[grant] = { client_id: c.client_id, redirect_uri: c.redirect_uri, resource: this.resource!, created_at: new Date(t).toISOString(), revoked_at: null };
    c.grant = grant;
    return this.issue(grant);
  }

  private rotate(form: URLSearchParams) {
    const r = this.state.refresh[sha(form.get('refresh_token') ?? '')];
    const invalid = () => new OAuthError(400, 'invalid_grant', 'the refresh token is unknown, expired or revoked');
    if (!r || r.exp <= this.now()) throw invalid();
    const g = this.state.grants[r.grant];
    // A grant is for the resource it was approved for: a node that moved mints nothing on it.
    if (!g || g.revoked_at || g.resource !== this.resource) throw invalid();
    if (form.get('client_id') !== g.client_id) throw invalid();
    if (r.used) {
      this.revoke(r.grant, 'refresh token reused');
      throw invalid();
    }
    r.used = true;
    return this.issue(r.grant);
  }

  private issue(grant: string) {
    const t = this.now();
    const access = token('at');
    const refresh = token('rt');
    this.state.access[sha(access)] = { grant, exp: t + this.accessTtl, aud: this.resource! };
    this.state.refresh[sha(refresh)] = { grant, exp: t + this.refreshTtl, used: false };
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.ceil(this.accessTtl / 1000), refresh_token: refresh, scope: 'mcp' };
  }

  /** Whether an access token admits a call to this node's /mcp now. */
  admits(presented: string): boolean {
    const a = this.state.access[sha(presented)];
    if (!a || a.exp <= this.now() || a.aud !== this.resource || this.resource === null) return false;
    const g = this.state.grants[a.grant];
    return !!g && !g.revoked_at;
  }

  /** The name of the client an admitted access token was issued to — the
   *  client the owner approved — or null for any other token (r_claimed_author). */
  clientOf(presented: string): string | null {
    if (!this.admits(presented)) return null;
    const g = this.state.grants[this.state.access[sha(presented)]!.grant]!;
    return this.state.clients[g.client_id]?.name ?? null;
  }

  // ---- the owner's view ------------------------------------------------------

  grants() {
    const t = this.now();
    return Object.entries(this.state.grants).map(([id, g]) => ({
      grant: id, client: this.state.clients[g.client_id]?.name ?? null, client_id: g.client_id,
      redirect_host: new URL(g.redirect_uri).host, created_at: g.created_at,
      revoked_at: g.revoked_at, ...(g.revoked_why ? { revoked_why: g.revoked_why } : {}),
      live_access_tokens: Object.values(this.state.access).filter((a) => a.grant === id && a.exp > t).length,
    }));
  }

  /** End a grant: every token it issued stops at once. */
  revoke(grant: string, why = 'revoked by the owner'): boolean {
    const g = this.state.grants[grant];
    if (!g) return false;
    if (!g.revoked_at) { g.revoked_at = new Date(this.now()).toISOString(); g.revoked_why = why; }
    for (const [h, a] of Object.entries(this.state.access)) if (a.grant === grant) delete this.state.access[h];
    for (const [h, r] of Object.entries(this.state.refresh)) if (r.grant === grant) delete this.state.refresh[h];
    this.save();
    return true;
  }
}

// ---- HTTP ------------------------------------------------------------------

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version' };

function reply(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra });
  res.end(text);
}

function form(req: http.IncomingMessage, raw: Buffer | null): URLSearchParams {
  const text = raw?.toString('utf8') ?? '';
  if (String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    try { return new URLSearchParams(Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => [k, String(v)])); } catch { return new URLSearchParams(); }
  }
  return new URLSearchParams(text);
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** Where a request on the authorize page comes from, for counting wrong
 *  secrets (r_oauth_lockout): the peer socket's address — or, when that peer
 *  is loopback (a proxy on this machine), the address the proxy reports:
 *  X-Real-IP, else the LAST X-Forwarded-For entry (the one the proxy itself
 *  appended; earlier ones are the client's to write). A forwarded address from
 *  any other peer is the client's own claim, and ignored. */
export function sourceOf(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.includes(peer)) return peer;
  const real = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  const reported = typeof real === 'string' && real.trim() ? real.trim()
    : typeof fwd === 'string' && fwd.trim() ? fwd.split(',').pop()!.trim() : '';
  return reported ? reported.slice(0, 64) : peer;
}

/** What wrong secrets are counted against: an IPv4 address as itself (an
 *  IPv4-mapped IPv6 address too), an IPv6 address as its /64 — one party
 *  holds a whole /64 (r_oauth_lockout). Anything else, as written. */
export function sourceKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, '');
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return a;
  let s = a;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    s = `${s.slice(0, -v4[0].length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const x = [...h, ...Array(tail === undefined ? 0 : 8 - h.length - t.length).fill('0'), ...t].map((p) => parseInt(p, 16));
  if (x.slice(0, 5).every((v) => v === 0) && x[5] === 0xffff) return [x[6]! >> 8, x[6]! & 255, x[7]! >> 8, x[7]! & 255].join('.');
  return `${x.slice(0, 4).map((v) => v.toString(16)).join(':')}::/64`;
}

/** Serve an OAuth route; false if `p` is not one. */
export function serveOAuth(oauth: OAuth, req: http.IncomingMessage, res: http.ServerResponse, url: URL, raw: Buffer | null): boolean {
  const p = url.pathname;
  const method = req.method ?? 'GET';
  const routes = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/register', '/authorize', '/token'];
  if (!routes.includes(p)) return false;
  if (method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST' }).end(); return true; }
  try {
    if (p.startsWith('/.well-known/oauth-protected-resource') && method === 'GET') reply(res, 200, oauth.resourceMetadata());
    else if (p === '/.well-known/oauth-authorization-server' && method === 'GET') reply(res, 200, oauth.serverMetadata());
    else if (p === '/register' && method === 'POST') {
      let body: unknown;
      try { body = JSON.parse(raw?.toString('utf8') ?? ''); } catch { throw new OAuthError(400, 'invalid_client_metadata', 'the body is not JSON'); }
      reply(res, 201, oauth.register(body));
    } else if (p === '/authorize' && (method === 'GET' || method === 'POST')) {
      const r = method === 'GET' ? oauth.authorizePage(url.searchParams) : oauth.approve(form(req, raw), sourceOf(req));
      if (r.location) res.writeHead(302, { location: r.location, 'cache-control': 'no-store' }).end();
      else res.writeHead(r.status, HTML_HEADERS).end(r.html);
    } else if (p === '/token' && method === 'POST') reply(res, 200, oauth.token(form(req, raw)), { pragma: 'no-cache' });
    else reply(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    if (!(e instanceof OAuthError)) throw e;
    if (p === '/authorize') {
      res.writeHead(e.status, HTML_HEADERS).end(`<!doctype html><title>Cannot approve</title><p>${esc(e.message)}</p>\n`);
    } else reply(res, e.status, { error: e.code, error_description: e.message });
  }
  return true;
}
