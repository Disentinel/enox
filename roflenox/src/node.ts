// A roflenox node: the log, the engine built from it, and admission.
//
// Admission, in the spec's order (item 5), each step refusing with a precise
// reason and nothing admitted on any refusal:
//   1. signature  — the manifest verifies under the signer's pinned key, and
//                   the JSONL bytes hash to the signed digest
//   2. key valid  — the key's validity interval contains claimed_at
//   3. chain      — prev is this identity's head (null for its first batch)
//   4. freshness  — |claimed_at − received_at| ≤ the window
//   5. load       — into the SIGNER's book only, with who = identity
//
// Freshness belongs to the moment of RECEIPT, not to the age of the content.
// A live POST is judged by claimed_at, or by a re-attestation (a fresh
// signature over the same digest) when claimed_at is old. A batch from a
// peer's feed is judged by the publisher's fresh signature over the feed head
// and the reader's one-time challenge; the batch's own signature is then
// checked for key validity at its claimed_at, never for age.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize } from './jcs.ts';
import { batchDigest, decodeCell, EMBEDDER, factId, isSalt, newSalt, parseJsonl, Refusal, roflString, SEARCH, sha256hex, toJsonl, toRofl, type Fact } from './facts.ts';
import {
  bookOf, CHECKPOINT_CONTEXT, checkIdentityDoc, checkManifest, docHash, docSignedBy, FEED_CONTEXT, isTime, keyValidAt, LocalIdentity,
  REATTEST_CONTEXT, verifyIdentityDoc, verifyManifestSig, verifySigned,
  type Attestation, type Checkpoint, type FeedAttestation, type IdentityDoc, type KeyEntry, type Manifest,
} from './identity.ts';
import { Log, writeFileAtomic, type Fault, type Receipt } from './log.ts';
import {
  answeredRule, bookRules, DEFAULT_ROFL_BIN, Engine, mayReadRules, parseLiteral, resultRule, splitArgs, SYSTEM_BOOK,
  type AskAnswer, type BookScope, type Explanation, type Unknown, type World,
} from './engine.ts';
import { verifyRequest } from './httpsig.ts';
import { compileRule, RULE } from './rules.ts';
import { RESULT } from './executor.ts';
import { Assertions, match } from './assertions.ts';
import { whyNotDelegated, whyNotReadable } from './expiry.ts';
import { open as openSealed, type Envelope } from './seal.ts';

export const DEFAULT_FRESHNESS_SEC = 300;

/** The operator's bearer token: 32 random bytes in key/operator-token (0600),
 *  created on first use. It stands for the node's OWN identity and nothing else. */
export function operatorTokenOf(dataDir: string): string {
  const p = path.join(dataDir, 'key', 'operator-token');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32).toString('base64url')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
  }
  return fs.readFileSync(p, 'utf8').trim();
}

// Whether the next version of an identity document is accepted is a ROFL
// rule, so a refusal is explained by the engine (r_key_change_loud). The
// current key may rotate — add a key, end its own validity — but may neither
// change the recovery key nor revoke; the recovery key may do anything
// (r_rotation, r_recovery). JS asserts only what it has checked: a signature
// that verifies (update), the chain position (follows), the facts of the
// document currently pinned.
const S = SYSTEM_BOOK;
const UPDATE_RULES = [
  `accepted_update[${S}](I, Seq) :- update[${S}](I, Seq, K), follows[${S}](I, Seq), current_key[${S}](I, K), `
    + `not changes_recovery[${S}](I, Seq), not revokes[${S}](I, Seq).`,
  `accepted_update[${S}](I, Seq) :- update[${S}](I, Seq, K), follows[${S}](I, Seq), recovery_key[${S}](I, K).`,
  '',
].join('\n');

export interface NodeOptions {
  dataDir: string;
  bin?: string;
  /** Injectable clock, ms since epoch. */
  now?: () => number;
  freshnessSec?: number;
  fault?: Fault;
  /** The URL clients reach this node at, e.g. https://enox.example.org. Behind
   *  a TLS-terminating proxy the request itself says http and a local Host;
   *  signed requests are checked against THIS scheme and authority instead
   *  (r_sig_behind_proxy). Unset: taken from the request, for direct use. */
  publicUrl?: string;
  /** Steps an author's rules may take per evaluation of its rule world. */
  ruleBudget?: number;
  /** How old a static feed's checkpoint may be (default 24 h). */
  checkpointWindowSec?: number;
  /** A followed feed with no batch claimed within this many seconds is
   *  SILENT: answers that read it carry an unknown (default 1 h). */
  silenceSec?: number;
}

export const DEFAULT_SILENCE_SEC = 3600;

export const DEFAULT_CHECKPOINT_WINDOW_SEC = 24 * 3600;


export interface BatchBody { manifest: unknown; jsonl?: unknown; salt?: unknown; identity?: unknown; reattest?: unknown; withheld?: unknown }
export interface FeedBody { identity?: unknown; batches: BatchBody[]; attestation?: unknown; nonce?: unknown; checkpoint?: unknown }
/** A batch in a feed: its content, or — for a reader not allowed all of it —
 *  the signed manifest alone, so the chain still verifies (`withheld`). */
export interface FeedEntry { manifest: Manifest; jsonl?: string; salt?: string; reattest?: Attestation; withheld?: true }

/** post: a live POST, judged by claimed_at or its re-attestation. feed: from a
 *  peer's feed, freshness already settled by the feed attestation. replay:
 *  from our own log, received_at taken from the receipt. */
type Mode = 'post' | 'feed' | 'offline' | 'replay';

interface Verified {
  manifest: Manifest; facts: Fact[]; pin: IdentityDoc | null; reattest: Attestation | null; withheld: boolean;
  /** The batch's user rules, compiled to its author's book (src/rules.ts). */
  rules: string[];
}

/** The ROFL program a verified batch loads into the MAIN world: its facts.
 *  Its user rules run only in its author's rule world (r_rule_budget). */
function programOf(v: Verified, seq: number): string {
  // The asserted[] rows are not here: they are the CURRENT assertions, kept by
  // src/assertions.ts (it replaces the superseded/current/view rules).
  return toRofl(v.facts, bookOf(v.manifest.identity), seq, false);
}

/** One hit of a search by meaning: an entity ("node") or a fact, by id. */
export interface SearchHit { kind: 'node' | 'fact'; id: string; score: number }
export interface MeaningSearch {
  state: 'answered' | 'pending' | 'not_asked' | 'no_embedder';
  key: string;
  embedder?: string;
  hits: SearchHit[];
}

/** A search's key: the query, trimmed and case-folded, hashed. */
export function searchKey(query: string): string {
  return `search:${sha256hex(query.trim().toLowerCase().replace(/\s+/g, ' ')).slice(0, 32)}`;
}

export const DEFAULT_RULE_BUDGET = 50_000;
/** How many admitted facts are remembered for views that apply writes
 *  (admittedSince). Counted in facts, not batches: a thousand batches of 2000
 *  would hold two million facts in memory (r_bounded_memory). A view further
 *  behind than this rebuilds. */
const RECENT_FACTS = 50_000;

export class RoflenoxNode {
  readonly dataDir: string;
  private ownCache: { mtimeMs: number; id: LocalIdentity | null } | null = null;
  readonly log: Log;
  private engine!: Engine;
  private readonly now: () => number;
  private readonly fault: Fault;
  private readonly bin: string;
  private engineRestarts = 0;
  private readonly freshnessMs: number;
  readonly publicUrl: string | null;
  /** The key challenges are authenticated with: random per process, so a
   *  restart simply expires every outstanding challenge. */
  private readonly challengeKey = crypto.randomBytes(32);
  private readonly checkpointWindowMs: number;
  /** Every identity's document chain, oldest first; the last is current. */
  private readonly idDocs = new Map<string, IdentityDoc[]>();
  private readonly chains = new Map<string, string[]>();
  private factCount = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Challenges this node issued as a reader: nonce → expiry (ms). One use each. */
  private readonly consumed = new Map<string, number>();
  // ---- rule worlds (r_rule_budget) -----------------------------------------
  // The MAIN world holds every fact and the system rules, and is what
  // admission evaluates. An author's own rules run in that author's RULE
  // WORLD: a separate world with its own step budget, holding the author's
  // book, the books its rules read, every executor result, and its rules. A
  // rule that never terminates exhausts only its author's budget; its answers
  // come back unknown, naming the budget; nobody else's admission waits on it.
  private readonly ruleBudget: number;
  private readonly programs = new Map<string, string[]>();      // identity → its batches' fact programs
  private readonly results = new Map<string, string[]>();       // identity → its roflenox:result fact lines
  private readonly userRules = new Map<string, { text: string; mirrored: boolean }[]>();  // author → compiled rules
  private readonly worlds = new Map<string, { w: World; version: number; clock: number }>();
  /** The current assertion of every fact, per identity (src/assertions.ts). */
  private readonly assertions = new Assertions();
  private version = 0;
  /** The last admissions, for views that apply writes instead of rebuilding. */
  private readonly recent: { version: number; identity: string; facts: Fact[]; seq: number }[] = [];
  /** The newest claimed_at of each identity's batches (ms): when it last spoke. */
  private readonly lastClaimed = new Map<string, number>();
  private readonly silenceSec: number;
  private recentFacts = 0;
  /** RFC 9421 nonces seen on signed requests: nonce → expiry (ms). */
  private readonly requestNonces = new Map<string, number>();

