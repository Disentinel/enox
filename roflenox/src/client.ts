// Client verbs shared by the CLI and the tests: publish and mirror. Neither
// returns or prints key material; a caller sees names, counts and reasons.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toJsonl, checkFact, newSalt, Refusal, type Fact } from './facts.ts';
import type { IdentityDoc, LocalIdentity } from './identity.ts';
import { signRequest } from './httpsig.ts';
import { seal, type Envelope } from './seal.ts';

export class RemoteRefusal extends Error {
  readonly status: number;
  readonly reason: string;
  /** The engine's explanation, when the refusal carries one. */
  readonly whynot: string | null;
  constructor(status: number, reason: string, message: string, whynot: string | null = null) {
    super(`${reason}: ${message}${whynot ? `\n${whynot}` : ''}`);
    this.status = status;
    this.reason = reason;
    this.whynot = whynot;
  }
}

/** One JSON call. With `as`, the request is signed as that identity (RFC 9421). */
async function call(url: string, init?: { method: string; body: unknown }, as?: LocalIdentity, now: () => number = Date.now): Promise<Record<string, unknown>> {
  const method = init?.method ?? 'GET';
  const body = init ? JSON.stringify(init.body) : null;
  const u = new URL(url);
  const headers: Record<string, string> = body !== null ? { 'content-type': 'application/json' } : {};
  if (as) Object.assign(headers, signRequest(as, method, `${u.protocol}//${u.host}${u.pathname}${u.search}`, body, now()));
  const res = await fetch(url, { method, headers, ...(body !== null ? { body } : {}) });
  const j = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new RemoteRefusal(res.status, String(j.error), String(j.message), typeof j.whynot === 'string' ? j.whynot : null);
  return j;
}

/** Reach a node's operations: over HTTP (POST /op/<name>, signed as `as`
 *  when given), or — in a process that holds the node — directly. */
export type OpCaller = (op: string, args: Record<string, unknown>) => Promise<any>;

export function httpCaller(url: string, as?: LocalIdentity, now: () => number = Date.now): OpCaller {
  return (op, args) => call(`${url}/op/${op}`, { method: 'POST', body: args }, as, now);
}

const via = (node: string | OpCaller, as?: LocalIdentity, now?: () => number): OpCaller =>
  typeof node === 'string' ? httpCaller(node, as, now) : node;

/** An identity's document chain as `node` holds it. */
export async function identityChain(node: string | OpCaller, identity: string): Promise<IdentityDoc[]> {
  return via(node)('identity_chain', { identity });
}

/** An identity's chain head at `node`, or null. */
export async function headOf(node: string | OpCaller, identity: string): Promise<string | null> {
  return ((await via(node)('health', {})).heads as Record<string, string>)[identity] ?? null;
}

/** `me`'s own chain head at `node`, asked as `me` (a node tells an identity
 *  its own chain); null before its first batch, or while `node` does not
 *  know it yet (its first batch is its introduction). */
async function ownHead(node: OpCaller, me: LocalIdentity): Promise<string | null> {
  try {
    const d = ((await node('chain', { identity: me.name })) as { digests: string[] }).digests;
    return d.length ? d[d.length - 1]! : null;
  } catch (e) {
    if (e instanceof RemoteRefusal && e.status === 401) return null;
    throw e;
  }
}

/** Make sure `node` knows `me` (trust on first use); idempotent. */
export async function introduce(node: string | OpCaller, me: LocalIdentity): Promise<void> {
  await via(node)('introduce', { chain: me.identityChain() });
}

/** Facts from loose JSONL (any formatting per line); canonicalised here. */
export function readFacts(text: string): Fact[] {
  return text.split('\n').filter((l) => l.trim().length > 0).map((l, i) => {
    let o: unknown;
    try { o = JSON.parse(l); } catch { throw new Refusal(400, 'malformed_fact', `line ${i + 1}: not JSON`); }
    return checkFact(o, i + 1);
  });
}

/** Sign `facts` as `me` and admit them at a node. */
export async function publishVia(node: OpCaller, me: LocalIdentity, facts: Fact[], now: () => number = Date.now) {
  const jsonl = toJsonl(facts);
  const prev = await ownHead(node, me);
  const salt = newSalt();
  const manifest = me.signBatch(jsonl, prev, new Date(now()).toISOString(), salt);
  const r = await node('admit', { manifest, jsonl, salt, identity: me.identityChain() });
  return { identity: me.name, facts: facts.length, receipt: r.receipt as Record<string, unknown> };
}

export const publish = (url: string, me: LocalIdentity, facts: Fact[], now: () => number = Date.now) =>
  publishVia(httpCaller(url, me, now), me, facts, now);

/** Pull `identity`'s feed from `peer` after what the local node already has,
 *  and admit it there. The local node issues a one-time challenge; the peer
 *  (if it is the publisher) signs its head together with that challenge; the
 *  local node re-verifies every batch from scratch. The PEER is always spoken
 *  to over its wire path, GET /feeds/<identity>, which a static directory
 *  serves too. */
