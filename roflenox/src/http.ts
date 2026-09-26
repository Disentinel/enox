// HTTP, GENERATED from the operation table (src/ops.ts): POST /op/<name> for
// every operation that is not local-only, each op's wire alias, and the MCP
// transport at /mcp. There is no other route. JSON in, JSON out; a refusal is
// {error: <reason>, message, ...detail} with the refusal's status.
//
// Who is calling: an RFC 9421 signature (any identity), or the operator's
// bearer token (the node's own identity), or nobody. A credential that is
// present but wrong is a 401, never an anonymous call.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { Refusal } from './facts.ts';
import { handleRpc } from './mcp.ts';
import { callOp, isLocal, OPS, type Ctx, type Op } from './ops.ts';
import type { RoflenoxNode } from './node.ts';

const MAX_BODY = 16 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
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

/** Who is calling. */
export function callerOf(node: RoflenoxNode, method: string, target: string, headers: http.IncomingHttpHeaders, raw: Buffer | null): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const given = Buffer.from(auth.slice('Bearer '.length).trim());
    const want = Buffer.from(node.operatorToken());
    if (!node.identity || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new Refusal(401, 'bad_token', 'the bearer token is not this node\'s operator token');
    }
    return node.identity.name;
  }
  return node.authenticate(method, target, headers, raw);
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
      // The URI the client signed (RFC 9421 @target-uri): the configured public
      // origin plus the path — never the scheme or Host a proxy hands us.
      const target = `${node.publicUrl ?? `http://${req.headers.host}`}${req.url}`;
      const raw = method === 'POST' ? await readRaw(req) : null;
      const ctx = (caller: string | null): Ctx => ({
        node, caller, dataDir: null, now: () => Date.now(),
        call: (op, args) => callOp(op, args, ctx(caller), 'network'),
      });

      if (p === '/mcp') {
        if (method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'POST JSON-RPC; no SSE stream is offered' });
        const caller = callerOf(node, method, target, req.headers, raw);
        let msg: unknown;
        try { msg = JSON.parse(raw!.toString('utf8')); } catch {
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map((m) => handleRpc(ctx(caller), m, 'network')))).filter((r) => r !== null);
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