  private constructor(o: NodeOptions) {
    this.dataDir = o.dataDir;
    this.log = new Log(o.dataDir, o.fault);
    this.fault = o.fault ?? (() => {});
    this.bin = o.bin ?? DEFAULT_ROFL_BIN;
    this.now = o.now ?? Date.now;
    this.freshnessMs = (o.freshnessSec ?? DEFAULT_FRESHNESS_SEC) * 1000;
    this.publicUrl = o.publicUrl ? new URL(o.publicUrl).origin : null;
    this.ruleBudget = o.ruleBudget ?? DEFAULT_RULE_BUDGET;
    this.silenceSec = o.silenceSec ?? DEFAULT_SILENCE_SEC;
    this.checkpointWindowMs = (o.checkpointWindowSec ?? DEFAULT_CHECKPOINT_WINDOW_SEC) * 1000;
  }

  /** Open a node: read the log, re-verify every batch in it, and build the
   *  engine by replaying it. There is no snapshot: the log is the only store,
   *  and replay is the only way to the engine (r_snapshot_is_cache —
   *  measured, a snapshot opened 5× slower than a replay at 162k facts). */
  static async open(o: NodeOptions): Promise<RoflenoxNode> {
    const n = new RoflenoxNode(o);
    n.log.open();
    const bin = o.bin ?? DEFAULT_ROFL_BIN;
    // A fresh engine first: identity decisions are made in throwaway forks of
    // it while the log is re-verified, and then the log is replayed into it.
    n.engine = await Engine.fresh(bin);
    const batches: { v: Verified; rules: string | null; seq: number }[] = [];
    const receipts = n.log.receipts;
    for (const [ri, r] of receipts.entries()) {
      if (r.kind === 'identity') {
        try {
          await n.applyDoc(n.log.readIdentity(r), r.received_at, false);
        } catch (e) {
          throw new Error(`log identity document of ${r.identity} no longer verifies (${(e as Error).message}); refusing to start`);
        }
        continue;
      }
      const s = n.log.read(r);
      let v: Verified;
      try {
        v = n.verify({
          manifest: s.manifest, reattest: r.reattest,
          ...(r.withheld ? { withheld: true } : { jsonl: s.jsonl, salt: s.salt }),
        }, r.received_at, r.withheld ? 'feed' : r.via === 'envelope' ? 'offline' : 'replay', s.pinned,
          receipts.slice(ri + 1).filter((x) => x.identity === r.identity && x.kind !== 'identity').map((x) => x.digest), true);
      } catch (e) {
        throw new Error(`log batch ${r.identity}/${r.digest} no longer verifies (${(e as Error).message}); refusing to start`);
      }
      const rules = n.chains.has(r.identity) ? null : bookRules(bookOf(r.identity), r.identity);
      const seq = n.chains.get(r.identity)?.length ?? 0;
      n.record(v, r.via !== undefined);
      batches.push({ v, rules, seq });
    }
    if (n.identity && n.idDocs.has(n.identity.name)) {
      // The key file's chain may be ahead of the log (a rotation or recovery
      // made offline): admit the newer versions, through the same rule.
      try {
        await n.applyChain(n.identity.name, n.identity.identityChain(), new Date(n.now()).toISOString(), false, n.identity.name);
      } catch (e) {
        await n.engine.stop();
        throw new Error(`the key file for ${n.identity.name} does not follow the identity the log knows (${(e as Error).message}); refusing to start`);
      }
      const key = n.current(n.identity.name)!.doc.keys.find((k) => k.key_id === n.identity!.keyId);
      if (!key || key.revoked_at) {
        await n.engine.stop();
        throw new Error(`the key file for ${n.identity.name} is not a key this identity has published under; refusing to start`);
      }
    }
    await n.engine.replay([...batches.map(({ v, rules, seq }) => ({ rofl: programOf(v, seq), who: v.manifest.identity, rules })),
      ...[...n.chains.keys()].map((id) => ({ rofl: n.assertions.lines(id, bookOf(id)), who: id, rules: null }))]);
    await n.checkUriPrefix();
    return n;
  }

  /** Loud startup findings that are not errors (health.warnings; the CLI
   *  prints them). */
  readonly warnings: string[] = [];

  /** r_uri_prefix_stable: the Enox entity ids in this node's own book were
   *  minted under some prefix; if it is not the configured one, new ids would
   *  silently land elsewhere — so say it, once, at startup. */
  private async checkUriPrefix(): Promise<void> {
    const me = this.identity?.name;
    if (!me || !this.chains.has(me)) return;
    const { uriPrefix } = await import('./enox.ts');
    const want = uriPrefix();
    const rows = (await this.engine.sysRows(`edge[${bookOf(me)}](F, S, "enox:type", T)`)).map((r) => String(r[1]));
    const foreign = rows.filter((id) => id.startsWith('enox://') && !id.startsWith(`${want}/`));
    if (foreign.length === 0) return;
    // An Enox id is <prefix>/<domain>/<slug>: the prefix is all but the last two segments.
    const seen = [...new Set(foreign.map((id) => id.split('/').slice(0, -2).join('/')))].slice(0, 3);
    this.warnings.push(`URI PREFIX MISMATCH: ${foreign.length} of ${rows.length} entity ids in ${me}'s book are not under the configured prefix `
      + `${want} (e.g. ${seen.join(', ')}); new entities would be minted under a different prefix. Set NODE_URI_PREFIX to the prefix these ids use.`);
  }

  /** This node's own identity, re-read when the key file changes (a rotation
   *  or recovery made by the CLI while the node runs). */
  get identity(): LocalIdentity | null {
    const p = LocalIdentity.keyPath(this.dataDir);
    const m = fs.existsSync(p) ? fs.statSync(p).mtimeMs : -1;
    if (!this.ownCache || this.ownCache.mtimeMs !== m) this.ownCache = { mtimeMs: m, id: m < 0 ? null : LocalIdentity.load(this.dataDir) };
    return this.ownCache.id;
  }

  /** An identity's document chain as this node holds it. */
  identityChain(identity: string): IdentityDoc[] {
    const d = this.idDocs.get(identity);
    if (!d) throw new Refusal(404, 'unknown_identity', `${identity} is not known here`);
    return d;
  }

  private current(identity: string): IdentityDoc | null {
    const d = this.idDocs.get(identity);
    return d ? d[d.length - 1]! : null;
  }

  /** Admit one identity document: a first contact (seq 0, signed by its own
   *  key — trust on first use), or the next version of one already known,
   *  as the engine decides. A version already held is a no-op. */
  private async applyDoc(raw: unknown, receivedAt: string, commit: boolean): Promise<void> {
    const d = checkIdentityDoc(raw);
    const id = d.doc.identity;
    const have = this.idDocs.get(id) ?? [];
    if (have.some((x) => docHash(x) === docHash(d))) return;
    this.notFuture(d.doc.issued_at, receivedAt, `${id}'s identity document`);
    if (have.length === 0) {
      if (d.doc.seq !== 0) throw new Refusal(422, 'bad_identity_doc', `first contact with ${id} starts from its first document`);
      verifyIdentityDoc(d);
    } else {
      await this.decideUpdate(have[have.length - 1]!, d);
    }
    if (commit) this.log.appendIdentity(d, receivedAt);
    this.idDocs.set(id, [...have, d]);
  }