export async function mirrorVia(local: OpCaller, link: string, identity: string, as?: LocalIdentity, now: () => number = Date.now): Promise<{ identity: string; batches: number }> {
  const { peer, invited } = parseInvitation(link);
  // FIRST CONTACT (r_key_change_loud): what is pinned now is trusted from then
  // on. Over HTTPS the transport vouches for it; over plain HTTP only an
  // invitation link does — the key id it carries must sign the first document.
  const known = await identityChain(local, identity).then(() => true, (e: unknown) => {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  });
  if (!known && invited === null && new URL(peer).protocol !== 'https:') {
    throw new Refusal(403, 'invitation_required',
      `${identity} is not known here and ${peer} is plain HTTP: the first pull needs ${identity}'s invitation link (roflenox invite)`);
  }
  const after = await headOf(local, identity);
  const { nonce } = await local('challenge', {}) as { nonce: string };
  const q = new URLSearchParams({ challenge: nonce, ...(after ? { after } : {}) });
  if (as) {
    await introduce(httpCaller(peer), as).catch((e: unknown) => {
      // A static peer takes no introductions; a peer whose operator has not
      // vouched for us does not know us, and we read there as anyone.
      if (e instanceof RemoteRefusal && e.reason === 'not_vouched') as = undefined;
      else if (!(e instanceof RemoteRefusal && e.status === 404)) throw e;
    });
  }
  const feedUrl = (query: URLSearchParams) => `${peer}/feeds/${encodeURIComponent(identity)}?${query}`;
  // A peer that does not have our head has another history: take all of it,
  // and let admission say what is wrong with it (a forked chain, a changed key).
  const feed = await call(feedUrl(q), undefined, as, now).catch((e: unknown) => {
    if (!(e instanceof RemoteRefusal) || e.reason !== 'unknown_after') throw e;
    return call(feedUrl(new URLSearchParams({ challenge: nonce })), undefined, as, now);
  });
  if (!known && invited !== null && ([feed.identity].flat()[0] as { key_id?: string } | undefined)?.key_id !== invited) {
    throw new Refusal(409, 'invitation_mismatch',
      `the ${identity} at ${peer} is not the one the invitation names; nothing is pinned`);
  }
  // A live answer when the publisher gives one; otherwise a static copy's checkpoint.
  const r = await local('admit_feed', {
    identity: feed.identity, batches: feed.batches, attestation: feed.attestation, checkpoint: feed.checkpoint, nonce,
  });
  return { identity, batches: r.admitted as number };
}

/** An invitation link: the node's URL with `#key=<key id>` — the key that
 *  signed the identity's first document. The user copies it; nothing in it is
 *  shown as a key, and the fragment never goes over the wire. */
export function invitationLink(url: string, me: LocalIdentity): string {
  return `${url.replace(/\/$/, '')}#key=${me.identityChain()[0]!.key_id}`;
}

function parseInvitation(link: string): { peer: string; invited: string | null } {
  const i = link.indexOf('#');
  if (i < 0) return { peer: link.replace(/\/$/, ''), invited: null };
  return { peer: link.slice(0, i).replace(/\/$/, ''), invited: new URLSearchParams(link.slice(i + 1)).get('key') };
}

export const mirror = (local: string, peer: string, identity: string, as?: LocalIdentity, now: () => number = Date.now) =>
  mirrorVia(httpCaller(local, undefined, now), peer, identity, as, now);

export async function ask(url: string, body: { query?: string; why?: string; whynot?: string; perspective?: string }, as?: LocalIdentity, now: () => number = Date.now) {
  const c = httpCaller(url, as, now);
  if (body.why !== undefined) return { why: await c('why', { literal: body.why }) };
  if (body.whynot !== undefined) return { whynot: await c('whynot', { literal: body.whynot }) };
  return c('ask', { query: body.query, ...(body.perspective ? { perspective: body.perspective } : {}) });
}

/** Publish `facts` as `me` (they are part of its chain), then seal the same
 *  signed batch to `recipients`, whose encryption keys the node knows. */
export async function publishSealedVia(node: OpCaller, me: LocalIdentity, facts: Fact[], recipients: string[], now: () => number = Date.now): Promise<Envelope> {
  const jsonl = toJsonl(facts);
  const prev = await ownHead(node, me);
  const salt = newSalt();
  const manifest = me.signBatch(jsonl, prev, new Date(now()).toISOString(), salt);
  await node('admit', { manifest, jsonl, salt, identity: me.identityChain() });
  const keys = [];
  for (const r of recipients) {
    const chain = r === me.name ? me.identityChain() : await identityChain(node, r);
    keys.push({ identity: r, enc_public_key: chain[chain.length - 1]!.doc.enc.public_key });
  }
  return seal({ manifest, jsonl, salt, identity: me.identityChain() }, keys);
}

export const publishSealed = (url: string, me: LocalIdentity, facts: Fact[], recipients: string[], now: () => number = Date.now) =>
  publishSealedVia(httpCaller(url, me, now), me, facts, recipients, now);

/** Hand an envelope to the node, which opens it with its own identity's key
 *  and admits it offline (no freshness; key validity at claimed_at). */
export async function admitSealed(url: string, e: Envelope, as?: LocalIdentity, now: () => number = Date.now): Promise<Record<string, unknown>> {
  return httpCaller(url, as, now)('admit_sealed', e as never);
}

/** Write a static copy of `me`'s public feed into `dir` (as feeds/<name>),
 *  with a fresh checkpoint over its head. Run on a schedule shorter than the
 *  readers' checkpoint window. */
export async function writeStaticFeedVia(node: OpCaller, me: LocalIdentity, dir: string, now: () => number = Date.now): Promise<string> {
  const feed = await node('feed', { identity: me.name });
  const batches = feed.batches as { manifest: { digest: string } }[];
  const head = batches.length ? batches[batches.length - 1]!.manifest.digest : null;
  const out = { identity: feed.identity, batches, checkpoint: me.checkpoint(head, new Date(now()).toISOString()) };
  const p = path.join(dir, 'feeds', me.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(out));
  fs.renameSync(`${p}.tmp`, p);
  return p;
}

export const writeStaticFeed = (url: string, me: LocalIdentity, dir: string, now: () => number = Date.now) =>
  writeStaticFeedVia(httpCaller(url, undefined, now), me, dir, now);
