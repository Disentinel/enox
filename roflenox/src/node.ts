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
import * as v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as zlib from 'node:zlib';
import { canonicalize } from './jcs.ts';
import { batchDigest, decodeCell, DELEGATE, EMBEDDER, EXPORT, factId, GRANT, isSalt, newSalt, parseJsonl, Refusal, roflString, SEARCH, sha256hex, toJsonl, toRofl, type Fact } from './facts.ts';
import {
  bookOf, canonicalOrNull, CHECKPOINT_CONTEXT, checkIdentityDoc, checkManifest, docHash, docSignedBy, FEED_CONTEXT, isTime, keyValidAt, LocalIdentity,
  REATTEST_CONTEXT, verifyIdentityDoc, verifyManifestSig, verifySigned,
  type Attestation, type Checkpoint, type FeedAttestation, type IdentityDoc, type KeyEntry, type Manifest,
} from './identity.ts';
import { Log, writeFileAtomic, type Fault, type Receipt } from './log.ts';
import {
  answeredRule, bookRules, Collect, DEFAULT_ROFL_BIN, Engine, FOREVER, mayReadRules, parseLiteral, parseQuery, resultRule, sortRows, splitArgs, SYSTEM_BOOK,
  type AskAnswer, type AskOptions, type BookScope, type Explanation, type QueryLiteral, type Unknown, type World,
} from './engine.ts';
import { DomainVouch, type DomainTransport } from './domain.ts';
import { verifyRequest } from './httpsig.ts';
import { compileRule, RULE } from './rules.ts';
import { RESULT } from './executor.ts';
import { Assertions, match, oneValue, type Current, type View } from './assertions.ts';
import { whyNotDelegated, whyNotReadable } from './expiry.ts';
import { open as openSealed, type Envelope } from './seal.ts';
import { OAuth, type OAuthOptions } from './oauth.ts';

export const DEFAULT_FRESHNESS_SEC = 300;

/** The predicates every book answers, with their arities where fixed: the
 *  engine's (src/facts.ts toRofl, src/assertions.ts control rows, the system
 *  rules of src/engine.ts) and the node's own (conf, persp, asserted,
 *  answered). An author's rules add their heads. */
export const ARITY: Record<string, number> = {
  edge: 4, edge_num: 4, live: 4, asserted: 4, conf: 2, admitted_at: 2, persp: 2, answered: 3, intent: 4, grant: 2, delegate: 2, export: 2, follows: 2, trusts: 1,
};
const BASE_PREDICATES = Object.keys(ARITY);
/** What each predicate ask answers holds (r_introspect): its arguments, and
 *  what a row means. */
export const MEANING: Record<string, { args: string[]; meaning: string }> = {
  edge: { args: ['F', 'S', 'R', 'T'], meaning: 'every fact ever asserted, the whole history: F its id, S source, R relation, T target (all strings); retired facts stay' },
  edge_num: { args: ['F', 'S', 'R', 'N'], meaning: 'edge, for a target that is an integer, as a number N (to compare and count)' },
  live: { args: ['F', 'S', 'R', 'T'], meaning: 'the edges as they stand now: asserted above confidence 0, the latest value of a one-value attribute (enox:label, enox:description, enox:context, ...), the grant in force' },
  asserted: { args: ['F', 'P', 'C', 'S'], meaning: 'the current assertion of fact F by the book\'s identity: perspective P, confidence C in per mille (0..1000), S the position of its batch in the identity\'s chain' },
  conf: { args: ['F', 'C'], meaning: 'the current confidence of fact F, in per mille (0..1000; 0 = retired)' },
  persp: { args: ['F', 'P'], meaning: 'the perspective fact F is currently asserted under' },
  admitted_at: { args: ['F', 'T'], meaning: 'when THIS node admitted the batch of fact F\'s current assertion (its own clock, not the writer\'s claim): what a lease is measured by' },
  answered: { args: ['K', 'E', 'V'], meaning: 'an intent K of a book with rules, answered by executor E with value V' },
  intent: { args: ['K', 'E', 'Kind', 'In'], meaning: 'an intent K addressed to executor E (a follow, a search by meaning, or one a rule derives)' },
  grant: { args: ['R', 'U'], meaning: 'the grant in force to reader R, until U' },
  delegate: { args: ['A', 'U'], meaning: 'agent A acts for the book\'s identity until U' },
  export: { args: ['Rel', 'A'], meaning: 'facts of relation Rel (or "*") may leave this node to audience A ("public" or an identity)' },
  follows: { args: ['Name', 'Book'], meaning: 'the book\'s identity follows Name\'s feed; Book is that feed\'s book atom' },
  trusts: { args: ['Name'], meaning: 'the operator runs the rules of Name here' },
};
/** The units of the numbers ask and the Enox tools answer with. */
export const UNITS = {
  confidence: 'conf and asserted give confidence in per mille, 0..1000 (1000 = certain, 0 = retired); the Enox tools (add_assertion, explore, recall, ...) give it as 0..1',
  seq: 'asserted\'s S and an assert answer\'s seq are a batch\'s position in its identity\'s chain, from 0 (chain[seq] is its digest)',
  time: 'every time is shown in one form, ISO 8601 in UTC with milliseconds (2026-10-04T12:00:00.000Z): admitted_at, grant and delegate expiries, created_at and updated_at; admitted_at is this node\'s clock at admission, never the writer\'s',
};
/** The longest value kept by place for empty-answer notes: a name, an id or
 *  a date, not a description or an embedding. */
export const VALUE_MAX = 256;
/** What a note may name, within what a requester may see: the predicates and
 *  perspectives, and per book seen whole its values by place and its facts. */
export interface Vocabulary {
  predicates: Set<string>; perspectives: Set<string>;
  /** The arity of each predicate a reader's rules add (the node's are ARITY). */
  arity: Map<string, number>;
  whole: { S: Set<string>; R: Set<string>; T: Set<string>; facts: Map<string, Current> }[];
  /** Books seen only through exports: what they hold is asked of the engine. */
  partial: string[];
}

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
    const d = fs.openSync(path.dirname(p), 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
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
  /** Let the domain of a user@domain identity vouch for its first key
   *  (r_domain_vouch). Off by default; `true` uses the platform's DNS and CAs. */
  domainVouch?: boolean | DomainTransport;
  /** Lifetimes and limits of the OAuth flow (r_mcp_oauth); on with a public URL. */
  oauth?: OAuthOptions;
  /** How many recently admitted facts are remembered (default RECENT_FACTS):
   *  the window of earlier heads ask answers at (r_ask_at_revision). */
  recentFacts?: number;
  /** ...and at most about this many bytes of them (default RECENT_BYTES): a
   *  window sized by what it costs the heap, not by a count (r_heap_headroom). */
  recentBytes?: number;
}

export const DEFAULT_SILENCE_SEC = 3600;

/** What only the owner may assert, never a session (r_session_no_access_control). */
const SESSION_MAY_NOT = new Set([GRANT, EXPORT, DELEGATE, 'roflenox:trust_rules', 'roflenox:follow']);

/** A long answer gives way to other callers every so many rows: the serial
 *  queue still orders the engine's work, but reads that need no slot of it
 *  (graph_stats from its counts) are not held behind a 250 000-row loop
 *  (r_heap_headroom). */
const YIELD_EVERY = 4096;
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const breathe = () => new Promise<void>((r) => setImmediate(r));

export interface SignOptions { salt?: (jsonl: string) => string; /** The head its author had read (r_knew_head). */ knew?: string;
  /** A question answered right after this batch, before any other batch
   *  is admitted, as `asker` (r_assert_then_ask). */
  ask?: { query: string; asker: string | null; perspective: string | null; options: AskOptions } }
export interface Signed { receipt: Receipt; body: BatchBody & { manifest: Manifest; jsonl: string; salt: string }; held: boolean;
  /** The batch's position in this identity's chain (r_assert_receipt). */ seq: number;
  /** Its admission number, and the answer to `ask`. */ admission: number; answer?: AskAnswer }

/** The owner's delegation of a session: until 2100, retired at revocation. */
const sessionDelegation = (name: string, confidence: number): Fact =>
  ({ source: name, relation: DELEGATE, target: new Date(FOREVER * 1000).toISOString(), perspective: 'policy', confidence });

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
  /** The batch's user rules, compiled (src/rules.ts), by fact id: into its
   *  signer's book — or, for a session the owner delegated, the owner's
   *  (r_owner_rules), `author` naming whose. */
  rules: { F: string; text: string; author: string }[];
}

/** The ROFL program a verified batch loads into the MAIN world: its facts.
 *  Its user rules run only in its author's rule world (r_rule_budget). */
function programOf(v: Verified, seq: number): string {
  // The asserted[] rows are not here: they are the CURRENT assertions, kept by
  // src/assertions.ts (it replaces the superseded/current/view rules).
  return toRofl(v.facts, bookOf(v.manifest.identity), seq, false);
}

/** The cells of a current assertion as conf(F, C), persp(F, P) or asserted(F, P, C, S) holds them. */
const assertionCells = (rel: string, F: string, c: Current): (string | number)[] =>
  rel === 'conf' ? [F, c.C] : rel === 'persp' ? [F, c.P] : [F, c.P, c.C, c.S];

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
export const RECENT_FACTS = 50_000;
/** The heap the remembered recent admissions may take, about: 16 MiB. */
export const RECENT_BYTES = 16 * 2 ** 20;
/** What one remembered fact costs beyond its strings: the object, its fact
 *  id, the assertion before it (estimated). */
const RECENT_OVERHEAD = 320;

/** What a stranger's failed admission may say about a held identity:
 *  exactly what it would say about an unknown one (RoflenoxNode.asStranger). */