  /** Is `next` an accepted successor of `cur`? Refuses with the engine's whynot. */
  private async decideUpdate(cur: IdentityDoc, next: IdentityDoc): Promise<void> {
    const id = cur.doc.identity;
    const signer = [...cur.doc.keys, ...next.doc.keys].find((k) => k.key_id === next.key_id)?.public_key
      ?? (next.key_id === cur.doc.recovery.key_id ? cur.doc.recovery.public_key : null);
    if (signer === null || !docSignedBy(next, signer)) {
      throw new Refusal(422, 'bad_identity_doc', `the new identity document of ${id} does not verify under the key it names`);
    }
    const I = roflString(id);
    const seq = next.doc.seq;
    const facts = [`update[${S}](${I}, ${seq}, ${roflString(next.key_id)}).`, `recovery_key[${S}](${I}, ${roflString(cur.doc.recovery.key_id)}).`];
    const kept = cur.doc.keys.every((k) => next.doc.keys.some((n) =>
      n.key_id === k.key_id && n.public_key === k.public_key && n.valid_from === k.valid_from));
    if (seq === cur.doc.seq + 1 && next.doc.prev === docHash(cur) && kept
      // Time order binds the keys, never the recovery key: a recovery-signed
      // document is ordered by seq/prev alone, so a future-dated rotation made
      // with a stolen key cannot shut it out (r_recovery, r_no_future_docs).
      && (Date.parse(next.doc.issued_at) >= Date.parse(cur.doc.issued_at) || next.key_id === cur.doc.recovery.key_id)) {
      facts.push(`follows[${S}](${I}, ${seq}).`);
    }
    for (const k of cur.doc.keys) {
      if (!k.revoked_at && keyValidAt(k, Date.parse(next.doc.issued_at))) facts.push(`current_key[${S}](${I}, ${roflString(k.key_id)}).`);
    }
    if (canonicalize(next.doc.recovery) !== canonicalize(cur.doc.recovery)) facts.push(`changes_recovery[${S}](${I}, ${seq}).`);
    if (next.doc.keys.some((k) => k.revoked_at && !cur.doc.keys.find((c) => c.key_id === k.key_id)?.revoked_at)) {
      facts.push(`revokes[${S}](${I}, ${seq}).`);
    }
    const r = await this.engine.decide(`${UPDATE_RULES}${facts.join('\n')}\n`, `accepted_update[${S}](${I}, ${seq})`);
    if (!r.holds) {
      throw new Refusal(409, 'key_changed',
        `${id}'s keys changed without a rotation signed by its current key or its recovery key; the pull stops here`, { whynot: r.whynot });
    }
  }

  /** Admit an offered identity chain (a document or an array, oldest first)
   *  for `identity`. Returns a first document to pin TOGETHER with the batch
   *  being admitted, when that is all there is to learn (first contact, one
   *  document); otherwise commits what is new as identity receipts. */
  private async applyChain(identity: string, raw: unknown, receivedAt: string, pendingOk: boolean, by: string | null): Promise<IdentityDoc | null> {
    const docs = (Array.isArray(raw) ? raw : [raw]).map(checkIdentityDoc);
    for (const d of docs) {
      if (d.doc.identity !== identity) {
        throw new Refusal(422, 'identity_mismatch', `the identity document is for ${d.doc.identity}, not ${identity}`);
      }
    }
    if (!this.idDocs.has(identity)) await this.vouch(identity, docs[0]!, by, receivedAt);
    if (pendingOk && !this.idDocs.has(identity) && docs.length === 1) {
      this.notFuture(docs[0]!.doc.issued_at, receivedAt, `${identity}'s identity document`);
      return verifyIdentityDoc(docs[0]);
    }
    for (const d of docs) await this.applyDoc(d, receivedAt, true);
    return null;
  }

  /** FIRST PIN (r_key_change_loud): an identity this node does not know is
   *  pinned only on its operator's word (`by`, the proven caller), or on a
   *  live delegation to it from an identity pinned here — and a delegation
   *  vouches only for a name under its parent, label.parent, the way a DNS
   *  zone owns only its subdomains. Anyone else's write, introduction or
   *  pushed feed naming it is refused and pins nothing — else whoever speaks
   *  first (or any identity trusted here) would own the name. */
  private async vouch(identity: string, first: IdentityDoc, by: string | null, receivedAt: string): Promise<void> {
    if (by !== null && by === this.identity?.name) return;
    // The node's own identity, as its key file on this machine starts it.
    if (identity === this.identity?.name && docHash(first) === docHash(this.identity.identityChain()[0]!)) return;
    const parent = first.doc.delegated_by;
    const label = parent !== undefined && identity.endsWith(`.${parent}`) ? identity.slice(0, identity.length - parent.length - 1) : '';
    if (parent !== undefined && label !== '' && !label.includes('.') && this.idDocs.has(parent)) {
      const at = Math.floor(Date.parse(receivedAt) / 1000);
      const until = (await this.engine.sysRows(`delegate[${bookOf(parent)}](${roflString(identity)}, U)`)).map((r) => Number(r[0]));
      if (until.some((u) => at < u)) return;
    }
    throw new Refusal(403, 'not_vouched',
      `${identity} is not known here and nobody this node trusts vouched for it: its operator introduces it or pulls it by invitation, or an identity pinned here delegates to it`);
  }

  /** POST /identities: introduce an identity. Its first document is pinned
   *  only as `by` allows (vouch); a known one's updates by rule. Idempotent. */
  introduce(raw: unknown, by: string | null = null): Promise<{ identity: string; pinned: boolean }> {
    return this.serial(async () => {
      const first = checkIdentityDoc(Array.isArray(raw) ? raw[0] : raw);
      const before = this.idDocs.get(first.doc.identity)?.length ?? 0;
      await this.applyChain(first.doc.identity, raw, new Date(this.now()).toISOString(), false, by);
      return { identity: first.doc.identity, pinned: (this.idDocs.get(first.doc.identity)?.length ?? 0) > before };
    });
  }

  /** Who signed this request (RFC 9421), or null for an unsigned one. */
  authenticate(method: string, uri: string, headers: Record<string, string | string[] | undefined>, body: Buffer | null): string | null {
    return verifyRequest(method, uri, headers, body, {
      lookup: (keyId) => {
        if (this.identity && keyId === this.identity.keyId) {
          return { identity: this.identity.name, key: this.identity.identityDoc().doc.keys.find((k) => k.key_id === keyId)! };
        }
        for (const [identity, docs] of this.idDocs) {
          const key = docs[docs.length - 1]!.doc.keys.find((k) => k.key_id === keyId);
          if (key && keyValidAt(key, this.now())) return { identity, key };
        }
        return null;
      },
      nowMs: this.now(),
      windowMs: this.freshnessMs,
      seen: this.requestNonces,
    });
  }

  /** `mirrored`: the batch came by a feed or an envelope, not from its author
   *  posting here — its rules are inert until trusted (r_foreign_rules_opt_in). */
  private record(v: Verified, mirrored = false, seq = (this.chains.get(v.manifest.identity)?.length ?? 0),
    plan = this.assertions.plan(v.manifest.identity, bookOf(v.manifest.identity), v.facts, seq)): void {
    const id = v.manifest.identity;
    plan.apply();
    this.programs.set(id, [...(this.programs.get(id) ?? []), programOf(v, seq)]);
    const res = v.facts.filter((f) => f.relation === RESULT);
    if (res.length) this.results.set(id, [...(this.results.get(id) ?? []), toRofl(res, bookOf(id), seq)]);
    if (v.rules.length) this.userRules.set(id, [...(this.userRules.get(id) ?? []), ...v.rules.map((text) => ({ text, mirrored }))]);
    this.version++;
    const claimed = Date.parse(v.manifest.claimed_at);
    if (claimed > (this.lastClaimed.get(id) ?? -Infinity)) this.lastClaimed.set(id, claimed);
    this.recent.push({ version: this.version, identity: id, facts: v.facts, seq });
    this.recentFacts += v.facts.length;
    while (this.recentFacts > RECENT_FACTS) this.recentFacts -= this.recent.shift()!.facts.length;
    if (v.pin) this.idDocs.set(id, [v.pin]);
    const chain = this.chains.get(id) ?? [];
    chain.push(v.manifest.digest);
    this.chains.set(id, chain);
    this.factCount += v.facts.length;
  }

  /** A counter that moves with every admission. */
  logVersion(): number {
    return this.version;
  }

  /** The batches admitted after `version`, oldest first — or null if they
   *  are no longer all remembered (the caller rebuilds). */
  admittedSince(version: number): { identity: string; facts: Fact[]; seq: number }[] | null {
    if (version === this.version) return [];
    const i = this.recent.findIndex((r) => r.version === version + 1);
    return i < 0 ? null : this.recent.slice(i);
  }

  /** An identity's chain of batch digests (public: every feed shows them). */
  chainOf(identity: string): string[] {
    return [...(this.chains.get(identity) ?? [])];
  }

