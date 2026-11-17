// A VIEW LINK (r_view_link): a reader who reads by RFC 9421 signature opens a
// view's page in a browser, which cannot sign requests. The reader's own key
// mints, offline (`roflenox view_link`), a capability for ONE view on ONE node
// until a time:
//
//   <base64url(JCS(claims))>.<base64url(Ed25519 over "roflenox-view-link-v1\n" + JCS(claims))>
//   claims = {v: 1, iss, kid, aud: <the node's identity>, owner, name, iat, exp, jti}
//
// It travels in the page URL's FRAGMENT (`#link=…`), which a browser never
// sends — not in the request line, not in a Referer — and the page sends it
// only as `Authorization: RoflenoxView <link>` on the stream of that same
// path. The node accepts it there and nowhere else, and reads the view as
// `iss`, with exactly the access ask gives iss: a grant revoked or expired
// takes the rows away as it does for a signed reader. A link ends at `exp`
// (at most VIEW_LINK_MAX_SEC after `iat`), when iss's key stops being valid
// here (rotated, revoked), or when iss asserts {source: <jti>, relation:
// "roflenox:revoke_link"} in its own book; an open stream is ended then too.
import * as crypto from 'node:crypto';
import { Refusal, REVOKE_LINK } from './facts.ts';
import { canonicalize } from './jcs.ts';
import type { KeyEntry, LocalIdentity } from './identity.ts';

export const VIEW_LINK_CONTEXT = 'roflenox-view-link-v1\n';
export const VIEW_LINK_SCHEME = 'RoflenoxView';
export { REVOKE_LINK };
/** The longest a link may live: a day. The default is an hour. */
export const VIEW_LINK_MAX_SEC = 24 * 3600;
export const VIEW_LINK_DEFAULT_SEC = 3600;

export interface ViewLinkClaims { v: 1; iss: string; kid: string; aud: string; owner: string; name: string; iat: number; exp: number; jti: string }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Mint a link for `owner`'s view `name` on the node whose identity is `aud`, valid `ttlSec` from `nowMs`. */
export function mintViewLink(me: LocalIdentity, aud: string, owner: string, name: string, nowMs: number, ttlSec = VIEW_LINK_DEFAULT_SEC): { token: string; claims: ViewLinkClaims } {
  if (!(ttlSec > 0 && ttlSec <= VIEW_LINK_MAX_SEC)) throw new Refusal(400, 'bad_args', `a view link lives between 1 s and ${VIEW_LINK_MAX_SEC} s`);
  const iat = Math.floor(nowMs / 1000);
  const claims: ViewLinkClaims = { v: 1, iss: me.name, kid: me.keyId, aud, owner, name, iat, exp: iat + Math.floor(ttlSec), jti: crypto.randomBytes(16).toString('base64url') };
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
  /** Has iss revoked this link (a live roflenox:revoke_link of its jti)? */
  revoked: (iss: string, jti: string) => Promise<boolean>;
}

/** The claims of a link that is good for this view on this node now; a 401 naming why otherwise. */
export async function checkViewLink(token: string, c: ViewLinkCheck): Promise<ViewLinkClaims> {
  const bad = (why: string) => new Refusal(401, 'bad_view_link', `the view link ${why}`);
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) throw bad('is not <claims>.<signature>');
  const body = Buffer.from(m[1]!, 'base64url').toString('utf8');
  let k: ViewLinkClaims;
  try { k = JSON.parse(body) as ViewLinkClaims; } catch { throw bad('carries no claims'); }
  if (typeof k !== 'object' || k === null || k.v !== 1 || canonicalize(k) !== body) throw bad('carries claims in no canonical form');
  for (const f of ['iss', 'kid', 'aud', 'owner', 'name', 'jti'] as const) if (typeof k[f] !== 'string') throw bad(`has no ${f}`);
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
  if (await c.revoked(k.iss, k.jti)) throw bad('was revoked by its issuer');
  return k;
}

/** The link in an Authorization header, or null. */
export function linkOf(auth: string | undefined): string | null {
  return typeof auth === 'string' && auth.startsWith(`${VIEW_LINK_SCHEME} `) ? auth.slice(VIEW_LINK_SCHEME.length + 1).trim() : null;
}
