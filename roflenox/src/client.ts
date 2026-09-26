// Client verbs shared by the CLI and the tests: publish and mirror. Neither
// returns or prints key material; a caller sees names, counts and reasons.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toJsonl, checkFact, newSalt, Refusal, type Fact } from './facts.ts';
import type { LocalIdentity } from './identity.ts';
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

/** An identity's document chain as `node` holds it. */
export async function identityChain(node: string, identity: string): Promise<import('./identity.ts').IdentityDoc[]> {
  return (await call(`${node}/identities/${encodeURIComponent(identity)}`)) as unknown as import('./identity.ts').IdentityDoc[];
}

/** An identity's chain head at `node`, or null. */
export async function headOf(node: string, identity: string): Promise<string | null> {
  return ((await call(`${node}/health`)).heads as Record<string, string>)[identity] ?? null;
}

/** Make sure `node` knows `me` (trust on first use); idempotent. */
export async function introduce(node: string, me: LocalIdentity): Promise<void> {
  await call(`${node}/identities`, { method: 'POST', body: me.identityChain() });
}

/** Facts from loose JSONL (any formatting per line); canonicalised here. */
export function readFacts(text: string): Fact[] {
  return text.split('\n').filter((l) => l.trim().length > 0).map((l, i) => {
    let o: unknown;
    try { o = JSON.parse(l); } catch { throw new Refusal(400, 'malformed_fact', `line ${i + 1}: not JSON`); }
    return checkFact(o, i + 1);
  });
}

/** Sign `facts` as `me` and post them to the node at `url`. */
export async function publish(url: string, me: LocalIdentity, facts: Fact[], now: () => number = Date.now) {
  const jsonl = toJsonl(facts);
  const health = await call(`${url}/health`);
  const prev = ((health.heads as Record<string, string>)[me.name]) ?? null;
  const salt = newSalt();
  const manifest = me.signBatch(jsonl, prev, new Date(now()).toISOString(), salt);
  const r = await call(`${url}/batches`, { method: 'POST', body: { manifest, jsonl, salt, identity: me.identityChain() } });
  return { identity: me.name, facts: facts.length, receipt: r.receipt as Record<string, unknown> };
}

/** Pull `identity`'s feed from `peer` after what `local` already has, and
 *  admit it at `local`. The local node issues a one-time challenge; the peer
 *  (if it is the publisher) signs its head together with that challenge; the
 *  local node re-verifies every batch from scratch. */
export async function mirror(local: string, peer: string, identity: string, as?: LocalIdentity, now: () => number = Date.now): Promise<{ identity: string; batches: number }> {
  const health = await call(`${local}/health`);
  const after = (health.heads as Record<string, string>)[identity];
  const { nonce } = await call(`${local}/challenges`, { method: 'POST', body: {} }) as { nonce: string };
  const q = new URLSearchParams({ challenge: nonce, ...(after ? { after } : {}) });
  if (as) await introduce(peer, as);
  const feedUrl = (query: URLSearchParams) => `${peer}/feeds/${encodeURIComponent(identity)}?${query}`;
  // A peer that does not have our head has another history: take all of it,
  // and let admission say what is wrong with it (a forked chain, a changed key).
  const feed = await call(feedUrl(q), undefined, as, now).catch((e: unknown) => {
    if (!(e instanceof RemoteRefusal) || e.reason !== 'unknown_after') throw e;
    return call(feedUrl(new URLSearchParams({ challenge: nonce })), undefined, as, now);
  });
  // A live answer when the publisher gives one; otherwise a static copy's checkpoint.
  const r = await call(`${local}/feeds/admit`, {
    method: 'POST', body: { identity: feed.identity, batches: feed.batches, attestation: feed.attestation, checkpoint: feed.checkpoint, nonce },
  });
  return { identity, batches: r.admitted as number };
}

export async function ask(url: string, body: { query?: string; why?: string; whynot?: string }, as?: LocalIdentity, now: () => number = Date.now) {
  return call(`${url}/ask`, { method: 'POST', body }, as, now);
}

/** Publish `facts` as `me` to its own node (they are part of its chain), then
 *  seal the same signed batch to `recipients`, whose encryption keys `url`
 *  knows. The envelope can be put anywhere; only the recipients can open it. */
export async function publishSealed(url: string, me: LocalIdentity, facts: Fact[], recipients: string[], now: () => number = Date.now): Promise<Envelope> {
  const jsonl = toJsonl(facts);
  const prev = await headOf(url, me.name);
  const salt = newSalt();
  const manifest = me.signBatch(jsonl, prev, new Date(now()).toISOString(), salt);
  await call(`${url}/batches`, { method: 'POST', body: { manifest, jsonl, salt, identity: me.identityChain() } });
  const keys = [];
  for (const r of recipients) {
    const chain = r === me.name ? me.identityChain() : await identityChain(url, r);
    keys.push({ identity: r, enc_public_key: chain[chain.length - 1]!.doc.enc.public_key });
  }
  return seal({ manifest, jsonl, salt, identity: me.identityChain() }, keys);
}

/** Hand an envelope to the node at `url`, which opens it with its own
 *  identity's key and admits it offline (no freshness; key validity at
 *  claimed_at). */
export async function admitSealed(url: string, e: Envelope): Promise<Record<string, unknown>> {
  return call(`${url}/sealed`, { method: 'POST', body: e });
}

/** Write a static copy of `me`'s public feed into `dir` (as feeds/<name>),
 *  with a fresh checkpoint over its head. Run on a schedule shorter than the
 *  readers' checkpoint window. */
export async function writeStaticFeed(url: string, me: LocalIdentity, dir: string, now: () => number = Date.now): Promise<string> {
  const feed = await call(`${url}/feeds/${encodeURIComponent(me.name)}`);
  const batches = feed.batches as { manifest: { digest: string } }[];
  const head = batches.length ? batches[batches.length - 1]!.manifest.digest : null;
  const out = { identity: feed.identity, batches, checkpoint: me.checkpoint(head, new Date(now()).toISOString()) };
  const p = path.join(dir, 'feeds', me.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(out));
  fs.renameSync(`${p}.tmp`, p);
  return p;
}