  head(identity: string): string | null {
    const c = this.chains.get(identity);
    return c ? c[c.length - 1]! : null;
  }

  /** An agent acts only under a live delegation from its parent — and only
   *  while EVERY identity above it in the chain still does: an expiring agent
   *  cannot outlive itself by minting a longer-lived heir. Each link is the
   *  engine's rule (delegated[sys]); a refusal names the first link that
   *  fails, with the engine's whynot. Live posts are judged at receipt, feed
   *  and offline batches at claimed_at, like key validity. Nothing else about
   *  agents exists in the node. */
  private async checkDelegation(m: Manifest, receivedAt: string, mode: Mode, pending: IdentityDoc | null): Promise<void> {
    const seen = new Set<string>();
    let agent = m.identity;
    let parent = (this.current(agent) ?? pending)?.doc.delegated_by;
    const at = Math.floor(Date.parse(receivedAt) / 1000);
    while (parent !== undefined) {
      if (seen.has(agent)) throw new Refusal(422, 'not_delegated', `the delegation chain of ${m.identity} loops at ${agent}`);
      seen.add(agent);
      const A = roflString(agent), P = roflString(parent);
      if (mode === 'post') {
        const until = (await this.engine.sysRows(`delegated_until[${SYSTEM_BOOK}](${A}, ${P}, U)`)).map((r) => Number(r[0]));
        if (!until.some((u) => at < u)) {
          const whynot = await whyNotDelegated(this.engine, agent, parent, bookOf(parent), at);
          throw new Refusal(422, 'not_delegated', `${m.identity} acts only while every identity above it does; ${agent} has no live delegation from ${parent}`, { whynot });
        }
      } else {
        const until = (await this.engine.sysRows(`delegate[${bookOf(parent)}](${A}, U)`)).map((r) => Number(r[0]) * 1000);
        if (!until.some((u) => Date.parse(m.claimed_at) < u)) {
          throw new Refusal(422, 'not_delegated', `${agent} had no live delegation from ${parent} at ${m.claimed_at}, so ${m.identity} could not act`);
        }
      }
      agent = parent;
      parent = this.current(agent)?.doc.delegated_by;
    }
  }

  /** Whose keys: the current document, or — on first contact — the one
   *  offered with this batch, to be pinned in the same commit. */
  private keysFor(identity: string, pending: IdentityDoc | null): { doc: IdentityDoc; pin: IdentityDoc | null } {
    const cur = this.current(identity);
    if (cur) return { doc: cur, pin: null };
    if (pending && pending.doc.identity === identity) return { doc: pending, pin: pending };
    throw new Refusal(422, 'unknown_identity', `${identity} is not known here; send its identity document with the first batch`);
  }

  private keyOf(doc: IdentityDoc, keyId: string): KeyEntry {
    const key = doc.doc.keys.find((k) => k.key_id === keyId);
    if (!key) throw new Refusal(422, 'unknown_key', `${doc.doc.identity} has no key with that key_id`);
    return key;
  }

  /** Nothing signed may claim a time later than its receipt plus the allowed
   *  skew (the freshness window): a future date is how a stolen key would try
   *  to stay ahead of everything signed after it (r_no_future_docs). */
  private notFuture(at: string, receivedAt: string, what: string): void {
    if (Date.parse(at) > Date.parse(receivedAt) + this.freshnessMs) {
      throw new Refusal(422, 'future_dated',
        `${what} is dated ${at}, later than its receipt (${receivedAt}) plus the allowed skew of ${this.freshnessMs / 1000} s`);
    }
  }

  private checkFresh(at: string, receivedAt: string, what: string, repair: string): void {
    const skew = Math.abs(Date.parse(at) - Date.parse(receivedAt));
    if (skew > this.freshnessMs) {
      throw new Refusal(422, 'stale',
        `stale: ${what} is ${Math.round(skew / 1000)} s from the time of receipt (window ${this.freshnessMs / 1000} s); ${repair}`);
    }
  }

  /** Steps 1–4. Pure with respect to node state: it only reads it. */
  private verify(body: BatchBody, receivedAt: string, mode: Mode, pending: IdentityDoc | null = null, upcoming: string[] = [], replaying = false): Verified {
    if (!body || typeof body !== 'object') throw new Refusal(400, 'malformed_body', 'the body is {manifest, jsonl, identity?, reattest?}');
    const m = checkManifest(body.manifest);
    // A withheld batch is a chain link without content; only a feed carries one.
    const withheld = body.withheld === true;
    if (withheld && mode !== 'feed') throw new Refusal(400, 'malformed_body', 'only a feed carries withheld batches');
    if (!withheld && typeof body.jsonl !== 'string') throw new Refusal(400, 'malformed_body', 'jsonl is a string');
    const { doc, pin } = this.keysFor(m.identity, pending);

    // 1. signature, then content against the signed digest.
    const key = this.keyOf(doc, m.key_id);
    if (!verifyManifestSig(m, key)) throw new Refusal(422, 'bad_signature', 'the manifest signature does not verify');
    let facts: Fact[] = [];
    if (!withheld) {
      const jsonl = body.jsonl as string;
      if (!isSalt(body.salt)) throw new Refusal(400, 'malformed_body', 'content travels with its salt: 32 bytes, base64url');
      if (batchDigest(body.salt, jsonl) !== m.digest) {
        throw new Refusal(422, 'digest_mismatch', 'the salt and JSONL do not hash to the signed digest');
      }
      facts = parseJsonl(jsonl, !replaying);
      if (facts.length !== m.count) throw new Refusal(422, 'count_mismatch', `signed count ${m.count}, found ${facts.length}`);
    }

    // (A live POST is held to the freshness window in both directions below.)
    if (mode !== 'post') this.notFuture(m.claimed_at, receivedAt, 'the batch');
    // 2. key valid at claimed_at.
    if (!keyValidAt(key, Date.parse(m.claimed_at))) {
      throw new Refusal(422, 'key_not_valid', `the key was not valid at the claimed time ${m.claimed_at}`);
    }
    // ...and, for a revoked key, a batch it signed counts only if it was
    // received before the revocation, or is PROVEN to stand at or before the
    // head the owner vouched for when revoking (r_revocation_bound): it is
    // that head, or that head follows it in the same delivery (a feed is one
    // contiguous chain). claimed_at is the signer's word, and a thief's word
    // is worthless here.
    if (key.revoked_at) {
      const lastGood = key.last_good ?? null;
      const before = mode === 'post'
        ? Date.parse(receivedAt) < Date.parse(key.revoked_at)
        : lastGood !== null && (m.digest === lastGood || upcoming.includes(lastGood));
      if (!before) {
        throw new Refusal(422, 'key_revoked',
          `the key that signed this batch was revoked at ${key.revoked_at}, and the batch was neither received before that nor stands before it in the chain`);
      }
    }

    // A re-attestation: the same digest signed again, by a key valid when it was.
    let reattest: Attestation | null = null;
    if (body.reattest !== undefined) {
      const r = body.reattest as Attestation;
      if (!r || typeof r !== 'object' || typeof r.sig !== 'string' || !isTime(r.attested_at) || typeof r.key_id !== 'string') {
        throw new Refusal(400, 'malformed_reattest', 'a re-attestation is {identity, key_id, digest, attested_at, sig}');
      }
      if (r.identity !== m.identity || r.digest !== m.digest) {
        throw new Refusal(422, 'bad_reattest', 'the re-attestation is for another identity or digest');
      }
      const rk = this.keyOf(doc, r.key_id);
      if (!verifySigned(REATTEST_CONTEXT, r, rk)) throw new Refusal(422, 'bad_signature', 'the re-attestation signature does not verify');
      if (!keyValidAt(rk, Date.parse(r.attested_at))) throw new Refusal(422, 'key_not_valid', 'the re-attesting key was not valid then');
      reattest = { identity: r.identity, key_id: r.key_id, digest: r.digest, attested_at: r.attested_at, sig: r.sig };
    }

    // 3. chain.
    const chain = this.chains.get(m.identity) ?? [];
    if (chain.includes(m.digest)) throw new Refusal(409, 'duplicate', 'this batch is already in the chain');
    const head = chain.length ? chain[chain.length - 1]! : null;
    if (m.prev !== head) {
      throw new Refusal(409, 'chain_mismatch',
        `prev must be the head of ${m.identity}'s chain (${head ?? 'null: this is its first batch'})`);
    }

    // 4. freshness, of whichever signature vouches for this receipt.
    if (mode === 'post') {
      if (reattest) {
        this.checkFresh(reattest.attested_at, receivedAt, 'the re-attestation', 're-attest again with a current time');
      } else {
        this.checkFresh(m.claimed_at, receivedAt, 'claimed_at',
          're-attestation requested: the publisher signs the same digest again with a current claimed_at');
      }
    }
    // User rules are checked here, with the batch: a rule that would conclude
    // outside its author's book refuses the whole batch.
    const rules = facts.filter((f) => f.relation === RULE).map((f) => compileRule(f.target, m.identity));
    return { manifest: m, facts, pin, reattest, withheld, rules };
  }

