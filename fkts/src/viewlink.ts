// A VIEW LINK (r_view_link): a reader who reads by RFC 9421 signature opens a
// view's page in a browser, which cannot sign requests. The reader's own key
// mints, offline (`fkts view_link`), a capability for ONE view on ONE node
// until a time:
//
//   <base64url(JCS(claims))>.<base64url(Ed25519 over "fkts-view-link-v1\n" + JCS(claims))>
//   claims = {v: 1, iss, kid, aud: <the node's identity>, owner, name, lit, iat, exp, jti}
//
// `lit` binds the link to the view's definition as the issuer saw it when it
// signed: the hash of the literal (viewLit), so the view's owner cannot point
// a link at another literal of what the issuer may read by redefining the view.
// A definition that changes refuses the link, and ends its open streams.
//
// It travels in the page URL's FRAGMENT (`#link=…`), which a browser never
// sends — not in the request line, not in a Referer — and the page sends it
// only as `Authorization: FKTSView <link>` on the stream of that same
// path. The node accepts it there and nowhere else, and reads the view as
// `iss`, with exactly the access ask gives iss: a grant revoked or expired
// takes the rows away as it does for a signed reader. A link ends at `exp`
// (at most VIEW_LINK_MAX_SEC after `iat`), when iss's key stops being valid
// here (rotated, recovered, revoked), when the view is redefined, or when iss
// asserts {source: <jti>, relation: "fkts:revoke_link"} in its own book;
// an open stream is ended then too (src/node.ts, subscribeLink).
import * as crypto from 'node:crypto';
import { parseLiteral } from './engine.ts';
import { Refusal, REVOKE_LINK } from './facts.ts';
import { canonicalize } from './jcs.ts';
import { bookOf, type KeyEntry, type LocalIdentity } from './identity.ts';

export const VIEW_LINK_CONTEXT = 'fkts-view-link-v1\n';
export const VIEW_LINK_SCHEME = 'FKTSView';
export { REVOKE_LINK };
/** The longest a link may live: a day. The default is an hour. */
export const VIEW_LINK_MAX_SEC = 24 * 3600;
export const VIEW_LINK_DEFAULT_SEC = 3600;

export interface ViewLinkClaims { v: 1; iss: string; kid: string; aud: string; owner: string; name: string; lit: string; iat: number; exp: number; jti: string }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A view's literal as the node reads it: one naming no book is in the owner's. */
export function viewLiteralOf(owner: string, literal: string): string {
  const { rel, book, args } = parseLiteral(literal);
  return book === null ? `${rel}[${bookOf(owner)}](${args})` : literal;
}

/** The `lit` claim: the hash of a view's literal as viewLiteralOf gives it. */
export function viewLit(literal: string): string {
  return crypto.createHash('sha256').update(literal).digest('base64url');
}

/** Mint a link for `owner`'s view `name` on the node whose identity is `aud`, valid `ttlSec` from `nowMs`,
 *  for the view's definition whose hash is `lit` (viewLit). */
export function mintViewLink(me: LocalIdentity, aud: string, owner: string, name: string, nowMs: number, ttlSec = VIEW_LINK_DEFAULT_SEC, lit = ''): { token: string; claims: ViewLinkClaims } {
  if (!(ttlSec > 0 && ttlSec <= VIEW_LINK_MAX_SEC)) throw new Refusal(400, 'bad_args', `a view link lives between 1 s and ${VIEW_LINK_MAX_SEC} s`);
  const iat = Math.floor(nowMs / 1000);
  const claims: ViewLinkClaims = { v: 1, iss: me.name, kid: me.keyId, aud, owner, name, lit, iat, exp: iat + Math.floor(ttlSec), jti: crypto.randomBytes(16).toString('base64url') };
  const body = canonicalize(claims);
  return { token: `${b64(body)}.${b64(me.signBytes(Buffer.from(VIEW_LINK_CONTEXT + body)))}`, claims };
}

export interface ViewLinkCheck {
  lookup: (keyId: string) => { identity: string; key: KeyEntry } | null;
  /** This node's identity. */
  audience: string;
  owner: string;
  name: string;
  nowMs: number;
}

/** The claims of a link that is good for this view on this node now, as far
 *  as the link itself says: its form, its signature, its audience, its view,
 *  its time. Synchronous and node-free, so a forged link is refused before it
 *  waits on the node's queue. What the node holds — whether the link is
 *  revoked, whether its `lit` is the view's definition now — the node checks
 *  (src/node.ts, subscribeLink). A 401 naming why otherwise. */
export function verifyViewLink(token: string, c: ViewLinkCheck): ViewLinkClaims {
  const bad = (why: string) => new Refusal(401, 'bad_view_link', `the view link ${why}`);
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) throw bad('is not <claims>.<signature>');
  // One spelling per link: base64url whose unused trailing bits are not zero decodes to the same bytes.
  if (m.slice(1).some((p) => Buffer.from(p, 'base64url').toString('base64url') !== p)) throw bad('is not in canonical base64url');
  const body = Buffer.from(m[1]!, 'base64url').toString('utf8');
  let k: ViewLinkClaims;
  try { k = JSON.parse(body) as ViewLinkClaims; } catch { throw bad('carries no claims'); }
  if (typeof k !== 'object' || k === null || k.v !== 1 || canonicalize(k) !== body) throw bad('carries claims in no canonical form');
  for (const f of ['iss', 'kid', 'aud', 'owner', 'name', 'lit', 'jti'] as const) if (typeof k[f] !== 'string' || k[f] === '') throw bad(`has no ${f}`);
  if (!Number.isInteger(k.iat) || !Number.isInteger(k.exp)) throw bad('has no iat or exp');
  const who = c.lookup(k.kid);
  if (!who || who.identity !== k.iss) throw bad('is signed by a key not valid here for its issuer');
  const ok = (() => {
    try {
      return crypto.verify(null, Buffer.from(VIEW_LINK_CONTEXT + body),
        crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: who.key.public_key }, format: 'jwk' }), Buffer.from(m[2]!, 'base64url'));
    } catch { return false; }
  })();
  if (!ok) throw bad('does not verify');
  if (k.aud !== c.audience) throw bad('is for another node');
  if (k.owner !== c.owner || k.name !== c.name) throw bad('is for another view');
  const now = Math.floor(c.nowMs / 1000);
  if (k.exp - k.iat > VIEW_LINK_MAX_SEC) throw bad(`lives longer than ${VIEW_LINK_MAX_SEC} s`);
  if (k.iat > now + 60) throw bad('is dated in the future');
  if (now >= k.exp) throw bad('has expired');
  return k;
}

/** The link in an Authorization header, or null. */
export function linkOf(auth: string | undefined): string | null {
  return typeof auth === 'string' && auth.startsWith(`${VIEW_LINK_SCHEME} `) ? auth.slice(VIEW_LINK_SCHEME.length + 1).trim() : null;
}
