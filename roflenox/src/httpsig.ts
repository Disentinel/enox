// HTTP Message Signatures (RFC 9421), the minimal profile a roflenox request
// needs: one signature `sig1`, Ed25519, covering
//   "@method" "@target-uri"            always
//   "content-digest"                   when there is a body (RFC 9530, sha-256)
// with parameters created, nonce, keyid (the signer's key_id) and alg.
//
// There are no sessions: every request carries its own proof, and a nonce
// seen inside the window is refused, so a captured request cannot be replayed.
import * as crypto from 'node:crypto';
import { Refusal } from './facts.ts';
import type { KeyEntry, LocalIdentity } from './identity.ts';

export function contentDigest(body: string | Buffer): string {
  return `sha-256=:${crypto.createHash('sha256').update(body).digest('base64')}:`;
}

function base(components: string[], values: Record<string, string>, params: string): string {
  return [...components.map((c) => `"${c}": ${values[c]}`), `"@signature-params": ${params}`].join('\n');
}

/** Headers that sign a request as `me`. `uri` is exactly the URL requested. */
export function signRequest(me: LocalIdentity, method: string, uri: string, body: string | null, nowMs: number): Record<string, string> {
  const headers: Record<string, string> = {};
  const values: Record<string, string> = { '@method': method.toUpperCase(), '@target-uri': uri };
  const components = ['@method', '@target-uri'];
  if (body !== null) {
    headers['content-digest'] = values['content-digest'] = contentDigest(body);
    components.push('content-digest');
  }
  const nonce = crypto.randomBytes(16).toString('base64url');
  const params = `(${components.map((c) => `"${c}"`).join(' ')});created=${Math.floor(nowMs / 1000)};nonce="${nonce}";keyid="${me.keyId}";alg="ed25519"`;
  headers['signature-input'] = `sig1=${params}`;
  headers.signature = `sig1=:${me.signBytes(Buffer.from(base(components, values, params))).toString('base64')}:`;
  return headers;
}

export interface VerifyContext {
  /** The key and its identity, by key_id; null if unknown here. */
  lookup: (keyId: string) => { identity: string; key: KeyEntry } | null;
  nowMs: number;
  windowMs: number;
  /** Nonces seen: nonce → expiry. Checked and filled here. */
  seen: Map<string, number>;
}

/** The identity that signed this request, or null if it carries no signature.
 *  A signature that is present but wrong is a 401, never an anonymous read.
 *  `uri` is every @target-uri the request may have been signed for: the
 *  node's own addresses it arrived at (r_public_url_local), never one the
 *  request names by itself. */
export function verifyRequest(
  method: string, uri: string | readonly string[], headers: Record<string, string | string[] | undefined>, body: Buffer | null, ctx: VerifyContext,
): string | null {
  const input = headers['signature-input'];
  const sig = headers.signature;
  if (input === undefined && sig === undefined) return null;
  const bad = (m: string) => new Refusal(401, 'bad_request_signature', m);
  if (typeof input !== 'string' || typeof sig !== 'string') throw bad('one Signature-Input and one Signature header');
  const m = /^sig1=(\(([^)]*)\)((?:;[a-z]+=(?:"[^"]*"|\d+))*))$/.exec(input);
  const s = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/.exec(sig);
  if (!m || !s) throw bad('Signature-Input and Signature must each carry one sig1');
  const components = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  const params: Record<string, string> = {};
  for (const p of m[3]!.matchAll(/;([a-z]+)=(?:"([^"]*)"|(\d+))/g)) params[p[1]!] = p[2] ?? p[3]!;
  if (!components.includes('@method') || !components.includes('@target-uri')) throw bad('the signature must cover @method and @target-uri');
  if (body !== null && body.length > 0 && !components.includes('content-digest')) throw bad('a request with a body must sign content-digest');
  if (params.alg !== 'ed25519') throw bad('alg must be ed25519');
  if (!params.nonce || !params.created || !params.keyid) throw bad('created, nonce and keyid are required');
  const created = Number(params.created) * 1000;
  if (Math.abs(ctx.nowMs - created) > ctx.windowMs) throw bad('the signature is outside the freshness window');
  const values: Record<string, string> = { '@method': method.toUpperCase(), '@target-uri': '' };
  if (components.includes('content-digest')) {
    const cd = headers['content-digest'];
    if (typeof cd !== 'string' || cd !== contentDigest(body ?? Buffer.alloc(0))) throw bad('content-digest does not match the body');
    values['content-digest'] = cd;
  }
  for (const c of components) if (values[c] === undefined) throw bad(`cannot cover component ${c}`);
  const who = ctx.lookup(params.keyid);
  if (!who) throw new Refusal(401, 'unknown_requester', 'the signing key is not known here; introduce the identity first (POST /identities)');
  const ok = (typeof uri === 'string' ? [uri] : uri).some((u) => {
    try {
      return crypto.verify(null, Buffer.from(base(components, { ...values, '@target-uri': u }, m[1]!)),
        crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: who.key.public_key }, format: 'jwk' }),
        Buffer.from(s[1]!, 'base64'));
    } catch { return false; }
  });
  if (!ok) throw bad('the request signature does not verify');
  for (const [n, exp] of ctx.seen) if (exp < ctx.nowMs) ctx.seen.delete(n);
  if (ctx.seen.has(params.nonce)) throw bad('this request was already seen (nonce reused)');
  ctx.seen.set(params.nonce, ctx.nowMs + ctx.windowMs);
  return who.identity;
}