  /** Admit one batch, serialised against every other admission. */
  admit(body: BatchBody, by: string | null = null): Promise<Receipt> {
    return this.serial(() => this.admitNow(body, 'post', new Date(this.now()).toISOString(), [], by));
  }

  /** One operation at a time. A dead engine is rebuilt first; an engine that
   *  dies DURING the operation is rebuilt after it, and the operation is
   *  REFUSED (503 engine_down): a write was not admitted, and a read is never
   *  answered from a world that died under it (r_engine_crash_recovery). The
   *  next operation is served by the rebuilt engine. */
  private serial<T>(f: () => Promise<T>, retry = false): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.engine.dead || this.engine.stale) await this.rebuildEngine();
      try {
        return await f();
      } catch (e) {
        if (!this.engine.dead) throw e;
        await this.rebuildEngine();
        void retry;
        throw e instanceof Refusal && e.reason === 'engine_down' ? e
          : new Refusal(503, 'engine_down', 'the engine stopped during this operation; nothing was admitted; the engine is rebuilt from the log — send it again');
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async admitNow(body: BatchBody, mode: 'post' | 'feed' | 'offline', receivedAt: string, upcoming: string[], by: string | null): Promise<Receipt> {
    const ident = (body?.manifest as Manifest | undefined)?.identity;
    const pending = body?.identity !== undefined && typeof ident === 'string'
      ? await this.applyChain(ident, body.identity, receivedAt, true, by) : null;
    const v = this.verify(body, receivedAt, mode, pending, upcoming);
    await this.checkDelegation(v.manifest, receivedAt, mode, pending);
    const id = v.manifest.identity;
    const rules = this.chains.has(id) ? null : bookRules(bookOf(id), id);
    const seq = this.chains.get(id)?.length ?? 0;
    const plan = this.assertions.plan(id, bookOf(id), v.facts, seq);
    const staged = await this.engine.stage(programOf(v, seq) + plan.load, id, rules, () => this.fault('engine:staged'));
    try {
      await this.engine.retract(plan.retract);
    } catch (e) {
      await staged.abort();
      throw e;
    }
    let receipt: Receipt;
    try {
      receipt = this.log.append(v.manifest, v.withheld ? null : body.jsonl as string, receivedAt, v.pin, {
        ...(mode === 'feed' ? { via: 'feed' as const } : mode === 'offline' ? { via: 'envelope' as const } : {}),
        ...(v.reattest ? { reattest: v.reattest } : {}),
        ...(v.withheld ? { withheld: true as const } : { salt: body.salt as string }),
      });
    } catch (e) {
      await staged.abort();
      throw e;
    }
    await staged.commit();
    this.record(v, mode !== 'post', seq, plan);
    return receipt;
  }

  /** ENGINE CRASH RECOVERY (r_engine_crash_recovery): the engine is derived
   *  data. When its process dies, the next operation starts a fresh one and
   *  replays what this node holds — the same facts, in the same chain order,
   *  that replay from the log gives. Rule worlds lived in the dead process and
   *  are rebuilt lazily. The log was never touched by the crash: an admission
   *  commits to the log only after the engine has taken the batch. */
  private async rebuildEngine(): Promise<void> {
    this.worlds.clear();
    const e = await Engine.fresh(this.bin);
    const entries: Parameters<Engine['replay']>[0] = [];
    for (const [id, progs] of this.programs) {
      progs.forEach((rofl, i) => entries.push({ rofl, who: id, rules: i === 0 ? bookRules(bookOf(id), id) : null }));
      entries.push({ rofl: this.assertions.lines(id, bookOf(id)), who: id, rules: null });
    }
    await e.replay(entries);
    // A stale engine is alive (an aborted admission left it holding what the
    // log does not): it is stopped, or every abort would leave a whole engine
    // process behind (r_bounded_memory).
    const old = this.engine;
    this.engine = e;
    this.engineRestarts++;
    await old.stop().catch(() => {});
  }

  /** The engine process id — for tests that kill it. */
  enginePid(): number | undefined {
    return this.engine.pid();
  }

  /** What `requester` may see, book by book. The node's own identity sees
   *  everything held here (it holds the bytes anyway). Anyone else sees a book
   *  whole if the engine derives may_read for it — its owner, or a live grant —
   *  and otherwise only the facts an export rule derives for it or for
   *  "public". An unsigned request is "public" only. */
  private async scopeFor(requester: string | null): Promise<Map<string, BookScope>> {
    const scope = new Map<string, BookScope>();
    const books = [...this.chains.keys()].map((id) => [bookOf(id), id] as const);
    if (requester !== null && requester === this.identity?.name) {
      for (const [b, id] of books) scope.set(b, { identity: id, only: null });
      return scope;
    }
    const now = Math.floor(this.now() / 1000);
    const whole = new Set(requester === null ? [] :
      (await this.engine.sysRows(`readable_until[${SYSTEM_BOOK}](${roflString(requester)}, B, U)`))
        .filter((r) => now < Number(r[1])).map((r) => String(r[0])));
    const exported = new Map<string, Set<string>>();
    for (const [b, f, a] of await this.engine.sysRows(`exported[${SYSTEM_BOOK}](B, F, A)`)) {
      if (a !== 'public' && a !== requester) continue;
      if (!exported.has(String(b))) exported.set(String(b), new Set());
      exported.get(String(b))!.add(String(f));
    }
    for (const [b, id] of books) {
      if (whole.has(b)) scope.set(b, { identity: id, only: null });
      else if (exported.has(b)) scope.set(b, { identity: id, only: exported.get(b)! });
    }
    return scope;
  }

  /** Refuse a question that names a book the requester may not read, with the
   *  ENGINE's explanation of the missing grant. */
  private async requireBook(query: string, requester: string | null, scope: Map<string, BookScope>, whole: boolean): Promise<void> {
    const { book } = parseLiteral(query);
    if (book === null) return;
    const sc = scope.get(book);
    if (sc && (sc.only === null || !whole)) return;
    const owner = [...this.chains.keys()].find((id) => bookOf(id) === book);
    if (!owner) throw new Refusal(404, 'unknown_book', `no book ${book} here`);
    if (requester === null) {
      throw new Refusal(401, 'unsigned', `${owner}'s book is not public; sign the request as an identity it grants`);
    }
    const whynot = await whyNotReadable(this.engine, requester, book, owner, Math.floor(this.now() / 1000));
    throw new Refusal(403, 'no_grant', `${requester} has no live grant to read ${owner}'s book`, { whynot });
  }

  ask(query: string, requester: string | null = null, perspective: string | null = null): Promise<AskAnswer> {
    return this.serial(async () => {
      const scope = await this.scopeFor(requester);
      await this.requireBook(query, requester, scope, false);
      this.fault('engine:ask');
      const { rel, book, args } = parseLiteral(query);
      if (perspective !== null || rel === 'conf' || rel === 'persp') return this.askAssertions(rel, book, args, scope, perspective);
      const ans: AskAnswer = rel === 'answered' ? { vars: [], rows: [] } : await this.engine.ask(query, scope);
      // What the authors' own rules derive, from their rule worlds.
      const seen = new Set(ans.rows.map((r) => JSON.stringify([r.identity, r.cells])));
      const unknown: NonNullable<AskAnswer['unknown']> = [];
      for (const [b, sc] of scope) {
        if (sc.only !== null || (book !== null && book !== b)) continue;
        unknown.push(...await this.silentFeeds(sc.identity));
        const w = await this.ruleWorld(sc.identity);
        if (!w) continue;
        const q = rel === 'answered' ? `answered[${SYSTEM_BOOK}](${roflString(b)}, ${args})` : `${rel}[${b}](${args})`;
        let a;
        try { a = await w.ask(q); } catch (e) {
          if (this.engine.dead) throw e;       // a death is never an empty answer
          continue;                            // the relation is not in this world
        }
        if (ans.vars.length === 0) ans.vars = a.vars;
        for (const r of a.rows) {
          const row = { identity: sc.identity, cells: r.map(decodeCell) };
          const k = JSON.stringify([row.identity, row.cells]);
          if (!seen.has(k)) { seen.add(k); ans.rows.push(row); }
        }
        if (w.partial) unknown.push({ identity: sc.identity, reason: w.holes.join('; '), budget: this.ruleBudget, unit: 'steps' });
      }
      if (unknown.length) ans.unknown = unknown;
      ans.rows.sort((x, y) => { const p = JSON.stringify([x.identity, x.cells]), q = JSON.stringify([y.identity, y.cells]); return p < q ? -1 : p > q ? 1 : 0; });
      return ans;
    }, true);
  }

  /** conf(F, C), persp(F, P), and edge(F, S, R, T) restricted to a
   *  perspective — from the current assertions admission keeps
   *  (src/assertions.ts), within the reader's scope. */
  private async askAssertions(rel: string, book: string | null, args: string, scope: Map<string, BookScope>, perspective: string | null): Promise<AskAnswer> {
    const a = splitArgs(args);
    const books = [...scope].filter(([b]) => book === null || b === book);
    if (book !== null && books.length === 0) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
    const rows: AskAnswer['rows'] = [];
    let vars = a.filter((x, i) => x === '_' || (/^[A-Z_]/.test(x) && a.indexOf(x) === i));
    if (perspective !== null) {
      if (rel !== 'edge' || a.length !== 4) throw new Refusal(400, 'bad_query', 'a perspective restricts edge(F, S, R, T) questions');
      for (const [b, sc] of books) {
        const r = await this.engine.ask(`edge[${b}](${args})`, new Map([[b, sc]]));
        vars = r.vars;
        const cur = this.assertions.of(sc.identity);
        const fAt = /^[A-Z_]/.test(a[0]!) && a[0] !== '_' ? r.vars.indexOf(a[0]!) : -1;
        for (const row of r.rows) {
          const F = fAt >= 0 ? String(row.cells[fAt]) : a[0] === '_' ? null : String(JSON.parse(a[0]!));
          if (F !== null && cur.get(F)?.P === perspective) rows.push(row);
        }
      }
    } else {
      if (a.length !== 2) throw new Refusal(400, 'bad_query', `${rel} takes 2 arguments`);
      for (const [, sc] of books) {
        for (const [F, c] of this.assertions.of(sc.identity)) {
          if (sc.only !== null && !sc.only.has(F)) continue;
          const m = match(a, [F, rel === 'conf' ? c.C : c.P]);
          if (m) rows.push({ identity: sc.identity, cells: m.cells });
        }
      }
    }
    rows.sort((x, y) => { const p = JSON.stringify([x.identity, x.cells]), q = JSON.stringify([y.identity, y.cells]); return p < q ? -1 : p > q ? 1 : 0; });
    return { vars, rows };
  }

  why(query: string, requester: string | null = null): Promise<Explanation[]> {
    return this.serial(async () => this.explainWith('why', query, requester), true);
  }

  whynot(query: string, requester: string | null = null): Promise<Explanation[]> {
    return this.serial(async () => this.explainWith('whynot', query, requester), true);
  }

  /** Explanations, each from the world that derives the literal: an author's
   *  rule world for what its rules conclude (and answered), else main. */
  private async explainWith(op: 'why' | 'whynot', query: string, requester: string | null): Promise<Explanation[]> {
    const scope = await this.scopeFor(requester);
    await this.requireBook(query, requester, scope, true);
    this.fault('engine:explain');
    const { rel, book, args } = parseLiteral(query);
    const out = rel === 'answered'
      ? [...scope].filter(([b, sc]) => sc.only === null && (book === null || b === book)).map(([, sc]) => ({ identity: sc.identity, holds: false, text: `whynot answered: ${sc.identity} has no rules here` }))
      : await (op === 'why' ? this.engine.why(query, scope) : this.engine.whynot(query, scope));
    for (const e of out) {
      if (!this.headsOf(e.identity).has(rel) && rel !== 'answered') continue;
      const w = await this.ruleWorld(e.identity);
      if (!w) continue;
      const b = bookOf(e.identity);
      const q = rel === 'answered' ? `answered[${SYSTEM_BOOK}](${roflString(b)}, ${args})` : `${rel}[${b}](${args})`;
      const r = await w.explain(op, q);
      e.holds = r.holds;
      e.text = r.text;
      if (w.partial) e.unknown = { reason: w.holes.join('; '), budget: this.ruleBudget, unit: 'steps' };
    }
    return out;
  }

  private headsOf(author: string): Set<string> {
    return new Set((this.userRules.get(author) ?? []).map((r) => /^([a-z][A-Za-z0-9_]*)\[/.exec(r.text)?.[1] ?? ''));
  }

  /** Rules that run for `author` here: the operator's own, and another
   *  identity's only while this node's operator TRUSTS it for rules — whether
   *  its rules came by mirror or were posted here by the author: a stranger is
   *  admitted on first contact, and must not get code execution by it
   *  (r_foreign_rules_opt_in). A book brings its facts, never its code, by
   *  default. Trust is a fact in the operator's own book:
   *    {source: <author>, relation: "roflenox:trust_rules", target: <anything>}
   *  with a current confidence above 0 (re-asserting it at 0 withdraws it). */
  private async runnableRules(author: string): Promise<string[]> {
    const all = (this.userRules.get(author) ?? []).map((r) => r.text);
    if (all.length === 0) return all;
    const op = this.identity?.name;
    if (author === op) return all;
    if (!op || !this.chains.has(op)) return [];
    const b = bookOf(op);
    const facts = await this.engine.sysRows(`edge[${b}](F, ${roflString(author)}, "roflenox:trust_rules", T)`);
    const cur = this.assertions.of(op);
    return facts.some((r) => (cur.get(String(r[0]))?.C ?? 0) > 0) ? all : [];
  }

  /** The feeds `author` follows that have gone SILENT: nothing claimed within
   *  the silence window, or never anything. Whether or not any rule reads
   *  them: an answer from a book that follows a silent feed is not an
   *  all-clear, so each one is an unknown beside the rows (r_uc_observability). */
  private async silentFeeds(author: string): Promise<Unknown[]> {
    if (!this.chains.has(author)) return [];
    const cur = this.assertions.of(author);
    const follows = await this.engine.sysRows(`edge[${bookOf(author)}](F, P, "roflenox:follow", U)`);
    const followed = [...new Set(follows.filter((r) => (cur.get(String(r[0]))?.C ?? 0) > 0).map((r) => String(r[1])))].sort();
    const now = this.now();
    const out: Unknown[] = [];
    for (const p of followed) {
      const last = this.lastClaimed.get(p);
      if (last !== undefined && now - last <= this.silenceSec * 1000) continue;
      out.push({ identity: p, reason: last === undefined ? 'silent_feed: nothing ever received from it' : `silent_feed: nothing claimed for ${Math.floor((now - last) / 1000)} s`,
        window: this.silenceSec, last_report: last === undefined ? null : new Date(last).toISOString() });
    }
    return out;
  }

  /** The author's rule world, rebuilt when anything was admitted since, and
   *  re-evaluated when the clock (grant expiry) moved. */
  private async ruleWorld(author: string): Promise<World | null> {
    const rules = await this.runnableRules(author);
    if (!rules.length) {
      const stale = this.worlds.get(author);
      if (stale) { await stale.w.close(); this.worlds.delete(author); }
      return null;
    }
    const clock = Math.floor(this.now() / 1000);
    const cached = this.worlds.get(author);
    if (cached && cached.version === this.version) {
      if (cached.clock !== clock) { await cached.w.setClock(clock); cached.clock = clock; }
      return cached.w;
    }
    if (cached) { await cached.w.close(); this.worlds.delete(author); }
    const own = bookOf(author);
    const owners = new Map([...this.chains.keys()].map((id) => [bookOf(id), id]));
    const named = [...new Set([...rules.join('\n').matchAll(/\[(b_[0-9a-f]{16})\]/g)].map((m) => m[1]!))];
    // A rule with a book VARIABLE reads every book its author may read: load
    // each one with a live grant (the rule's may_read_book premise still
    // decides, at the world's clock).
    const ranging = rules.some((r) => /may_read_book\[/.test(r));
    const granted = ranging
      ? (await this.engine.sysRows(`readable_until[${SYSTEM_BOOK}](${roflString(author)}, B, U)`)).filter((r) => clock < Number(r[1])).map((r) => String(r[0]))
      : [];
    const foreign = [...new Set([...named, ...granted])].filter((b) => b !== own);
    const w = await this.engine.world(this.ruleBudget);
    await w.session.load(`clock[${SYSTEM_BOOK}](${clock}).\n`, 'roflenox');
    for (const b of [own, ...foreign]) {
      const id = owners.get(b);
      if (!id) continue;
      const text = (this.programs.get(id) ?? []).join('') + this.assertions.lines(id, b);
      if (text) await w.session.load(text, id);
      if (b !== own || ranging) await w.session.load(mayReadRules(b, id), 'roflenox');
    }
    for (const [id, lines] of this.results) {
      if (id !== author && !foreign.includes(bookOf(id))) await w.session.load(lines.join(''), id);
      await w.session.load(resultRule(bookOf(id), id), 'roflenox');
    }
    await w.session.load(answeredRule(own), 'roflenox');
    try {
      await w.session.load(rules.map((r) => `${r}\n`).join(''), author);
      await w.evaluate();
    } catch (e) {
      if (this.engine.dead) throw e;
      w.partial = true;
      w.holes = [`engine_refused: ${(e as Error).message.slice(0, 200)}`];
    }
    this.worlds.set(author, { w, version: this.version, clock });
    return w;
  }

  /** OFFLINE ADMISSION (r_offline_admission): a sealed envelope addressed to
   *  this node's identity. There is no live channel, so no freshness: the
   *  batch is judged by its signing key's validity at claimed_at, against the
   *  freshest chain this node has for the signer — what it already knew, plus
   *  anything newer the envelope carries. A key revoked before the batch
   *  claims to have been signed does not sign it. Only an envelope this node
   *  can open is taken this way, never a bare stale POST. */
  admitSealed(envelope: unknown, by: string | null = null): Promise<Receipt> {
    return this.serial(async () => {
      const me = this.identity;
      if (!me) throw new Refusal(404, 'no_identity', 'this node has no identity to open envelopes with');
      const inner = openSealed(envelope as Envelope, me.name, me.encPrivateKey());
      const receivedAt = new Date(this.now()).toISOString();
      return this.admitNow({ manifest: inner.manifest, jsonl: inner.jsonl, salt: inner.salt, identity: inner.identity }, 'offline', receivedAt, [], by);
    });
  }

  /** Publish `facts` as this node's own identity, through normal admission:
   *  a signed, salted, chained batch like any other (the MCP `assert` tool). */
  assertAsSelf(facts: Fact[]): Promise<Receipt> {
    return this.serial(async () => {
      const me = this.identity;
      if (!me) throw new Refusal(404, 'no_identity', 'this node has no identity to assert as');
      const jsonl = toJsonl(facts);
      const salt = newSalt();
      const manifest = me.signBatch(jsonl, this.head(me.name), new Date(this.now()).toISOString(), salt);
      return this.admitNow({ manifest, jsonl, salt, identity: me.identityChain() }, 'post', new Date(this.now()).toISOString(), [], me.name);
    });
  }

  /** Search by meaning (r_semantic_search, r_derived_rebuildable). The node
   *  embeds nothing: a search is a fact in the operator's book, a rule makes
   *  it an intent to the embedder the book names, and the embedder answers
   *  with a result fact in ITS book. An answer is therefore in the log — the
   *  node gives the same one with the embedder gone, and after a rebuild.
   *  Only the operator asks (a read by anyone else never writes); anyone gets
   *  what was answered, and the caller filters hits by what it may read. */
  async meaningSearch(query: string, requester: string | null): Promise<MeaningSearch> {
    const key = searchKey(query);
    const found = await this.serial(async () => {
      const op = this.identity?.name;
      if (!op || !this.chains.has(op)) return { state: 'no_embedder' as const, key, hits: [] };
      const b = bookOf(op);
      const cur = this.assertions.of(op);
      const named = await this.engine.sysRows(`edge[${b}](F, E, ${roflString(EMBEDDER)}, "search")`);
      const embedders = [...new Set(named.filter((r) => (cur.get(String(r[0]))?.C ?? 0) > 0).map((r) => String(r[1])))].sort();
      if (embedders.length === 0) return { state: 'no_embedder' as const, key, hits: [] };
      for (const e of embedders.filter((x) => this.chains.has(x))) {
        const theirs = this.assertions.of(e);
        const rows = (await this.engine.sysRows(`edge[${bookOf(e)}](F, ${roflString(key)}, ${roflString(RESULT)}, V)`))
          .map((r) => ({ c: theirs.get(String(r[0])), v: String(r[1]) }))   // cells are the variables: F, V.filter((r) => (r.c?.C ?? 0) > 0)
          .sort((x, y) => y.c!.S - x.c!.S);
        if (rows.length === 0) continue;
        let hits: SearchHit[];
        try { hits = (JSON.parse(rows[0]!.v) as { hits: SearchHit[] }).hits; } catch { continue; }
        return { state: 'answered' as const, key, embedder: e, hits: Array.isArray(hits) ? hits : [] };
      }
      const asked = (await this.engine.sysRows(`edge[${b}](F, ${roflString(key)}, ${roflString(SEARCH)}, Q)`)).length > 0;
      return { state: asked ? 'pending' as const : 'not_asked' as const, key, embedder: embedders[0], hits: [] };
    });
    if (found.state !== 'not_asked' || requester === null || requester !== this.identity?.name) return found;
    await this.assertAsSelf([{ source: key, relation: SEARCH, target: query, perspective: 'search', confidence: 1 }]);
    return { ...found, state: 'pending' };
  }

  /** The operator's bearer token (see operatorTokenOf). */
  operatorToken(): string {
    return operatorTokenOf(this.dataDir);
  }

  /** A one-time challenge for pulling a feed (this node as the READER),
   *  STATELESS (r_challenge_stateless): random ‖ expiry ‖ HMAC(node key, both).
   *  Issuing stores nothing, so a flood of requests costs no memory and
   *  denies nobody else a challenge. */
  issueChallenge(): string {
    const body = Buffer.alloc(24);
    crypto.randomFillSync(body, 0, 16);
    body.writeBigUInt64BE(BigInt(this.now() + this.freshnessMs), 16);
    return Buffer.concat([body, this.challengeMac(body)]).toString('base64url');
  }

  private challengeMac(body: Buffer): Buffer {
    return crypto.createHmac('sha256', this.challengeKey).update(body).digest().subarray(0, 16);
  }

  /** Is `nonce` a live challenge this node issued and no verified feed has used? */
  private challengeLive(nonce: string): boolean {
    const raw = Buffer.from(nonce, 'base64url');
    if (raw.length !== 40) return false;
    if (!crypto.timingSafeEqual(this.challengeMac(raw.subarray(0, 24)), raw.subarray(24))) return false;
    if (Number(raw.readBigUInt64BE(16)) < this.now()) return false;
    return !this.consumed.has(nonce);
  }

  /** Remember a challenge a VERIFIED feed used, until it would expire anyway. */
  private consume(nonce: string): void {
    const now = this.now();
    for (const [n, exp] of this.consumed) if (exp < now) this.consumed.delete(n);
    this.consumed.set(nonce, Number(Buffer.from(nonce, 'base64url').readBigUInt64BE(16)));
  }

  /** Admit a peer's feed under a challenge this node issued. The challenge is
   *  consumed once the publisher's answer to it VERIFIES; a refused feed
   *  leaves nothing behind. */
  admitFeed(body: FeedBody, by: string | null = null): Promise<{ admitted: number }> {
    return this.serial(async () => {
      const receivedAt = new Date(this.now()).toISOString();
      if (!body || typeof body !== 'object' || !Array.isArray(body.batches)) {
        throw new Refusal(400, 'malformed_body', 'the body is {identity?, batches, attestation, nonce}');
      }
      // No live answer, but a checkpoint: a static copy of the feed.
      if (body.attestation === undefined && body.checkpoint !== undefined) return this.admitCheckpointed(body, receivedAt, by);
      if (body.attestation === undefined) {
        throw new Refusal(422, 'no_attestation', 'a feed is admitted with the publisher\'s live answer to a challenge, or a checkpoint');
      }
      const nonce = String(body.nonce);
      if (!this.challengeLive(nonce)) {
        throw new Refusal(422, 'challenge_unknown',
          'this feed does not answer a live challenge from this node (never issued here, already used, or expired); pull again with a fresh one');
      }
      const a = body.attestation as FeedAttestation;
      if (!a || typeof a !== 'object' || typeof a.sig !== 'string' || typeof a.identity !== 'string' || !isTime(a.attested_at)) {
        throw new Refusal(422, 'no_attestation', 'a feed is admitted only with the publisher\'s signature over its head and the challenge');
      }
      if (a.nonce !== nonce) throw new Refusal(422, 'challenge_mismatch', 'the attestation answers a different challenge');
      const pending = body.identity !== undefined ? await this.applyChain(a.identity, body.identity, receivedAt, true, by) : null;
      const { doc } = this.keysFor(a.identity, pending);
      const key = this.keyOf(doc, a.key_id);
      if (!verifySigned(FEED_CONTEXT, a, key)) throw new Refusal(422, 'bad_signature', 'the feed attestation does not verify');
      if (!keyValidAt(key, Date.parse(a.attested_at))) throw new Refusal(422, 'key_not_valid', 'the attesting key was not valid then');
      this.checkFresh(a.attested_at, receivedAt, 'the feed attestation', 'pull again with a fresh challenge');
      const last = body.batches.length ? (body.batches[body.batches.length - 1]!.manifest as Manifest)?.digest : this.head(a.identity);
      if (a.head !== last) throw new Refusal(422, 'head_mismatch', 'the attested head is not the last batch of this feed');
      this.consume(nonce);
      let admitted = 0;
      const digests = body.batches.map((b) => String((b.manifest as Manifest)?.digest));
      for (const [i, b] of body.batches.entries()) {
        if ((b.manifest as Manifest)?.identity !== a.identity) {
          throw new Refusal(422, 'identity_mismatch', 'a feed carries batches of the attested identity only');
        }
        await this.admitNow({ ...b, identity: body.identity }, 'feed', receivedAt, digests.slice(i + 1), by);
        admitted++;
      }
      return { admitted };
    });
  }

  /** A feed from a static copy: vouched for by the publisher's checkpoint,
   *  signed at most the checkpoint window ago, over exactly this head. A live
   *  challenge is preferred whenever the publisher answers one; this is for
   *  the node that is a directory of files (r_static_feed). */
  private async admitCheckpointed(body: FeedBody, receivedAt: string, by: string | null): Promise<{ admitted: number }> {
    const c = body.checkpoint as Checkpoint;
    if (!c || typeof c !== 'object' || typeof c.sig !== 'string' || typeof c.identity !== 'string'
      || typeof c.key_id !== 'string' || !isTime(c.checkpoint_at)) {
      throw new Refusal(422, 'no_attestation', 'a checkpoint is {identity, key_id, head, checkpoint_at, sig}');
    }
    const pending = body.identity !== undefined ? await this.applyChain(c.identity, body.identity, receivedAt, true, by) : null;
    const { doc } = this.keysFor(c.identity, pending);
    const key = this.keyOf(doc, c.key_id);
    if (!verifySigned(CHECKPOINT_CONTEXT, c, key)) throw new Refusal(422, 'bad_signature', 'the checkpoint does not verify');
    if (!keyValidAt(key, Date.parse(c.checkpoint_at))) throw new Refusal(422, 'key_not_valid', 'the checkpointing key was not valid then');
    this.notFuture(c.checkpoint_at, receivedAt, 'the checkpoint');
    const age = Date.parse(receivedAt) - Date.parse(c.checkpoint_at);
    if (age > this.checkpointWindowMs) {
      throw new Refusal(422, 'checkpoint_expired',
        `the checkpoint is ${Math.round(age / 1000)} s old (window ${this.checkpointWindowMs / 1000} s); the publisher checkpoints again, or answers a live challenge`);
    }
    const last = body.batches.length ? (body.batches[body.batches.length - 1]!.manifest as Manifest)?.digest : this.head(c.identity);
    if (c.head !== last) throw new Refusal(422, 'head_mismatch', 'the checkpointed head is not the last batch of this feed');
    let admitted = 0;
    const digests = body.batches.map((b) => String((b.manifest as Manifest)?.digest));
    for (const [i, b] of body.batches.entries()) {
      if ((b.manifest as Manifest)?.identity !== c.identity) {
        throw new Refusal(422, 'identity_mismatch', 'a feed carries batches of the checkpointed identity only');
      }
      await this.admitNow({ ...b, identity: body.identity }, 'feed', receivedAt, digests.slice(i + 1), by);
      admitted++;
    }
    return { admitted };
  }

  /** An identity's batches after `after`, byte-for-byte as signed, as far as
   *  `reader` may have them (r_default_deny): a batch travels with its content
   *  only if the reader may read the book whole, or every fact in it is
   *  exported to the reader or to "public"; otherwise only its signed manifest
   *  travels, marked withheld, so the chain still verifies. Before anything is
   *  signed or sent, a leak audit re-reads every outgoing line on its own.
   *  With a challenge, and when this node IS that identity, the head is attested. */
  feed(identity: string, after: string | null, challenge: string | null = null, reader: string | null = null): Promise<{
    identity: IdentityDoc[]; batches: FeedEntry[]; attestation?: FeedAttestation;
  }> {
    return this.serial(async () => {
      const chain = this.chains.get(identity);
      const doc = this.idDocs.get(identity);
      if (!chain || !doc) throw new Refusal(404, 'unknown_identity', `no feed for ${identity}`);
      let from = 0;
      if (after !== null) {
        const i = chain.indexOf(after);
        if (i < 0) throw new Refusal(404, 'unknown_after', `${after} is not in ${identity}'s chain`);
        from = i + 1;
      }
      const sc = (await this.scopeFor(reader)).get(bookOf(identity));
      const allowed = (fid: string) => sc !== undefined && (sc.only === null || sc.only.has(fid));
      const byDigest = new Map(this.log.receipts.filter((r) => r.identity === identity && r.kind !== 'identity').map((r) => [r.digest, r]));
      const batches = chain.slice(from).map((d): FeedEntry => {
        const s = this.log.read(byDigest.get(d)!);
        const extra = s.receipt.reattest ? { reattest: s.receipt.reattest } : {};
        if (s.jsonl === null || !parseJsonl(s.jsonl).every((f) => allowed(factId(f)))) {
          return { manifest: s.manifest, withheld: true, ...extra };
        }
        return { manifest: s.manifest, jsonl: s.jsonl, salt: s.salt!, ...extra };
      });
      await this.leakAudit(identity, batches, reader);
      if (challenge !== null && this.identity?.name === identity) {
        const attestation = this.identity.sign(FEED_CONTEXT, {
          identity, key_id: this.identity.keyId, head: this.head(identity), nonce: challenge,
          attested_at: new Date(this.now()).toISOString(),
        });
        return { identity: doc, batches, attestation };
      }
      return { identity: doc, batches };
    });
  }

  /** The leak audit: independent of the filter above, every outgoing line is
   *  parsed again and checked against the engine asked afresh — may_read for
   *  the reader on this book, or an exported fact for the reader or "public".
   *  One failure and nothing leaves. */
  private async leakAudit(identity: string, batches: FeedEntry[], reader: string | null): Promise<void> {
    const out = batches.filter((b) => b.jsonl !== undefined);
    if (out.length === 0 || (reader !== null && reader === this.identity?.name)) return;
    const book = bookOf(identity);
    if (reader !== null) {
      const now = Math.floor(this.now() / 1000);
      const whole = await this.engine.sysRows(`readable_until[${SYSTEM_BOOK}](${roflString(reader)}, ${roflString(book)}, U)`);
      if (whole.some((r) => now < Number(r[0]))) return;
    }
    const audiences = reader === null ? ['public'] : ['public', reader];
    const ok = new Set<string>();
    for (const a of audiences) {
      for (const [f] of await this.engine.sysRows(`exported[${SYSTEM_BOOK}](${roflString(book)}, F, ${roflString(a)})`)) ok.add(String(f));
    }
    for (const b of out) {
      for (const line of b.jsonl!.split('\n').filter(Boolean)) {
        if (!ok.has(factId(JSON.parse(line) as Fact))) {
          throw new Refusal(500, 'leak_audit', 'the leak audit stopped a feed carrying a fact with no export for its reader');
        }
      }
    }
  }

  health(): Record<string, unknown> {
    return {
      identity: this.identity?.name ?? null,
      heads: Object.fromEntries([...this.chains.keys()].sort().map((id) => [id, this.head(id)])),
      facts: this.factCount,
      batches: this.log.receipts.filter((r) => r.kind !== 'identity').length,
      log_head: this.log.head(),
      engine: { up: !this.engine.dead, restarts: this.engineRestarts },
      warnings: this.warnings,
      recovered: this.log.recovered,
      challenges_remembered: this.consumed.size,
      recent_facts_remembered: this.recentFacts,
    };
  }

  async close(): Promise<void> {
    await this.queue;
    for (const { w } of this.worlds.values()) await w.close().catch(() => {});
    await this.engine.stop();
  }
}
