// HTTP, GENERATED from the operation table (src/ops.ts): POST /op/<name> for
// every operation that is not local-only, each op's wire alias, and the MCP
// transport at /mcp — and, behind a public URL, the OAuth routes of
// src/oauth.ts. There is no other route. JSON in, JSON out; a refusal is
// {error: <reason>, message, ...detail} with the refusal's status.
//
// Who is calling: an RFC 9421 signature (any identity), or the operator's
// bearer token (the node's own identity), or at /mcp an OAuth access token
// (the node's own identity, through a grant), or nobody. A credential that is
// present but wrong is a 401, never an anonymous call.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { Refusal } from './facts.ts';
import { handleRpc } from './mcp.ts';
import { serveOAuth } from './oauth.ts';
import { callOp, isLocal, OPS, type Ctx, type Op } from './ops.ts';
import type { RoflenoxNode } from './node.ts';

const MAX_BODY = 16 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((ok, no) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (b: Buffer) => {
      n += b.length;
      if (n > MAX_BODY) { no(new Refusal(413, 'too_large', `a body is at most ${MAX_BODY} bytes`)); req.destroy(); return; }
      parts.push(b);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}

function json(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new Refusal(400, 'malformed_body', 'the body is not JSON'); }
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The URIs a request may have been signed for (RFC 9421 @target-uri): only
 *  the node's own addresses. Without a public URL, the Host it was sent to.
 *  With one (behind a proxy), that origin — never the scheme or Host a proxy
 *  hands us — and, for a request from this machine that arrived on a
 *  loopback socket, not through a proxy, and names that socket's own address,
 *  the local origin too:
 *  the host's own tools sign for 127.0.0.1:<port> (r_public_url_local). */
export function targetsOf(node: RoflenoxNode, req: http.IncomingMessage): string[] {
  const p = req.url ?? '/';
  if (!node.publicUrl) return [`http://${req.headers.host}${p}`];
  const out = [`${node.publicUrl}${p}`];
  const s = req.socket;
  const host = (req.headers.host ?? '').toLowerCase();
  const proxied = Object.keys(req.headers).some((h) => h === 'forwarded' || h.startsWith('x-forwarded-'));
  if (!proxied && LOOPBACK.includes(s.localAddress ?? '') && LOOPBACK.includes(s.remoteAddress ?? '')
    && [`127.0.0.1:${s.localPort}`, `localhost:${s.localPort}`, `[::1]:${s.localPort}`].includes(host)) out.push(`http://${host}${p}`);
  return out;
}

/** Who is calling. At /mcp (`mcp`), a bearer token may also be an OAuth
 *  access token minted for this node's /mcp: it acts as the node's own
 *  identity through its grant (r_mcp_oauth). Nowhere else. */
export function callerOf(node: RoflenoxNode, method: string, target: string | readonly string[], headers: http.IncomingHttpHeaders, raw: Buffer | null, mcp = false): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const presented = auth.slice('Bearer '.length).trim();
    const given = Buffer.from(presented);
    const want = Buffer.from(node.operatorToken());
    const operator = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!node.identity || !(operator || (mcp && node.oauth.admits(presented)))) {
      throw new Refusal(401, 'bad_token', 'the bearer token is not this node\'s operator token or a live token for its MCP endpoint');
    }
    return node.identity.name;
  }
  return node.authenticate(method, target, headers, raw);
}

/** The OAuth client an /mcp bearer token was issued to (its approved name),
 *  or null: the operator token, a signature, or nobody (r_claimed_author). */
function clientOf(node: RoflenoxNode, headers: http.IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? node.oauth.clientOf(auth.slice('Bearer '.length).trim()) : null;
}

/** The OAuth grant an /mcp bearer token belongs to: the session whose
 *  identity signs its writes (r_session_identity); null for any other caller. */
function sessionOf(node: RoflenoxNode, headers: http.IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? node.oauth.grantOf(auth.slice('Bearer '.length).trim()) : null;
}

/** Match an op's alias path; `:x` segments become args. */
function matchAlias(op: Op, method: string, path: string): Record<string, string> | null {
  if (!op.http || op.http.method !== method) return null;
  const want = op.http.path.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const args: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(':')) args[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
    else if (want[i] !== got[i]) return null;
  }
  return args;
}

export function createServer(node: RoflenoxNode): http.Server {
  const network = OPS.filter((o) => !isLocal(o));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const p = url.pathname;
      const method = req.method ?? 'GET';
      const target = targetsOf(node, req);
      const raw = method === 'POST' ? await readRaw(req) : null;
      const ctx = (caller: string | null, agent: string | null = null, session: string | null = null): Ctx => ({
        node, caller, dataDir: null, now: () => Date.now(), agent, session,
        call: (op, args) => callOp(op, args, ctx(caller, agent, session), 'network'),
      });

      if (node.publicUrl && serveOAuth(node.oauth, req, res, url, raw)) return;

      if (p === '/mcp') {
        if (method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'POST JSON-RPC; no SSE stream is offered' });
        // Behind a public URL, /mcp answers only a proven caller; the 401 says
        // where to get a token (RFC 9728), so a hosted client can start OAuth.
        let caller: string | null;
        try { caller = callerOf(node, method, target, req.headers, raw, true); } catch (e) {
          if (e instanceof Refusal && e.status === 401 && node.publicUrl) {
            return send(res, 401, { error: e.reason, message: e.message }, { 'www-authenticate': node.oauth.challenge(true) });
          }
          throw e;
        }
        if (caller === null && node.publicUrl) {
          return send(res, 401, { error: 'unauthenticated', message: 'this endpoint needs a bearer token or a signed request' }, { 'www-authenticate': node.oauth.challenge(false) });
        }
        let msg: unknown;
        try { msg = JSON.parse(raw!.toString('utf8')); } catch {
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        const agent = clientOf(node, req.headers);
        const session = sessionOf(node, req.headers);
        const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map((m) => handleRpc(ctx(caller, agent, session), m, 'network')))).filter((r) => r !== null);
        if (replies.length === 0) { res.writeHead(202).end(); return; }
        return send(res, 200, Array.isArray(msg) ? replies : replies[0]);
      }

      let op: Op | undefined;
      let args: Record<string, unknown> = {};
      if (method === 'POST' && p.startsWith('/op/')) {
        op = network.find((o) => o.name === p.slice('/op/'.length));
        if (op) args = json(raw!) as Record<string, unknown>;
      } else {
        for (const o of network) {
          const m = matchAlias(o, method, p);
          if (!m) continue;
          op = o;
          if (method === 'GET') for (const [k, v] of url.searchParams) args[k] = v;
          const body = raw && raw.length ? json(raw) : {};
          args = { ...(o.http!.body ? { [o.http!.body]: body } : body as Record<string, unknown>), ...args, ...m };
          break;
        }
      }
      if (!op) return send(res, 404, { error: 'not_found', message: `${method} ${p}` });
      const caller = callerOf(node, method, target, req.headers, raw);
      const result = await callOp(op.name, args, ctx(caller), 'network');
      return send(res, op.http && !p.startsWith('/op/') ? op.http.status ?? 200 : 200, result);
    } catch (e) {
      if (e instanceof Refusal) return send(res, e.status, { error: e.reason, message: e.message, ...e.detail });
      return send(res, 500, { error: 'internal', message: (e as Error).message });
    }
  });
}

export function listen(server: http.Server, port: number, host = '127.0.0.1'): Promise<string> {
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => {
      const a = server.address() as { port: number };
      ok(`http://${host}:${a.port}`);
    });
  });
}