const STRANGER_SEES = new Set(['key_changed', 'unknown_key', 'bad_signature', 'unknown_identity', 'bad_identity_doc', 'identity_mismatch']);
const notVouched = (identity: string) => new Refusal(403, 'not_vouched',
  `${identity} is not known here and nobody this node trusts vouched for it: its operator introduces it or pulls it by invitation, or an identity pinned here delegates to it`);

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
  /** OAuth for hosted MCP clients; its endpoints answer only with a public URL. */
  readonly oauth: OAuth;
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
  /** identity → its batches' fact programs, deflated: they are read back only
   *  to rebuild an engine or a rule world, and as text they were the largest
   *  thing the node held (r_heap_headroom). Buffers live outside the JS heap. */
  private readonly programs = new Map<string, Buffer[]>();
  private readonly results = new Map<string, string[]>();       // identity → its roflenox:result fact lines
  /** Proven forks, per identity: the two signed successors of one batch. */
  private readonly forks = new Map<string, { prev: string | null; proof: [Manifest, Manifest] }[]>();
  private readonly userRules = new Map<string, Map<string, string>>();  // author → rule fact id → compiled rule
  /** Who signed a rule that runs as another's (a session's rule, run as the owner's). */
  private readonly ruleBy = new Map<string, string>();
  private readonly worlds = new Map<string, { w: World; version: number; clock: number; rules: string }>();
  /** The current assertion of every fact, per identity (src/assertions.ts). */
  private readonly assertions = new Assertions();
  private version = 0;
  /** The last admissions, for views that apply writes instead of rebuilding. */
  private readonly recent: { version: number; identity: string; facts: Fact[]; seq: number;
    /** Its receipt's place in the log, and what each fact it changed was
     *  before it — so an ask can be answered at an earlier head (r_ask_at_revision). */
    at: number; before: Map<string, Current | null>;
    /** What remembering it costs, about (r_heap_headroom). */ bytes: number }[] = [];
  /** The newest claimed_at of each identity's batches (ms): when it last spoke. */
  private readonly lastClaimed = new Map<string, number>();
  /** The values each identity's edges hold, by place — sources, relations,
   *  targets up to VALUE_MAX characters — kept as facts are admitted, so an
   *  empty answer names what does occur without scanning a relation
   *  (r_empty_explains). The edge relation only grows; so do these. */
  private readonly values = new Map<string, { S: Set<string>; R: Set<string>; T: Set<string> }>();
  private readonly silenceSec: number;
  private readonly domainVouch: DomainVouch | null;
  private recentFacts = 0;
  private recentBytes = 0;
  private readonly recentBytesLimit: number;
  private keyChangedOffline = false;
  private readonly recentLimit: number;
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
    this.oauth = new OAuth(o.dataDir, this.publicUrl, () => operatorTokenOf(o.dataDir), this.now, o.oauth);
    this.warnings.push(...this.oauth.warnings);
    this.ruleBudget = o.ruleBudget ?? DEFAULT_RULE_BUDGET;
    this.recentLimit = o.recentFacts ?? RECENT_FACTS;
    this.recentBytesLimit = o.recentBytes ?? RECENT_BYTES;
    this.silenceSec = o.silenceSec ?? DEFAULT_SILENCE_SEC;
    this.domainVouch = o.domainVouch ? new DomainVouch(o.domainVouch === true ? {} : o.domainVouch, () => this.now()) : null;
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
    try {
      await n.load();
      // A key rotated or recovered while the node was down ends every session.
      if (n.keyChangedOffline) await n.ownerKeyChanged();
    } catch (e) {
      // A node that refuses to start leaves no engine process behind.
      await n.engine.stop().catch(() => {});
      throw e;
    }
    return n;
  }

  /** Re-verify the log into the fresh engine (open's body). */
  private async load(): Promise<void> {
    const n = this;
    const receipts = n.log.receipts;
    for (const [ri, r] of receipts.entries()) {
      if (r.kind === 'fork') { n.noteFork(n.log.read(r).manifest); continue; }
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
          receipts.slice(ri + 1).filter((x) => x.identity === r.identity && x.kind === undefined).map((x) => x.digest), true);
      } catch (e) {
        throw new Error(`log batch ${r.identity}/${r.digest} no longer verifies (${(e as Error).message}); refusing to start`);
      }
      n.record(v, ri, r.via !== undefined);
    }
    if (n.identity && n.idDocs.has(n.identity.name)) {
      // The key file's chain may be ahead of the log (a rotation or recovery
      // made offline): admit the newer versions, through the same rule.
      try {
        const had = n.idDocs.get(n.identity.name)!.length;
        await n.applyChain(n.identity.name, n.identity.identityChain(), new Date(n.now()).toISOString(), false, n.identity.name);
        n.keyChangedOffline = n.idDocs.get(n.identity.name)!.length > had;
      } catch (e) {
        throw new Error(`the key file for ${n.identity.name} does not follow the identity the log knows (${(e as Error).message}); refusing to start`);
      }
      const key = n.current(n.identity.name)!.doc.keys.find((k) => k.key_id === n.identity!.keyId);
      if (!key || key.revoked_at) {
        throw new Error(`the key file for ${n.identity.name} is not a key this identity has published under; refusing to start`);
      }
    }
    // From the programs record() kept, a batch at a time: the verified
    // batches are not all held until the end (r_heap_headroom).
    await n.engine.replay(n.held());
    await n.checkUriPrefix();
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

  /** Does `caller` learn that this node holds `identity` (r_default_deny)?
   *  The operator and the identity itself do; anyone else only where some of
   *  its book is readable to them — whole by a grant, in part by an export. */
  private async visible(identity: string, caller: string | null): Promise<boolean> {
    if (caller !== null && (caller === this.identity?.name || caller === identity)) return true;
    return (await this.scopeFor(caller)).has(bookOf(identity));
  }

  /** An identity's document chain, as `caller` may learn it: an identity it
   *  may not see answers as an unknown one. The node's own is public. */
  readIdentityChain(asked: string, caller: string | null): Promise<IdentityDoc[]> {
    return this.serial(async () => {
      const identity = canonicalOrNull(asked);
      if (identity === null || (identity !== this.identity?.name && !(await this.visible(identity, caller)))) {
        throw new Refusal(404, 'unknown_identity', `${asked} is not known here`);
      }
      return this.identityChain(identity);
    }, true);
  }

  /** An identity's batch digests, and the latest time its chain claims, as
   *  `caller` may learn them ([] and null if not). */
  readChain(asked: string, caller: string | null): Promise<{ digests: string[]; last_claimed_at: string | null }> {
    const identity = canonicalOrNull(asked);
    return this.serial(async () => {
      if (identity === null || !(await this.visible(identity, caller))) return { digests: [], last_claimed_at: null };
      const last = this.lastClaimed.get(identity);
      return { digests: this.chainOf(identity), last_claimed_at: last === undefined ? null : new Date(last).toISOString() };
    }, true);
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
    // Its domain, when the operator lets domains vouch: the first document it
    // serves must be exactly the one offered.
    if (this.domainVouch && identity.includes('@')) {
      const served = await this.domainVouch.document(identity);
      if (served && typeof served === 'object' && canonicalize(served) === canonicalize(first)) return;
    }
    throw notVouched(identity);
  }

  /** An admission by anyone but the operator: a refusal that would tell the
   *  caller about an identity held here — its keys, its documents — says
   *  exactly what the same attempt for an identity NOT held here says
   *  (r_default_deny): a stranger learns nothing by writing. */
  private asStranger<T>(identity: unknown, by: string | null, p: Promise<T>): Promise<T> {
    if (by !== null && by === this.identity?.name) return p;
    return p.catch((e: unknown) => {
      if (e instanceof Refusal && typeof identity === 'string' && STRANGER_SEES.has(e.reason)) throw notVouched(identity);
      throw e;
    });
  }

  /** POST /identities: introduce an identity. Its first document is pinned
   *  only as `by` allows (vouch); a known one's updates by rule. Idempotent. */
  introduce(raw: unknown, by: string | null = null): Promise<{ identity: string; pinned: boolean }> {
    const who = Array.isArray(raw) ? (raw[0] as IdentityDoc | undefined)?.doc?.identity : (raw as IdentityDoc | undefined)?.doc?.identity;
    return this.asStranger(who, by, this.serial(async () => {
      const first = checkIdentityDoc(Array.isArray(raw) ? raw[0] : raw);
      const before = this.idDocs.get(first.doc.identity)?.length ?? 0;
      await this.applyChain(first.doc.identity, raw, new Date(this.now()).toISOString(), false, by);
      const pinned = (this.idDocs.get(first.doc.identity)?.length ?? 0) > before;
      // A new version of the node's own identity (a rotation, a recovery): the
      // session keys derived from the old key are gone; so are their sessions.
      if (pinned && before > 0 && first.doc.identity === this.identity?.name) await this.ownerKeyChanged();
      return { identity: first.doc.identity, pinned };
    }));
  }

  /** Who signed this request (RFC 9421), or null for an unsigned one. */
  authenticate(method: string, uri: string | readonly string[], headers: Record<string, string | string[] | undefined>, body: Buffer | null): string | null {
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
  private record(v: Verified, at: number, mirrored = false, seq = (this.chains.get(v.manifest.identity)?.length ?? 0),
    plan = this.assertions.plan(v.manifest.identity, bookOf(v.manifest.identity), v.facts, seq, this.isSession(v.manifest.identity))): void {
    const id = v.manifest.identity;
    // A session's control facts, from a log written before they were refused: inert, and said (r_session_no_access_control).
    if (this.isSession(id) && v.facts.some((f) => SESSION_MAY_NOT.has(f.relation))) this.warnings.push(`INERT ACCESS FACTS in ${id}'s batch ${v.manifest.digest}: a session's grant, export, delegation, trust or follow never acts`);
    plan.apply();
    const vals = this.values.get(id) ?? { S: new Set<string>(), R: new Set<string>(), T: new Set<string>() };
    this.values.set(id, vals);
    for (const f of v.facts) {
      if (f.source.length <= VALUE_MAX) vals.S.add(f.source);
      vals.R.add(f.relation);
      if (f.target.length <= VALUE_MAX) vals.T.add(f.target);
    }
    const progs = this.programs.get(id) ?? [];
    progs.push(zlib.deflateRawSync(programOf(v, seq)));
    this.programs.set(id, progs);
    const res = v.facts.filter((f) => f.relation === RESULT);
    if (res.length) this.results.set(id, [...(this.results.get(id) ?? []), toRofl(res, bookOf(id), seq)]);
    for (const r of v.rules) {
      const m = this.userRules.get(r.author) ?? new Map<string, string>();
      m.set(r.F, r.text);
      this.userRules.set(r.author, m);
      if (r.author !== id) this.ruleBy.set(r.F, id);
    }
    this.version++;
    const claimed = Date.parse(v.manifest.claimed_at);
    if (claimed > (this.lastClaimed.get(id) ?? -Infinity)) this.lastClaimed.set(id, claimed);
    const bytes = v.facts.reduce((t, f) => t + 2 * (f.source.length + f.relation.length + f.target.length + f.perspective.length) + RECENT_OVERHEAD, 0);
    this.recent.push({ version: this.version, identity: id, facts: v.facts, seq, at, before: plan.before, bytes });
    this.recentFacts += v.facts.length;
    this.recentBytes += bytes;
    while (this.recent.length && (this.recentFacts > this.recentLimit || this.recentBytes > this.recentBytesLimit)) {
      const e = this.recent.shift()!;
      this.recentFacts -= e.facts.length;
      this.recentBytes -= e.bytes;
    }
    if (v.pin) this.idDocs.set(id, [v.pin]);
    const chain = this.chains.get(id) ?? [];
    chain.push(v.manifest.digest);
    this.chains.set(id, chain);
    this.factCount += v.facts.length;
  }

  /** Remember a fork: `m`, validly signed, names the same prev as a batch in
   *  its identity's chain. Kept durably (once) so the proof outlives a restart. */
  private recordFork(m: Manifest, receivedAt: string): void {
    if ((this.forks.get(m.identity) ?? []).some((f) => f.proof[1].digest === m.digest)) return;
    this.log.appendFork(m, receivedAt);
    this.noteFork(m);
  }

  private noteFork(m: Manifest): void {
    const chain = this.chains.get(m.identity) ?? [];
    const other = chain[m.prev === null ? 0 : chain.indexOf(m.prev) + 1];
    const r = this.log.receipts.find((x) => x.kind === undefined && x.identity === m.identity && x.digest === other);
    if (!r) return;
    const f = this.forks.get(m.identity) ?? [];
    f.push({ prev: m.prev, proof: [this.log.read(r).manifest, m] });
    this.forks.set(m.identity, f);
  }

  /** Every answer over a forked identity's book says so, with the proof. */
  private forkedUnknowns(scope: Map<string, BookScope>, book: string | null): Unknown[] {
    const out: Unknown[] = [];
    for (const [b, sc] of scope) {
      if (book !== null && book !== b) continue;
      for (const f of this.forks.get(sc.identity) ?? []) {
        out.push({ identity: sc.identity, reason: `forked: two signed successors of ${f.prev ?? 'nothing (two first batches)'}`, proof: f.proof });
      }
    }
    return out;
  }

  /** A counter that moves with every admission. */
  logVersion(): number {
    return this.version;
  }

  /** Where an identity's batch `seq` stands in the log: the order this node
   *  received its writes in, -1 if it holds no such batch. The time a write
   *  was written, as recent_activity orders by it (r_recent_order): an
   *  updated_at fact is only what the writer claims. */
  writtenAt(identity: string, seq: number): number {
    const d = this.chains.get(identity)?.[seq];
    if (d === undefined) return -1;
    const w = this.written;
    const rs = this.log.receipts;
    if (w.of !== rs) { w.of = rs; w.n = 0; w.at.clear(); }
    for (; w.n < rs.length; w.n++) if (rs[w.n]!.kind === undefined) w.at.set(`${rs[w.n]!.identity}\n${rs[w.n]!.digest}`, w.n);
    return w.at.get(`${identity}\n${d}`) ?? -1;
  }
  private readonly written: { of: unknown; n: number; at: Map<string, number> } = { of: null, n: 0, at: new Map() };

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

    // Never from the future, by any door (r_freshness, r_rotation): nothing
    // can fix a date ahead of its receipt. A live POST is also held to the
    // freshness window in the past, below (stale: a re-attestation fixes it).
    this.notFuture(m.claimed_at, receivedAt, 'the batch');
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

    // 3. freshness, of whichever signature vouches for this receipt — before
    // the chain, so a replayed old batch learns nothing of what is held here
    // (r_default_deny).
    if (mode === 'post') {
      if (reattest) {
        this.checkFresh(reattest.attested_at, receivedAt, 'the re-attestation', 're-attest again with a current time');
      } else {
        this.checkFresh(m.claimed_at, receivedAt, 'claimed_at',
          're-attestation requested: the publisher signs the same digest again with a current claimed_at');
      }
    }

    // 4. chain.
    const chain = this.chains.get(m.identity) ?? [];
    if (chain.includes(m.digest)) throw new Refusal(409, 'duplicate', 'this batch is already in the chain');
    const head = chain.length ? chain[chain.length - 1]! : null;
    if (m.prev !== head) {
      // A second validly signed successor of a batch in the chain: the
      // identity forked its history. Kept as proof by the caller (r_chain).
      if (m.prev === null || chain.includes(m.prev)) {
        throw new Refusal(409, 'forked', `${m.identity} signed two successors of ${m.prev ?? 'nothing (two first batches)'}; both are kept as proof of the fork`, { fork: m });
      }
      throw new Refusal(409, 'chain_mismatch',
        `prev must be the head of ${m.identity}'s chain (${head ?? 'null: this is its first batch'})`);
    }
    // Time never runs backwards within one chain (r_rotation): with each key
    // valid only until its rotation, a rotated key can then append nothing
    // after a batch its successor signed, whatever time it claims.
    const last = this.lastClaimed.get(m.identity);
    if (last !== undefined && Date.parse(m.claimed_at) < last) {
      throw new Refusal(409, 'time_backwards',
        `${m.identity}'s batch claims ${m.claimed_at}, earlier than the batch before it (${new Date(last).toISOString()})`);
    }
    // User rules are checked here, with the batch: a rule that would conclude
    // outside its author's book refuses the whole batch.
    // A rule signed by an identity the owner delegated (a session) is
    // compiled as the owner's own (r_owner_rules); it runs only while that
    // delegation lives (runnableRules). A rule already in the log that is
    // refused now (a built-in head) is made inert, with a warning: a node
    // never refuses to start over one.
    const op = this.identity?.name;
    const parent = (this.current(m.identity) ?? pending)?.doc.delegated_by;
    const author = op !== undefined && parent === op ? op : m.identity;
    const rules = facts.filter((f) => f.relation === RULE).flatMap((f) => {
      try {
        return [{ F: factId(f), text: compileRule(f.target, author), author }];
      } catch (e) {
        if (!replaying || !(e instanceof Refusal)) throw e;
        this.warnings.push(`INERT RULE in ${m.identity}'s batch ${m.digest}: ${e.message}`);
        return [];
      }
    });
    return { manifest: m, facts, pin, reattest, withheld, rules };
  }

  /** Admit one batch, serialised against every other admission. */
  admit(body: BatchBody, by: string | null = null): Promise<Receipt> {
    return this.asStranger((body?.manifest as Manifest | undefined)?.identity, by,
      this.serial(() => this.admitNow(body, 'post', new Date(this.now()).toISOString(), [], by)));
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
    let v: Verified;
    try {
      v = this.verify(body, receivedAt, mode, pending, upcoming);
    } catch (e) {
      if (e instanceof Refusal && e.reason === 'forked') {
        this.recordFork(e.detail.fork as Manifest, receivedAt);
        delete e.detail.fork;
      }
      throw e;
    }
    await this.checkDelegation(v.manifest, receivedAt, mode, pending);
    await this.trialRules(v, this.chains.get(v.manifest.identity)?.length ?? 0);
    const id = v.manifest.identity;
    const rules = this.chains.has(id) ? null : this.rulesFor(id);
    const seq = this.chains.get(id)?.length ?? 0;
    // Who may read is the owner's decision alone (r_session_no_access_control).
    if (this.isSession(id)) {
      const ctl = v.facts.find((f) => SESSION_MAY_NOT.has(f.relation));
      if (ctl) {
        throw new Refusal(403, 'session_no_access_control', `${id} is a session of ${this.identity!.name}: a session may not assert ${ctl.relation} — grants, exports, delegations, trust and follows are the owner's own decisions; nothing was admitted`);
      }
    }
    const plan = this.assertions.plan(id, bookOf(id), v.facts, seq, this.isSession(id));
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
    this.record(v, this.log.receipts.length - 1, mode !== 'post', seq, plan);
    return receipt;
  }

  /** ENGINE CRASH RECOVERY (r_engine_crash_recovery): the engine is derived
   *  data. When its process dies, the next operation starts a fresh one and
   *  replays what this node holds — the same facts, in the same chain order,
   *  that replay from the log gives. Rule worlds lived in the dead process and
   *  are rebuilt lazily. The log was never touched by the crash: an admission
   *  commits to the log only after the engine has taken the batch. */
  /** What the engine is built from: every batch program, inflated one at a
   *  time as the engine takes it, then each identity's current assertions. */
  private *held(): Generator<{ rofl: string; who: string; rules: string | null }> {
    for (const [id, packed] of this.programs) {
      for (const [i, b] of packed.entries()) yield { rofl: zlib.inflateRawSync(b).toString('utf8'), who: id, rules: i === 0 ? this.rulesFor(id) : null };
      yield { rofl: this.assertions.lines(id, bookOf(id)), who: id, rules: null };
    }
  }

  private async rebuildEngine(): Promise<void> {
    this.worlds.clear();
    const e = await Engine.fresh(this.bin);
    await e.replay(this.held());
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
    // Anonymous: a book it may not read answers as one that is not here.
    if (requester === null) throw new Refusal(404, 'unknown_book', `no book ${book} here`);
    const whynot = await whyNotReadable(this.engine, requester, book, owner, Math.floor(this.now() / 1000));
    // A grant its owner retired (confidence 0) is GONE, not missing
    // (r_revocation_receipt): what was read before stays attested by its
    // batch digest, and nothing is read from now on.
    const cur = this.assertions.of(owner);
    const grants = (await this.engine.sysRows(`edge[${book}](F, R, "roflenox:grant", U)`)).filter((r) => canonicalOrNull(r[1]) === requester);
    if (grants.some((r) => cur.get(String(r[0]))?.C === 0)) {
      throw new Refusal(410, 'grant_revoked', `${owner} revoked ${requester}'s grant to read its book`, { whynot });
    }
    throw new Refusal(403, 'no_grant', `${requester} has no live grant to read ${owner}'s book`, { whynot });
  }

  /** Ask one literal as `requester`. `at`: a log head — answer as the node
   *  would have when that was its latest (r_ask_at_revision). Every answer
   *  names the head it is of. */
  ask(query: string, requester: string | null = null, perspective: string | null = null, o: AskOptions = {}): Promise<AskAnswer> {
    return this.serial(() => this.askNow(query, requester, perspective, o), true);
  }

  private async askNow(query: string, requester: string | null, perspective: string | null, o: AskOptions): Promise<AskAnswer> {
    const head = o.at ?? this.log.head();
    const lits = parseQuery(query);
    const a = lits.length === 1 && !lits[0]!.neg ? await this.askAt(query, requester, perspective, o) : await this.askConjunction(lits, requester, perspective, o);
    a.head = head;
    return a;
  }

  /** A conjunction (r_conjunction): the positive literals joined left to
   *  right — a literal sharing variables with few bindings so far is asked
   *  once per binding with them filled in, otherwise asked whole and joined
   *  by its shared variables — then each negation asked per binding, which
   *  its variables must all be bound by. Every literal is asked as `requester`
   *  through the same access rules; rows examined count against the same
   *  budget as a rule's steps, and an answer that reaches it stops there and
   *  names the budget. Each row binds every named variable. */
  private async askConjunction(lits: QueryLiteral[], requester: string | null, perspective: string | null, o: AskOptions): Promise<AskAnswer> {
    if (o.since !== undefined || o.order !== undefined) throw new Refusal(400, 'bad_args', 'a conjunction is asked without since or order');
    const named = (x: string) => /^[A-Z]/.test(x);
    const varsOf = (l: QueryLiteral) => splitArgs(l.args).filter(named);
    const pos = lits.filter((l) => !l.neg), neg = lits.filter((l) => l.neg);
    const bound = new Set(pos.flatMap(varsOf));
    for (const n of neg) {
      const free = [...new Set(varsOf(n))].filter((v) => !bound.has(v));
      if (free.length) {
        const note = `not ${n.text}: ${free.join(', ')} ${free.length === 1 ? 'is' : 'are'} bound by no other literal; a negation is asked of the bindings the other literals give, so every variable in it must occur in one of them`;
        throw new Refusal(400, 'unbound_negation', note, { note });
      }
    }
    const vars = [...new Set(pos.flatMap(varsOf))];
    const term = (v: string | number) => (typeof v === 'number' ? String(v) : roflString(v));
    const fill = (l: QueryLiteral, b: Map<string, string | number>) =>
      `${l.rel}${l.book !== null ? `[${l.book}]` : ''}(${splitArgs(l.args).map((x) => (named(x) && b.has(x) ? term(b.get(x)!) : x)).join(', ')})`;
    const sub = (q: string, l: QueryLiteral) => this.askAt(q, requester, l.rel === 'edge' ? perspective : null, o.at !== undefined ? { at: o.at } : {});
    type Row = { b: Map<string, string | number>; identity: string };
    let rows: Row[] = [{ b: new Map(), identity: '' }];
    let used = 0;
    let stopped = false;
    const extend = (row: Row, ans: AskAnswer, r: AskAnswer['rows'][number], out: Row[]) => {
      const m = new Map(row.b);
      for (const [i, k] of ans.vars.entries()) {
        if (!named(k)) continue;
        const v = r.cells[i]!;
        if (m.has(k) && m.get(k) !== v) return;
        m.set(k, v);
      }
      out.push({ b: m, identity: row.identity || r.identity });
    };
    for (const l of pos) {
      const shared = varsOf(l).filter((v) => rows[0]?.b.has(v));
      const next: Row[] = [];
      if (shared.length && rows.length <= 64) {
        for (const row of rows) {
          const ans = await sub(fill(l, row.b), l);
          used += ans.rows.length;
          for (const r of ans.rows) extend(row, ans, r, next);
          if (used > this.ruleBudget) break;
        }
      } else {
        const ans = await sub(l.text, l);
        used += ans.rows.length;
        const at = shared.map((v) => ans.vars.indexOf(v));
        const byKey = new Map<string, AskAnswer['rows']>();
        for (const r of ans.rows) {
          const k = JSON.stringify(at.map((i) => r.cells[i]));
          const xs = byKey.get(k);
          if (xs) xs.push(r); else byKey.set(k, [r]);
        }
        for (const row of rows) {
          for (const r of byKey.get(JSON.stringify(shared.map((v) => row.b.get(v)))) ?? []) {
            extend(row, ans, r, next);
            if (++used > this.ruleBudget) break;
          }
          if (used > this.ruleBudget) break;
        }
      }
      rows = next;
      if (used > this.ruleBudget) { stopped = true; break; }
      if (rows.length === 0) break;
    }
    if (!stopped && neg.length) {
      const held = new Map<string, boolean>();
      const kept: Row[] = [];
      for (const row of rows) {
        let ok = true;
        for (const n of neg) {
          const q = fill(n, row.b);
          if (!held.has(q)) { held.set(q, (await sub(q, n)).rows.length > 0); used++; }
          if (held.get(q)) { ok = false; break; }
        }
        if (ok) kept.push(row);
        if (used > this.ruleBudget) { stopped = true; break; }
      }
      rows = kept;
    }
    const seen = new Set<string>();
    const out: AskAnswer['rows'] = [];
    for (const row of rows) {
      const cells = vars.map((v) => row.b.get(v)!);
      const k = JSON.stringify([row.identity, cells]);
      if (!seen.has(k)) { seen.add(k); out.push({ identity: row.identity, cells }); }
    }
    sortRows(out);
    return { vars, rows: out, ...(stopped ? { unknown: [{ identity: requester ?? 'anonymous', reason: `budget: the conjunction stopped after examining ${used} rows; the rows here are those found before it`, budget: this.ruleBudget, unit: 'rows' }] } : {}) };
  }

  /** What ask can answer at an earlier head: the facts and their assertions,
   *  which the node can unwind; what rules and control rows derive is the
   *  engine's, and it holds only the latest state. */
  static readonly AT_REVISION = new Set(['edge', 'edge_num', 'live', 'asserted', 'conf', 'persp', 'admitted_at']);

  /** The assertions each later batch changed, as they were at `head`, per
   *  identity — null when `head` is the latest state of every fact. Refused
   *  for a head the log never had, and for one older than the node keeps. */
  private undoSince(head: string): Map<string, Map<string, Current | null>> | null {
    const n = this.log.receiptsAt(head);
    if (n === undefined) throw new Refusal(404, 'unknown_head', `${head} was never this node's log head`);
    const rs = this.log.receipts;
    let first = -1;
    for (let i = n; i < rs.length; i++) if (rs[i]!.kind === undefined) { first = i; break; }
    if (first < 0) return null;
    const kept = this.recent[0]?.at;
    if (kept === undefined || first < kept) {
      const oldest = this.log.headAt(kept ?? rs.length);
      throw new Refusal(410, 'head_gone', `this node no longer answers at ${head}; the oldest head it answers at is ${oldest}`, { oldest });
    }
    const undo = new Map<string, Map<string, Current | null>>();
    for (const e of this.recent) {
      if (e.at < n) continue;
      const m = undo.get(e.identity) ?? new Map<string, Current | null>();
      undo.set(e.identity, m);
      for (const [F, c] of e.before) if (!m.has(F)) m.set(F, c);
    }
    return undo;
  }

  /** ask since a batch (r_ask_since): the rows of the facts admitted after
   *  it — in any book the reader may see, as they stand now — found by
   *  walking only the batches after it, never the whole relation. */
  private async askSince(digest: string, rel: string, book: string | null, args: string, scope: Map<string, BookScope>, perspective: string | null,
    window?: AskOptions['window']): Promise<AskAnswer> {
    if (!RoflenoxNode.AT_REVISION.has(rel)) {
      throw new Refusal(400, 'not_since', `since answers ${[...RoflenoxNode.AT_REVISION].join(', ')}; ${rel} is derived by the engine`);
    }
    const from = this.admissionOf(digest);
    if (from === undefined) throw new Refusal(404, 'unknown_batch', `no batch ${digest} in this node's log`);
    const a = splitArgs(args);
    const vars = a.filter((x, i) => x === '_' || (/^[A-Z_]/.test(x) && a.indexOf(x) === i));
    const width = rel === 'conf' || rel === 'persp' || rel === 'admitted_at' ? 2 : 4;
    if (a.length !== width) return { vars, rows: [] };
    const kept = new Map(this.recent.map((e) => [e.at, e.facts]));
    const rs = this.log.receipts;
    const seen = new Set<string>();
    const rows = new Collect(window);
    for (let i = from + 1; i < rs.length; i++) {
      const r = rs[i]!;
      if (r.kind !== undefined || r.withheld) continue;
      const b = bookOf(r.identity);
      const sc = scope.get(b);
      if (!sc || (book !== null && book !== b)) continue;
      const facts = kept.get(i) ?? parseJsonl(this.log.read(r).jsonl!);
      const cur = this.view(r.identity);
      for (const f of facts) {
        const F = factId(f);
        const k = `${r.identity}\n${F}`;
        if (seen.has(k) || (sc.only !== null && !sc.only.has(F))) continue;
        seen.add(k);
        const c = cur.get(F);
        if (!c || (perspective !== null && c.P !== perspective)) continue;
        const cells: (string | number)[] | null = rel === 'edge' ? [F, f.source, f.relation, f.target]
          : rel === 'edge_num' ? (/^-?(0|[1-9]\d{0,14})$/.test(f.target) ? [F, f.source, f.relation, Number(f.target)] : null)
          : rel === 'live' ? (this.liveNow(r.identity, [F, f.source, f.relation, f.target]) ? [F, f.source, f.relation, f.target] : null)
          : rel === 'admitted_at' ? [F, this.admittedAt(r.identity, c.S)] : assertionCells(rel, F, c);
        const m = cells && match(a, cells);
        if (m) rows.push({ identity: r.identity, cells: m.cells });
      }
    }
    return rows.answer(vars);
  }

  /** The live facts of one perspective in the node's own book, as a
   *  deterministic dump (r_perspective_export): one canonical JSONL line per
   *  fact, with its current confidence, sorted bytewise — the same bytes for
   *  the same state, fit for keeping in git. `at`: the state at that head. */
  exportPerspective(perspective: string, at?: string): Promise<{ perspective: string; head: string; facts: number; dump: string }> {
    return this.serial(async () => {
      const me = this.identity?.name;
      if (!me || !this.chains.has(me)) return { perspective, head: at ?? this.log.head(), facts: 0, dump: '' };
      const undo = at !== undefined ? this.undoSince(at) : null;
      const view = this.view(me, undo);
      const b = bookOf(me);
      const r = await this.askFacts('edge', b, 'F, S, R, T', new Map([[b, { identity: me, only: null }]]),
        (id, t) => view.get(t[0])?.P === perspective && this.liveNow(id, t, undo));
      const lines = r.rows.map((x) => {
        const [F, S, R, T] = x.cells.map(String) as [string, string, string, string];
        return canonicalize({ source: S, relation: R, target: T, perspective, confidence: view.get(F)!.C / 1000 });
      }).sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
      return { perspective, head: at ?? this.log.head(), facts: lines.length, dump: lines.map((l) => `${l}\n`).join('') };
    }, true);
  }

  /** When this node admitted an identity's batch `seq` — its own clock, as
   *  the receipt holds it (r_one_time): a lease is measured by this, never by
   *  the time the writer claims. */
  admittedAt(identity: string, seq: number): string {
    return this.log.receipts[this.writtenAt(identity, seq)]?.received_at ?? '';
  }

  /** Where a batch stands in the log: its receipt's index. */
  admissionOf(digest: string): number | undefined {
    const w = this.byDigest;
    const rs = this.log.receipts;
    for (; w.n < rs.length; w.n++) if (rs[w.n]!.kind === undefined) w.at.set(rs[w.n]!.digest, w.n);
    return w.at.get(digest);
  }
  private readonly byDigest: { n: number; at: Map<string, number> } = { n: 0, at: new Map() };

  private async askAt(query: string, requester: string | null, perspective: string | null, o: AskOptions): Promise<AskAnswer> {
    const ans = await this.askOrdered(query, requester, perspective, o);
    const { rel, args } = parseLiteral(query);
    if (o.order === 'admission') this.byAdmission(rel, splitArgs(args), ans, o.at !== undefined ? this.undoSince(o.at) : null);
    // One form of time (r_one_time): an expiry the engine compares in seconds is shown as ISO 8601.
    if (rel === 'grant' || rel === 'delegate') {
      const u = ans.vars.length === 2 ? 1 : ans.vars.length === 1 && /^[A-Z_]/.test(splitArgs(args)[1] ?? '') ? 0 : -1;
      for (const r of ans.rows) if (u >= 0 && typeof r.cells[u] === 'number') r.cells[u] = new Date((r.cells[u] as number) * 1000).toISOString();
    }
    return ans;
  }

  /** The admission number (the log position, r_recent_order) of the batch
   *  that made each row true (r_admission_order): for a fact's edge, the
   *  batch that first asserted it; for its live row and its assertion, the
   *  batch of its current assertion; for a grant, delegation, export, trust
   *  or follow, the batch of the fact in force. A row a rule derives has
   *  none (null). Rows are put in that order, those with none last. The
   *  number is the log's order, so it is the same on every read and after a
   *  restart. */
  private byAdmission(rel: string, a: string[], ans: AskAnswer, undo: Map<string, Map<string, Current | null>> | null): void {
    const view = (id: string) => (rel === 'asserted' ? this.assertions.viewAt(id, undo?.get(id)) : this.view(id, undo));
    const at = (id: string, seq: number | undefined) => (seq === undefined ? null : this.writtenAt(id, seq));
    if (['edge', 'edge_num', 'live', 'asserted', 'conf', 'persp', 'admitted_at'].includes(rel)) {
      const constF = /^[A-Z_]/.test(a[0] ?? '') ? null : a[0] !== undefined ? decodeCell(a[0].trim()) : null;
      for (const r of ans.rows) {
        const c = view(r.identity).get(String(constF ?? r.cells[0]));
        r.admission = at(c?.by ?? r.identity, rel === 'edge' || rel === 'edge_num' ? c?.first : c?.S);
      }
    } else if (['grant', 'delegate', 'export', 'trusts', 'follows'].includes(rel)) {
      const byRow = new Map<string, Map<string, number>>();
      const rowOf = (id: string) => {
        let m = byRow.get(id);
        if (m) return m;
        m = new Map();
        for (const [, c] of view(id)) {
          const k = c.on === true && c.ctl !== undefined ? c.ctl : c.follow !== undefined && c.C > 0 ? `follows:${canonicalOrNull(c.follow)}` : undefined;
          if (k !== undefined && (m.get(k) ?? -1) < c.S) m.set(k, c.S);
        }
        byRow.set(id, m);
        return m;
      };
      const ground = (r: AskRow) => (rel === 'follows' ? `follows:${r.cells[0]}` : `${rel}[${bookOf(r.identity)}](${r.cells.map((x) => (typeof x === 'number' ? String(x) : roflString(x))).join(', ')})`);
      for (const r of ans.rows) r.admission = at(r.identity, rowOf(r.identity).get(ground(r)));
    } else {
      for (const r of ans.rows) r.admission = null;
    }
    ans.rows.sort((x, y) => (x.admission ?? Infinity) - (y.admission ?? Infinity));
  }

  private async askOrdered(query: string, requester: string | null, perspective: string | null, o: AskOptions): Promise<AskAnswer> {
    const scope = await this.scopeFor(requester);
    await this.requireBook(query, requester, scope, false);
    this.fault('engine:ask');
    const { rel, book, args } = parseLiteral(query);
    if (o.since !== undefined) {
      if (o.at !== undefined) throw new Refusal(400, 'bad_args', 'ask takes since or at, not both');
      return this.askSince(o.since, rel, book, args, scope, perspective, o.window);
    }
    const undo = o.at !== undefined ? this.undoSince(o.at) : null;
    if (undo && !RoflenoxNode.AT_REVISION.has(rel)) {
      throw new Refusal(400, 'not_at_revision', `at an earlier head ask answers ${[...RoflenoxNode.AT_REVISION].join(', ')}; ${rel} is derived by the engine, which holds only the latest state`);
    }
    if (perspective !== null || rel === 'conf' || rel === 'persp' || rel === 'asserted' || rel === 'admitted_at' || rel === 'live' || undo) {
      const a = rel === 'live' && perspective === null ? await this.askFacts('edge', book, args, scope, (id, t) => this.liveNow(id, t, undo), o.window)
        : undo && perspective === null && (rel === 'edge' || rel === 'edge_num')
          ? await this.askFacts(rel, book, args, scope, (id, t) => this.assertions.viewAt(id, undo.get(id)).get(t[0]) !== undefined, o.window)
          : perspective !== null && rel === 'edge'
            ? await this.askFacts('edge', book, args, scope, (id, t) => this.view(id, undo).get(t[0])?.P === perspective, o.window)
            : await this.askAssertions(rel, book, args, scope, perspective, undo, o.window);
      const forked = this.forkedUnknowns(scope, book);
      if (forked.length) a.unknown = [...(a.unknown ?? []), ...forked];
      return a;
    }
    // A question about facts is answered a book and a relation at a time,
    // into the asker's window: never held whole (r_heap_headroom).
    if (rel === 'edge' || rel === 'edge_num') {
      const a = await this.askFacts(rel, book, args, scope, () => true, o.window);
      const unknown: NonNullable<AskAnswer['unknown']> = [];
      for (const [b, sc] of scope) if (sc.only === null && (book === null || book === b)) unknown.push(...await this.silentFeeds(sc.identity));
      unknown.push(...this.forkedUnknowns(scope, book));
      if (unknown.length) a.unknown = unknown;
      return a;
    }
    // answered is a rule world's; with none, it still names its variables.
    const named = splitArgs(args).filter((x, i, xs) => x === '_' || (/^[A-Z_]/.test(x) && xs.indexOf(x) === i));
    const ans: AskAnswer = rel === 'answered' ? { vars: named, rows: [] } : await this.engine.ask(query, scope);
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
      try { this.fault('engine:world-ask'); a = await w.ask(q); } catch (e) {
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
    unknown.push(...this.forkedUnknowns(scope, book));
    if (unknown.length) ans.unknown = unknown;
    sortRows(ans.rows);
    return ans;
  }

  /** conf(F, C), persp(F, P), asserted(F, P, C, S), and edge(F, S, R, T)
   *  restricted to a perspective — from the current assertions admission keeps
   *  (src/assertions.ts), within the reader's scope. */
  private async askAssertions(rel: string, book: string | null, args: string, scope: Map<string, BookScope>, perspective: string | null,
    undo: Map<string, Map<string, Current | null>> | null = null, window?: AskOptions['window']): Promise<AskAnswer> {
    const a = splitArgs(args);
    const books = [...scope].filter(([b]) => book === null || b === book);
    if (book !== null && books.length === 0) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
    const vars = a.filter((x, i) => x === '_' || (/^[A-Z_]/.test(x) && a.indexOf(x) === i));
    // (An edge question under a perspective is askFacts'; any other is not one.)
    if (perspective !== null) throw new Refusal(400, 'bad_query', 'a perspective restricts edge(F, S, R, T) questions');
    if (a.length !== (rel === 'asserted' ? 4 : 2)) return { vars, rows: [] };   // the note says the arity (src/empty.ts)
    const out = new Collect(window);
    let j = 0;
    for (const [, sc] of books) {
      // asserted is the book's own assertion; conf, persp and admitted_at are
      // the fact as it stands (r_session_identity).
      for (const [F, c] of rel === 'asserted' ? this.assertions.viewAt(sc.identity, undo?.get(sc.identity)) : this.view(sc.identity, undo)) {
        if (++j % YIELD_EVERY === 0) await breathe();
        if (sc.only !== null && !sc.only.has(F)) continue;
        const m = match(a, rel === 'admitted_at' ? [F, this.admittedAt(c.by ?? sc.identity, c.S)] : assertionCells(rel, F, c));
        if (m) out.push({ identity: sc.identity, cells: m.cells });
      }
    }
    return out.answer(vars);
  }

  /** Every fact `caller` may see whose relation `want` takes, handed to
   *  `each` with its current assertion — asked of the engine one book and one
   *  relation at a time, so no answer holds a whole book (r_heap_headroom). */
  eachFact(caller: string | null, want: (R: string) => boolean,
    each: (identity: string, F: string, S: string, R: string, T: string, cur: Current | undefined) => void): Promise<void> {
    return this.serial(async () => {
      for (const [b, sc] of await this.scopeFor(caller)) {
        const cur = this.view(sc.identity);
        const one = new Map([[b, sc]]);
        for (const R of [...(this.values.get(sc.identity)?.R ?? [])].filter(want).sort()) {
          const r = await this.engine.ask(`edge[${b}](F, S, ${roflString(R)}, T)`, one);
          for (const row of r.rows) {
            const [F, S, T] = row.cells.map(String) as [string, string, string];
            each(sc.identity, F, S, R, T, cur.get(F));
          }
        }
      }
    }, true);
  }

  /** live(F, S, R, T) (r_live_view): the edges as they stand now — asserted
   *  above confidence 0, the one value of a one-value relation (an entity's
   *  or an edge's attribute), the grant in force — while edge(F, S, R, T)
   *  stays the whole history. Asked of the engine's edges with the
   *  question's constants bound, and filtered by the current assertions. */
  private async askFacts(rel: 'edge' | 'edge_num', book: string | null, args: string, scope: Map<string, BookScope>,
    keep: (identity: string, t: [string, string, string, string]) => boolean, window?: AskOptions['window']): Promise<AskAnswer> {
    const a = splitArgs(args);
    const vars = a.filter((x, i) => x === '_' || (/^[A-Z_]/.test(x) && a.indexOf(x) === i));
    if (a.length !== 4) return { vars, rows: [] };                  // the note says the arity (src/empty.ts)
    const books = [...scope].filter(([b]) => book === null || b === book);
    if (book !== null && books.length === 0) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
    const isVar = (x: string) => /^[A-Z_]/.test(x);
    const out = new Collect(window);
    for (const [b, sc] of books) {
      // One relation at a time when the question leaves it open: no engine
      // answer holds a whole book (r_heap_headroom).
      const rels = isVar(a[2]!) ? [...(this.values.get(sc.identity)?.R ?? [])].sort().map((R) => roflString(R)) : [a[2]!];
      for (const R of rels) {
        const probe = a.map((x, i) => (i === 2 ? R : isVar(x) ? `V${i}` : x)).join(', ');
        const r = await this.engine.ask(`${rel}[${b}](${probe})`, new Map([[b, sc]]));
        const at = a.map((x, i) => (i !== 2 && isVar(x) ? r.vars.indexOf(`V${i}`) : -1));
        for (const [j, row] of r.rows.entries()) {
          if (j % YIELD_EVERY === YIELD_EVERY - 1) await breathe();
          const t = a.map((x, i) => (at[i]! >= 0 ? row.cells[at[i]!]! : decodeCell(i === 2 ? R : x.trim())));
          if (!keep(sc.identity, t.map(String) as [string, string, string, string])) continue;
          const m = match(a, t);
          if (m) out.push({ identity: sc.identity, cells: m.cells });
        }
      }
    }
    return out.answer(vars);
  }

  /** Whether a fact of `identity`'s is live now (r_live_view); a grant also
   *  only before its expiry. */
  private liveNow(identity: string, [F, S, R, T]: [string, string, string, string], undo?: Map<string, Map<string, Current | null>> | null): boolean {
    const view = this.view(identity, undo);
    if (oneValue(R)) {
      // One value across the family's books: a session's new description of
      // the owner's entity replaces the owner's (r_session_identity).
      const c = view.get(F);
      if (!c || c.C <= 0) return false;
      const books = (this.familyOf(identity) ?? [identity]).map((m) => [m, this.view(m, undo)] as [string, View]);
      return this.assertions.valueAcross(books, S, R) === F;
    }
    if (!this.assertions.live(identity, F, S, R, view)) return false;
    return R !== GRANT || this.now() < Date.parse(T);
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
    const all = await this.scopeFor(requester);
    await this.requireBook(query, requester, all, true);
    this.fault('engine:explain');
    const { rel, book, args } = parseLiteral(query);
    const scope = this.matchable(rel, book, args, all);
    if (rel === 'conf' || rel === 'persp' || rel === 'asserted') return this.explainAssertion(op, rel, book, args, scope);
    if (rel === 'live') return this.withProvenance(await this.explainLive(op, book, args, scope));
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
      e.text = this.namingRules(e.identity, r.text);
      if (w.partial) e.unknown = { reason: w.holes.join('; '), budget: this.ruleBudget, unit: 'steps' };
    }
    return this.withProvenance(out);
  }

  /** The books an explanation is asked of (r_bounded_reads): for a question
   *  about facts, only those whose facts it can match — each constant held
   *  at its place, as the node keeps them by place — never once per book the
   *  reader may see. When none can, the reader's own book (or the first). */
  private matchable(rel: string, book: string | null, args: string, scope: Map<string, BookScope>): Map<string, BookScope> {
    if (book !== null || !['edge', 'edge_num', 'live', 'conf', 'persp', 'asserted'].includes(rel)) return scope;
    const c = splitArgs(args).map((x) => (x.startsWith('"') ? JSON.parse(x) as string : null));
    const places = rel === 'edge' || rel === 'live' ? ['S', 'R', 'T'] as const : rel === 'edge_num' ? ['S', 'R'] as const : [] as const;
    const can = [...scope].filter(([, sc]) => {
      if (sc.only !== null) return false;
      if (c[0] != null && !this.assertions.of(sc.identity).has(c[0])) return false;
      const v = this.values.get(sc.identity);
      return places.every((p, i) => { const x = c[i + 1]; return x == null || x.length > VALUE_MAX || (v?.[p].has(x) ?? false); });
    });
    if (can.length) return new Map(can);
    const fallback = [...scope].filter(([, sc]) => sc.only === null).sort(([x, xs], [y]) => (xs.identity === this.identity?.name ? -1 : x < y ? -1 : 1))[0];
    return new Map(fallback ? [fallback] : []);
  }

  /** A derivation names the rule it used (r_owner_rules): the engine says
   *  `<= r<hash>`; each such step gets the text of the author's rule with
   *  that head — or of each, when several conclude it. */
  private namingRules(author: string, text: string): string {
    const byHead = new Map<string, string[]>();
    for (const r of this.currentRules(author)) {
      const h = /^([a-z][A-Za-z0-9_]*)\[/.exec(r)?.[1];
      if (h) byHead.set(h, [...(byHead.get(h) ?? []), r]);
    }
    return text.split('\n').map((l) => {
      const m = /^\s*([a-z][A-Za-z0-9_]*)\[b_[0-9a-f]{16}\]\(.*\)\s+<= r[0-9a-f]+ @tick \d+$/.exec(l);
      const rs = m ? byHead.get(m[1]!) : undefined;
      return rs ? `${l} — ${rs.length === 1 ? 'rule' : 'one of the rules'} ${rs.map((r) => JSON.stringify(r)).join(', ')}` : l;
    }).join('\n');
  }

  /** Each axiom of an explanation names where it comes from (r_bounded_reads):
   *  the batch of its current assertion, that batch's admission number in
   *  this node's log and position in its identity's chain, the time the batch
   *  claims, and — for an Enox edge — who the write claims as its author. */
  private async withProvenance(out: Explanation[]): Promise<Explanation[]> {
    const owners = new Map([...this.chains.keys()].map((id) => [bookOf(id), id]));
    for (const e of out) {
      const lines = e.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)(?:edge|edge_num)\[(b_[0-9a-f]{16})\]\("([0-9a-f]{64})",.*\[axiom\]$/.exec(lines[i]!);
        const id = m ? owners.get(m[2]!) : undefined;
        const c = id !== undefined ? this.assertions.of(id).get(m![3]!) : undefined;
        if (!c) continue;
        const digest = this.chains.get(id!)![c.S]!;
        const n = this.writtenAt(id!, c.S);
        const r = this.log.receipts[n]!;
        const claimedAt = r.withheld ? null : this.log.read(r).manifest.claimed_at;
        const G = this.assertions.valueOf(id!, m![3]!, 'enox:asserted_by');
        const by = G !== undefined ? (await this.engine.sysRows(`edge[${m![2]}](${roflString(G)}, S, R, T)`))[0]?.[2] : undefined;
        lines[i] += ` batch ${digest} (admission ${n}, ${id}'s batch ${c.S}${claimedAt ? `, claimed_at ${claimedAt}` : ''})${by !== undefined ? `, claimed_by ${JSON.stringify(String(by))}` : ''}`;
      }
      e.text = lines.join('\n');
    }
    return out;
  }

  /** why/whynot conf(F, C), persp(F, P) and asserted(F, P, C, S): explained
   *  from the current assertions, where ask answers them (askAssertions), so
   *  the two agree (r_compat_parity). */
  private explainAssertion(op: 'why' | 'whynot', rel: 'conf' | 'persp' | 'asserted', book: string | null, args: string, scope: Map<string, BookScope>): Explanation[] {
    const a = splitArgs(args);
    if (a.length !== (rel === 'asserted' ? 4 : 2)) throw new Refusal(400, 'bad_query', `${rel} takes ${rel === 'asserted' ? 4 : 2} arguments`);
    const books = [...scope].filter(([b, sc]) => sc.only === null && (book === null || b === book)).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    return books.map(([b, sc]) => {
      const lit = `${rel}[${b}](${a.join(',')})`;
      const cur = rel === 'asserted' ? this.assertions.of(sc.identity) : this.view(sc.identity);
      const row = (F: string, c: Current) => `asserted[${b}](${roflString(F)},${roflString(c.P)},${c.C},${c.S})`;
      const hit = [...cur].find(([F, c]) => match(a, assertionCells(rel, F, c)) !== null);
      if (hit) {
        const why = `${lit} [the current assertion]\n  ${row(hit[0], hit[1])} [${sc.identity}'s latest assertion of the fact: batch ${hit[1].S} of its chain]`;
        return { identity: sc.identity, holds: true, text: op === 'why' ? why : `whynot ${lit}: it holds —\n  ${why}` };
      }
      // Not held: say what the fact's current assertion is, if it has one.
      const F = /^"/.test(a[0]!) ? JSON.parse(a[0]!) as string : null;
      const c = F !== null ? cur.get(F) : undefined;
      const reason = c ? `the current assertion of the fact is ${row(F!, c)}`
        : F !== null ? `${sc.identity} holds no assertion of that fact` : `no current assertion of ${sc.identity}'s matches`;
      return { identity: sc.identity, holds: false, text: op === 'why' ? `${lit} does not hold; ${reason}` : `whynot ${lit}:\n  ${reason}` };
    });
  }

  /** why/whynot live(F, S, R, T): from the current assertions, where ask
   *  answers it (askFacts), so the two agree. */
  private async explainLive(op: 'why' | 'whynot', book: string | null, args: string, scope: Map<string, BookScope>): Promise<Explanation[]> {
    const a = splitArgs(args);
    if (a.length !== 4) throw new Refusal(400, 'bad_query', 'live takes 4 arguments');
    if (a.some((x) => /^[A-Z_]/.test(x))) throw new Refusal(400, 'bad_query', 'why and whynot explain a ground literal: every argument a constant');
    const books = [...scope].filter(([b, sc]) => sc.only === null && (book === null || b === book)).sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const out: Explanation[] = [];
    for (const [b, sc] of books) {
      const lit = `live[${b}](${a.join(',')})`;
      const r = await this.engine.ask(`edge[${b}](${a.join(', ')})`, new Map([[b, sc]]));
      const cur = this.view(sc.identity);
      const ground = a.map((x) => decodeCell(x.trim()));
      if (r.rows.length === 0) {
        out.push({ identity: sc.identity, holds: false, text: op === 'why' ? `${lit} does not hold; ${sc.identity} never asserted it` : `whynot ${lit}:\n  ${sc.identity} never asserted edge[${b}](${a.join(',')})` });
        continue;
      }
      const [F, S, R, T] = ground.map(String) as [string, string, string, string];
      const c = cur.get(F)!;
      const asserted = `asserted[${b}](${roflString(F)},${roflString(c.P)},${c.C},${c.S}) [${sc.identity}'s latest assertion of the fact: batch ${c.S} of its chain]`;
      const holds = this.liveNow(sc.identity, [F, S, R, T]);
      let reason: string;
      if (holds) reason = `edge[${b}](${a.join(',')}) [axiom]\n  ${asserted}${oneValue(R) ? `\n  the latest value of ${R} for ${S}` : R === GRANT ? `\n  the grant to ${c.grantee} in force` : ''}`;
      else if (c.C <= 0) reason = `${asserted}: retired (confidence 0)`;
      else if (R === GRANT && c.on === true) reason = `${asserted}: expired at ${T}`;
      else if (R === GRANT) reason = `${asserted}: replaced by a newer grant to ${c.grantee}`;
      else reason = `${asserted}: replaced by ${roflString(this.assertions.valueOf(sc.identity, S, R, cur) ?? '')}, the latest value of ${R} for ${S}`;
      out.push({ identity: sc.identity, holds, text: holds ? (op === 'why' ? `${lit}\n  ${reason}` : `whynot ${lit}: it holds —\n  ${reason}`)
        : (op === 'why' ? `${lit} does not hold; ${reason}` : `whynot ${lit}:\n  ${reason}`) });
    }
    return out;
  }

  /** The predicates a question may name and the perspectives facts are
   *  asserted under, within what `requester` may see (r_empty_explains). */
  vocabulary(requester: string | null, withPerspectives = true): Promise<Vocabulary> {
    return this.serial(async () => {
      const predicates = new Set(BASE_PREDICATES);
      const arity = new Map<string, number>();
      const perspectives = new Set<string>();
      const whole: Vocabulary['whole'] = [];
      const partial: string[] = [];
      for (const [b, sc] of await this.scopeFor(requester)) {
        if (sc.only === null) {
          for (const h of this.headsOf(sc.identity)) if (h) predicates.add(h);
          for (const r of this.currentRules(sc.identity)) {
            const m = /^([a-z][A-Za-z0-9_]*)\[[^\]]*\]\(([^)]*)\)/.exec(r);
            if (m && !arity.has(m[1]!)) arity.set(m[1]!, splitArgs(m[2]!).length);
          }
          const v = this.values.get(sc.identity);
          if (v) whole.push({ ...v, facts: this.assertions.of(sc.identity) });
        } else partial.push(b);
        if (withPerspectives) for (const [F, c] of this.assertions.of(sc.identity)) if (sc.only === null || sc.only.has(F)) perspectives.add(c.P);
      }
      return { predicates, perspectives, whole, partial, arity };
    }, true);
  }

  /** What a caller may ask (r_introspect): every predicate ask answers with
   *  its arity and meaning — the node's own and the heads of the rules in the
   *  books the caller reads whole — and every perspective present among the
   *  facts it may see, with how many facts are currently asserted under it. */
  schema(requester: string | null): Promise<{ predicates: { name: string; arity: number; args: string[]; meaning: string }[]; perspectives: { perspective: string; facts: number }[] }> {
    return this.serial(async () => {
      const predicates = Object.entries(MEANING).map(([name, m]) => ({ name, arity: ARITY[name]!, args: m.args, meaning: m.meaning }));
      const counts = new Map<string, number>();
      const heads = new Map<string, { arity: number; by: Set<string> }>();
      for (const [, sc] of await this.scopeFor(requester)) {
        for (const [F, c] of this.assertions.of(sc.identity)) if (sc.only === null || sc.only.has(F)) counts.set(c.P, (counts.get(c.P) ?? 0) + 1);
        if (sc.only !== null) continue;
        for (const r of this.currentRules(sc.identity)) {
          const m = /^([a-z][A-Za-z0-9_]*)\[[^\]]*\]\(([^)]*)\)/.exec(r);
          if (!m || ARITY[m[1]!] !== undefined) continue;
          const h = heads.get(m[1]!) ?? { arity: splitArgs(m[2]!).length, by: new Set<string>() };
          h.by.add(sc.identity);
          heads.set(m[1]!, h);
        }
      }
      for (const [name, h] of [...heads].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        predicates.push({ name, arity: h.arity, args: Array.from({ length: h.arity }, (_, i) => `X${i + 1}`), meaning: `derived by the rules of ${[...h.by].sort().join(', ')}` });
      }
      return { predicates, perspectives: [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([perspective, facts]) => ({ perspective, facts })) };
    }, true);
  }

  private headsOf(author: string): Set<string> {
    return new Set(this.currentRules(author).map((r) => /^([a-z][A-Za-z0-9_]*)\[/.exec(r)?.[1] ?? ''));
  }

  /** An author's rules whose fact is current with confidence above 0: a rule
   *  re-asserted at 0 is retired and derives nothing (r_confidence). */
  private currentRules(author: string): string[] {
    return this.currentRuleFacts(author).map(([, text]) => text);
  }

  /** [fact id, compiled rule, signer] of an author's current rules: each
   *  current above 0 in the book of whoever signed it. */
  private currentRuleFacts(author: string): [string, string, string][] {
    return [...(this.userRules.get(author) ?? [])].map(([F, text]) => [F, text, this.ruleBy.get(F) ?? author] as [string, string, string])
      .filter(([F, , by]) => (this.assertions.of(by).get(F)?.C ?? 0) > 0);
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
    const all = this.currentRules(author);
    if (all.length === 0) return all;
    const op = this.identity?.name;
    if (author === op) {
      // The owner's own, and those of the sessions it delegates — while the
      // delegation lives; once it ends, they go inert (r_owner_rules).
      const now = Math.floor(this.now() / 1000);
      const live = new Map<string, boolean>();
      const out: string[] = [];
      for (const [, text, by] of this.currentRuleFacts(author)) {
        if (by !== op && !live.has(by)) {
          live.set(by, (await this.engine.sysRows(`delegated_until[${SYSTEM_BOOK}](${roflString(by)}, ${roflString(op)}, U)`)).some((r) => now < Number(r[0])));
        }
        if (by === op || live.get(by)) out.push(text);
      }
      return out;
    }
    if (!op || !this.chains.has(op)) return [];
    const b = bookOf(op);
    // (A trusts row stands while the trust fact is current above 0, with the
    // author's name canonical: src/assertions.ts.)
    return (await this.engine.sysRows(`trusts[${b}](${roflString(author)})`)).length > 0 ? all : [];
  }

  /** The feeds `author` follows that have gone SILENT: nothing claimed within
   *  the silence window, or never anything. Whether or not any rule reads
   *  them: an answer from a book that follows a silent feed is not an
   *  all-clear, so each one is an unknown beside the rows (r_uc_observability). */
  private async silentFeeds(author: string): Promise<Unknown[]> {
    if (!this.chains.has(author)) return [];
    const cur = this.assertions.of(author);
    const follows = await this.engine.sysRows(`edge[${bookOf(author)}](F, P, "roflenox:follow", U)`);
    const followed = [...new Set(follows.filter((r) => (cur.get(String(r[0]))?.C ?? 0) > 0).map((r) => canonicalOrNull(r[1])).filter((x): x is string => x !== null))].sort();
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
    const key = rules.join('\n');
    if (cached && cached.version === this.version && cached.rules === key) {
      if (cached.clock !== clock) { await cached.w.setClock(clock); cached.clock = clock; }
      return cached.w;
    }
    if (cached) { await cached.w.close(); this.worlds.delete(author); }
    const w = await this.buildWorld(author, rules, clock);
    this.worlds.set(author, { w, version: this.version, clock, rules: key });
    return w;
  }

  /** A rule world for `author`'s `rules`, evaluated once at `clock`. `extra`:
   *  a batch not yet admitted, loaded into the author's book (the admission
   *  trial, r_owner_rules). */
  private async buildWorld(author: string, rules: string[], clock: number, extra = ''): Promise<World> {
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
    if (!owners.has(own) && extra) owners.set(own, author);
    for (const b of [own, ...foreign]) {
      const id = owners.get(b);
      if (!id) continue;
      const text = (this.programs.get(id) ?? []).map((p) => zlib.inflateRawSync(p).toString('utf8')).join('') + this.assertions.lines(id, b, true) + (b === own ? extra : '');
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
      this.fault('engine:world');
      await w.evaluate();
    } catch (e) {
      if (this.engine.dead) throw e;
      w.partial = true;
      w.holes = [`engine_refused: ${(e as Error).message.slice(0, 200)}`];
    }
    return w;
  }

  /** THE ADMISSION TRIAL (r_owner_rules): a batch that brings rules that run
   *  as the owner's — its own, or a delegated session's — is admitted only if
   *  the owner's rules with them evaluate within the rule budget. Run once,
   *  in a throwaway world, before anything is staged; a refusal names the
   *  budget and what stopped it, and nothing is admitted. */
  private async trialRules(v: Verified, seq: number): Promise<void> {
    const op = this.identity?.name;
    const mine = v.rules.filter((r) => r.author === op);
    if (!op || mine.length === 0) return;
    const rules = [...await this.runnableRules(op), ...mine.map((r) => r.text)];
    const w = await this.buildWorld(op, rules, Math.floor(this.now() / 1000), v.manifest.identity === op ? programOf(v, seq) : '');
    try {
      if (w.partial) {
        throw new Refusal(422, 'rule_budget', `the owner's rules with this batch's do not evaluate within the rule budget of ${this.ruleBudget} steps (${w.holes.join('; ')}); nothing was admitted`,
          { budget: this.ruleBudget, unit: 'steps', rules: mine.map((r) => r.text) });
      }
    } finally { await w.close(); }
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
      return this.asStranger(inner.manifest?.identity, by,
        this.admitNow({ manifest: inner.manifest, jsonl: inner.jsonl, salt: inner.salt, identity: inner.identity }, 'offline', receivedAt, [], by));
    });
  }

  /** Publish `facts` as this node's own identity, through normal admission:
   *  a signed, salted, chained batch like any other (the MCP `assert` tool). */
  assertAsSelf(facts: Fact[]): Promise<Receipt> {
    return this.signAsSelf(facts).then((r) => r.receipt);
  }

  /** Sign `facts` as this node's own identity and admit them — the ONE place
   *  its batches are signed while it runs (r_single_writer): each is signed
   *  on the head it is admitted on, one at a time, so two can never succeed
   *  the same head. A local operation on this machine hands its facts here
   *  (the `assert` op) instead of signing. `salt` derives the salt from the
   *  batch (an import's, so a re-import is recognised); a batch already in
   *  the chain is then not signed again. Returns the signed body too (seal). */
  signAsSelf(facts: Fact[], o: SignOptions = {}): Promise<Signed> {
    return this.serial(async () => {
      const me = this.identity;
      if (!me) throw new Refusal(404, 'no_identity', 'this node has no identity to assert as');
      return this.signNow(me, facts, o, true);
    });
  }

  /** Sign `facts` as a local identity `me` — the node's own, or a session it
   *  derives — and admit them, in the current serial slot. */
  private async signNow(me: LocalIdentity, facts: Fact[], o: SignOptions, withIdentity: boolean): Promise<Signed> {
    const jsonl = toJsonl(facts);
    const salt = o.salt ? o.salt(jsonl) : newSalt();
    if (o.salt) {
      const digest = batchDigest(salt, jsonl);
      const had = this.log.receipts.find((r) => r.identity === me.name && r.kind === undefined && r.digest === digest);
      if (had) {
        const s = this.log.read(had);
        return { receipt: had, body: { manifest: s.manifest, jsonl, salt, ...(withIdentity ? { identity: me.identityChain() } : {}) }, held: true, seq: this.chainOf(me.name).indexOf(digest),
          admission: this.admissionOf(digest)!, ...(o.ask ? { answer: await this.askNow(o.ask.query, o.ask.asker, o.ask.perspective, o.ask.options) } : {}) };
      }
    }
    // The later of the clock and the chain's last claim (r_rotation).
    const manifest = me.signBatch(jsonl, this.head(me.name), new Date(Math.max(this.now(), this.lastClaimed.get(me.name) ?? -Infinity)).toISOString(), salt, o.knew);
    const body = { manifest, jsonl, salt, ...(withIdentity ? { identity: me.identityChain() } : {}) };
    const receipt = await this.admitNow(body, 'post', new Date(this.now()).toISOString(), [], this.identity?.name ?? me.name);
    // Still inside this one serial slot: no other batch can land before the answer.
    const answer = o.ask ? await this.askNow(o.ask.query, o.ask.asker, o.ask.perspective, o.ask.options) : undefined;
    return { receipt, body, held: false, seq: this.chains.get(me.name)!.length - 1, admission: this.log.receipts.length - 1, ...(answer ? { answer } : {}) };
  }

  // ---- sessions (r_session_identity) ---------------------------------------
  // Each OAuth grant the owner approves writes as its own identity:
  // s<10 hex>.<owner>, delegated by the owner, its keys derived from the
  // owner's key and the grant (LocalIdentity.derive) — nothing stored. It is
  // set up on its first write: pinned on the owner's word, and delegated by an
  // owner-signed roflenox:delegate fact. Revoking the grant retires that
  // delegation; a new owner key (rotation, recovery) ends every session.

  /** The system rules of a book: an owner's session's book (one this node
   *  derived for an approved grant) is read and exported as the owner's book
   *  is — for every batch the session wrote, whatever has happened to its
   *  delegation since: revoking a session stops its new writes, never what
   *  readers may already read (r_session_identity). Nobody else's book. */
  private rulesFor(id: string): string {
    const base = bookRules(bookOf(id), id);
    const owner = this.identity?.name;
    if (!owner || !this.isSession(id)) return base;
    const sb = roflString(bookOf(id)), ob = bookOf(owner);
    return base + [
      `readable_until[${SYSTEM_BOOK}](R, ${sb}, U) :- readable_until[${SYSTEM_BOOK}](R, ${roflString(ob)}, U).`,
      `exported[${SYSTEM_BOOK}](${sb}, F, A) :- edge[${bookOf(id)}](F, S, Rel, T), export[${ob}](Rel, A).`,
      `exported[${SYSTEM_BOOK}](${sb}, F, A) :- edge[${bookOf(id)}](F, S, Rel, T), export[${ob}]("*", A), not reserved[${SYSTEM_BOOK}](Rel).`,
      '',
    ].join('\n');
  }

  /** The owner and the sessions it derived, when `id` is one of them: one
   *  family, whose members act on each other's facts (r_session_identity). */
  private familyOf(id: string): string[] | null {
    const owner = this.identity?.name;
    if (!owner || (id !== owner && !this.isSession(id))) return null;
    return [owner, ...[...this.chains.keys()].filter((x) => x !== owner && this.isSession(x))];
  }

  /** An identity's current assertions as live, conf, persp and the Enox reads
   *  count them (r_session_identity): for the owner and its sessions, a fact
   *  any of them asserted stands as the latest any of them asserted, by
   *  admission order — so a session's retraction of the owner's fact, or of
   *  another session's, retracts it everywhere. Control facts (grants,
   *  delegations, exports, rules, trust, follows) are only ever their own
   *  signer's. Anyone else's assertions are their own. `undo`: at an earlier
   *  head (r_ask_at_revision). */
  view(identity: string, undo?: Map<string, Map<string, Current | null>> | null): View {
    if (!undo) {
      if (this.views.version !== this.version) { this.views.version = this.version; this.views.of.clear(); }
      let v = this.views.of.get(identity);
      if (!v) { v = this.familyView(identity, null); this.views.of.set(identity, v); }
      return v;
    }
    return this.familyView(identity, undo);
  }
  private readonly views: { version: number; of: Map<string, View> } = { version: -1, of: new Map() };

  private familyView(identity: string, undo: Map<string, Map<string, Current | null>> | null): View {
    const own = this.assertions.viewAt(identity, undo?.get(identity));
    const family = this.familyOf(identity)?.filter((m) => m !== identity) ?? [];
    if (family.length === 0) return own;
    const others = family.map((m) => [m, this.assertions.viewAt(m, undo?.get(m))] as const);
    // The owner's book is the large one: the few facts its sessions hold are
    // gathered once; a session's lookups go to the others directly.
    const latest = new Map<string, Current>();
    if (identity === this.identity?.name) {
      for (const [m, v] of others) for (const [F, c] of v) if ((latest.get(F)?.N ?? -1) < c.N) latest.set(F, c.by ? c : { ...c, by: m });
    }
    const pick = (F: string, c: Current | undefined): Current | undefined => {
      if (!c || c.ctl !== undefined || c.follow !== undefined) return c;
      let best = c;
      if (identity === this.identity?.name) {
        const o = latest.get(F);
        if (o && o.N > best.N && o.ctl === undefined) best = o;
      } else {
        for (const [m, v] of others) { const o = v.get(F); if (o && o.N > best.N && o.ctl === undefined) best = { ...o, by: m }; }
      }
      return best;
    };
    return { get: (F) => pick(F, own.get(F)), *[Symbol.iterator]() { for (const [F, c] of own) yield [F, pick(F, c)!]; } };
  }

  /** Is `id` the owner or one of its sessions? */
  inFamily(id: string): boolean {
    return this.familyOf(id) !== null;
  }

  /** Is `id` a session identity this node derived for one of its grants? */
  private isSession(id: string): boolean {
    const owner = this.identity?.name;
    if (!owner || !id.endsWith(`.${owner}`) || !/^s[0-9a-f]{10}\./.test(id)) return false;
    return this.oauth.grants().some((g) => this.sessionName(g.grant) === id);
  }

  /** The identity a session writes as. */
  sessionName(grant: string): string {
    return `s${sha256hex(`roflenox session ${grant}`).slice(0, 10)}.${this.identity!.name}`;
  }

  /** Sign `facts` as the session of `grant`, setting it up first if this is
   *  its first write. */
  signAsSession(grant: string, facts: Fact[], o: SignOptions = {}): Promise<Signed> {
    return this.serial(async () => {
      const owner = this.identity;
      if (!owner) throw new Refusal(404, 'no_identity', 'this node has no identity');
      const bound = this.oauth.ownerKeyOf(grant);
      if (bound !== undefined && bound !== owner.keyId) {
        this.oauth.revoke(grant, 'the owner\'s key changed: approve this client again');
        throw new Refusal(401, 'session_ended', 'the owner\'s key changed since this session was approved; approve the client again');
      }
      this.oauth.bindOwnerKey(grant, owner.keyId);
      const name = this.sessionName(grant);
      const at = new Date(this.now());
      const me = LocalIdentity.derive(owner, name, `${grant} ${owner.keyId}`, this.idDocs.get(name) ? new Date(this.idDocs.get(name)![0]!.doc.issued_at) : at);
      if (!this.idDocs.has(name)) await this.applyChain(name, me.identityChain(), at.toISOString(), false, owner.name);
      const now = Math.floor(this.now() / 1000);
      const live = (await this.engine.sysRows(`delegated_until[${SYSTEM_BOOK}](${roflString(name)}, ${roflString(owner.name)}, U)`)).some((r) => now < Number(r[0]));
      if (!live) await this.signNow(owner, [sessionDelegation(name, 1)], {}, true);
      return this.signNow(me, facts, o, false);
    });
  }

  /** End a session's delegation: its identity can write no more. */
  retireSession(grant: string): Promise<boolean> {
    return this.serial(async () => this.retireSessions([this.sessionName(grant)]));
  }

  /** Retire the delegations of `names` (every session's, when null) that act now. */
  private async retireSessions(names: string[] | null): Promise<boolean> {
    const owner = this.identity;
    if (!owner || !this.chains.has(owner.name)) return false;
    const cur = this.assertions.of(owner.name);
    const pattern = new RegExp(`^s[0-9a-f]{10}\\.${owner.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const rows = await this.engine.sysRows(`edge[${bookOf(owner.name)}](F, A, "roflenox:delegate", U)`);
    const retire = rows.filter((r) => (cur.get(String(r[0]))?.C ?? 0) > 0 && (names ? names.includes(String(r[1])) : pattern.test(String(r[1]))))
      .map((r) => ({ source: String(r[1]), relation: DELEGATE, target: String(r[2]), perspective: 'policy', confidence: 0 }));
    if (retire.length) await this.signNow(owner, retire, {}, true);
    return retire.length > 0;
  }

  /** The owner's key changed: every session approves again (r_session_identity). */
  private async ownerKeyChanged(): Promise<void> {
    this.oauth.revokeAll('the owner\'s key changed: approve this client again');
    await this.retireSessions(null);
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
      const embedders = [...new Set(named.filter((r) => (cur.get(String(r[0]))?.C ?? 0) > 0).map((r) => canonicalOrNull(r[1])).filter((x): x is string => x !== null))].sort();
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
    const who = ((body?.attestation ?? body?.checkpoint) as { identity?: unknown } | undefined)?.identity;
    return this.asStranger(who, by, this.admitFeedNow(body, by));
  }

  private admitFeedNow(body: FeedBody, by: string | null): Promise<{ admitted: number }> {
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
        // What is already held is not news; where the feed then diverges, a
        // fork is proven and kept (r_chain), or the chain refuses it.
        if (this.chains.get(String((b.manifest as Manifest)?.identity))?.includes(digests[i]!)) continue;
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
      // What is already held is not news; where the feed then diverges, a
      // fork is proven and kept (r_chain), or the chain refuses it.
      if (this.chains.get(String((b.manifest as Manifest)?.identity))?.includes(digests[i]!)) continue;
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
  feed(asked: string, after: string | null, challenge: string | null = null, reader: string | null = null, limit: number | null = null): Promise<{
    identity: IdentityDoc[]; batches: FeedEntry[]; attestation?: FeedAttestation;
  }> {
    const identity = canonicalOrNull(asked) ?? asked;
    return this.serial(async () => {
      const chain = this.chains.get(identity);
      const doc = this.idDocs.get(identity);
      if (!chain || !doc || !(await this.visible(identity, reader))) throw new Refusal(404, 'unknown_identity', `no feed for ${identity}`);
      let from = 0;
      if (after !== null) {
        const i = chain.indexOf(after);
        if (i < 0) throw new Refusal(404, 'unknown_after', `${after} is not in ${identity}'s chain`);
        from = i + 1;
      }
      const sc = (await this.scopeFor(reader)).get(bookOf(identity));
      const allowed = (fid: string) => sc !== undefined && (sc.only === null || sc.only.has(fid));
      const byDigest = new Map(this.log.receipts.filter((r) => r.identity === identity && r.kind === undefined).map((r) => [r.digest, r]));
      const batches = chain.slice(from, limit !== null ? from + Math.max(1, Math.floor(limit)) : undefined).map((d): FeedEntry => {
        const s = this.log.read(byDigest.get(d)!);
        const extra = s.receipt.reattest ? { reattest: s.receipt.reattest } : {};
        // (A reader who may read the book whole gets every batch: nothing to parse.)
        if (s.jsonl === null || (sc?.only !== null && !parseJsonl(s.jsonl).every((f) => allowed(factId(f))))) {
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

  /** `full` for the operator (and the node's own callers); anyone else
   *  learns the node's name and that it is up, nothing it holds. */
  health(full = true): Record<string, unknown> {
    if (!full) return { identity: this.identity?.name ?? null, engine: { up: !this.engine.dead } };
    return {
      identity: this.identity?.name ?? null,
      heads: Object.fromEntries([...this.chains.keys()].sort().map((id) => [id, this.head(id)])),
      facts: this.factCount,
      batches: this.log.receipts.filter((r) => r.kind === undefined).length,
      forks: [...this.forks.values()].reduce((n, f) => n + f.length, 0),
      log_head: this.log.head(),
      engine: { up: !this.engine.dead, restarts: this.engineRestarts },
      warnings: this.warnings,
      recovered: this.log.recovered,
      challenges_remembered: this.consumed.size,
      recent_facts_remembered: this.recentFacts,
      // What the node holds of its heap, and the heap it may grow to (r_heap_headroom).
      memory: (() => {
        const m = process.memoryUsage();
        const stall = Math.round(loopDelay.max / 1e6);
        loopDelay.reset();
        return { heap_used_mb: Math.round(m.heapUsed / 2 ** 20), heap_limit_mb: Math.round(v8.getHeapStatistics().heap_size_limit / 2 ** 20), rss_mb: Math.round(m.rss / 2 ** 20),
          /** The longest the event loop was held since the last health (ms). */ stall_ms: stall };
      })(),
    };
  }

  async close(): Promise<void> {
    await this.queue;
    for (const { w } of this.worlds.values()) await w.close().catch(() => {});
    await this.engine.stop();
  }
}
