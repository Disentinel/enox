// HTTP surface (spec item 7). JSON in, JSON out; a refusal is
// {error: <reason>, message} with the refusal's status.
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { Refusal } from './facts.ts';
import { handleRpc } from './mcp.ts';
import type { RoflenoxNode } from './node.ts';

const MAX_BODY = 16 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return readRaw(req).then((raw) => {
    try { return JSON.parse(raw.toString('utf8')); } catch {
      throw new Refusal(400, 'malformed_body', 'the body is not JSON');
    }
  });
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

/** Who is calling the MCP endpoint: the operator by bearer token (constant-
 *  time compare), an identity by RFC 9421 signature, or nobody. A bearer that
 *  is present but wrong is a 401, never an anonymous call. */
function mcpCaller(node: RoflenoxNode, target: string, headers: http.IncomingHttpHeaders, raw: Buffer): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const given = Buffer.from(auth.slice('Bearer '.length).trim());
    const want = Buffer.from(node.operatorToken());
    if (!node.identity || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new Refusal(401, 'bad_token', 'the bearer token is not this node\'s operator token');
    }
    return node.identity.name;
  }
  return node.authenticate('POST', target, headers, raw);
}

export function createServer(node: RoflenoxNode): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const p = url.pathname;
      // The URI the client signed (RFC 9421 @target-uri): the configured public
      // origin plus the path — never the scheme or Host a proxy hands us.
      const target = `${node.publicUrl ?? `http://${req.headers.host}`}${req.url}`;
      if (req.method === 'GET' && p === '/.well-known/roflenox/identity') {
        if (!node.identity) return send(res, 404, { error: 'no_identity', message: 'this node has no identity; run init' });
        return send(res, 200, node.identity.identityChain());
      }
      if (req.method === 'GET' && p === '/health') return send(res, 200, node.health());
      if (req.method === 'POST' && p === '/batches') {
        const r = await node.admit((await readBody(req)) as never);
        return send(res, 201, { admitted: true, receipt: r });
      }
      if (req.method === 'GET' && p === '/intents') {
        const who = node.authenticate('GET', target, req.headers, null);
        return send(res, 200, await node.intents(url.searchParams.get('kind') ?? '', who, Math.min(1000, Number(url.searchParams.get('limit') ?? 100))));
      }
      if (req.method === 'POST' && p === '/sealed') return send(res, 201, { admitted: true, receipt: await node.admitSealed(await readBody(req)) });
      if (req.method === 'POST' && p === '/challenges') return send(res, 201, { nonce: node.issueChallenge() });
      if (req.method === 'POST' && p === '/feeds/admit') {
        return send(res, 201, await node.admitFeed((await readBody(req)) as never));
      }
      if (req.method === 'POST' && p === '/identities') return send(res, 200, await node.introduce(await readBody(req)));
      if (req.method === 'GET' && p.startsWith('/identities/')) {
        return send(res, 200, node.identityChain(decodeURIComponent(p.slice('/identities/'.length))));
      }
      if (req.method === 'GET' && p.startsWith('/feeds/')) {
        const id = decodeURIComponent(p.slice('/feeds/'.length));
        const reader = node.authenticate('GET', target, req.headers, null);
        return send(res, 200, await node.feed(id, url.searchParams.get('after'), url.searchParams.get('challenge'), reader));
      }
      if (p === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'POST JSON-RPC; no SSE stream is offered' });
        const raw = await readRaw(req);
        const caller = mcpCaller(node, target, req.headers, raw);
        let msg: unknown;
        try { msg = JSON.parse(raw.toString('utf8')); } catch {
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map((m) => handleRpc(node, m, caller)))).filter((r) => r !== null);
        if (replies.length === 0) { res.writeHead(202).end(); return; }
        return send(res, 200, Array.isArray(msg) ? replies : replies[0]);
      }
      if (req.method === 'POST' && p === '/ask') {
        const raw = await readRaw(req);
        const who = node.authenticate('POST', target, req.headers, raw);
        let b: { query?: string; why?: string; whynot?: string; perspective?: string };
        try { b = JSON.parse(raw.toString('utf8')); } catch { throw new Refusal(400, 'malformed_body', 'the body is not JSON'); }
        if (typeof b.why === 'string') return send(res, 200, { why: await node.why(b.why, who) });
        if (typeof b.whynot === 'string') return send(res, 200, { whynot: await node.whynot(b.whynot, who) });
        if (typeof b.query === 'string') return send(res, 200, await node.ask(b.query, who, typeof b.perspective === 'string' ? b.perspective : null));
        return send(res, 400, { error: 'bad_query', message: 'the body is {query} or {why} or {whynot}' });
      }
      return send(res, 404, { error: 'not_found', message: `${req.method} ${p}` });
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
