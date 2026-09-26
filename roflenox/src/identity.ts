// Identity: an Ed25519 key per identity, a self-signed identity document, and
// the batch signature.
//
// Every signature is over a CONTEXT STRING plus the JCS of what it covers, so a
// signature made here cannot be replayed as one in another protocol or as the
// other kind of roflenox object (r_signed_batch).
//
// The batch signature covers the whole manifest except `sig` — digest and
// claimed_at as spec item 4 says, and also identity, key_id, prev and count.
// Item 4 alone leaves `prev` unsigned, and an unsigned prev makes the chain
// claimed rather than proven (r_chain).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize } from './jcs.ts';
import { batchDigest, Refusal, sha256hex } from './facts.ts';

export const BATCH_CONTEXT = 'roflenox-batch-v1\n';
export const IDENTITY_CONTEXT = 'roflenox-identity-v1\n';
/** A publisher's live answer to a reader's challenge: {identity, key_id, head, nonce, attested_at}. */
export const FEED_CONTEXT = 'roflenox-feed-v1\n';
/** A publisher's scheduled signature over its feed head, for static copies:
 *  {identity, key_id, head, checkpoint_at} (r_static_feed). */
export const CHECKPOINT_CONTEXT = 'roflenox-checkpoint-v1\n';
/** A publisher's fresh signature over an old digest: {identity, key_id, digest, attested_at}. */
export const REATTEST_CONTEXT = 'roflenox-reattest-v1\n';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function checkName(name: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Refusal(400, 'bad_identity_name', `identity names are 1-128 of [A-Za-z0-9._@-], starting alphanumeric`);
  }
  return name;
}

/** The ROFL book of an identity. Derived from the NAME, so it carries no key. */
export function bookOf(identity: string): string {
  return `b_${sha256hex(identity).slice(0, 16)}`;
}

export function isTime(t: unknown): t is string {
  return typeof t === 'string' && TIME.test(t) && !Number.isNaN(Date.parse(t));
}

/** One signing key in an identity's history. `valid_until` is set by a
 *  rotation; `revoked_at` (with `last_good`, the chain head the owner still
 *  vouches for) only by the recovery key. */
export interface KeyEntry {
  key_id: string; alg: 'Ed25519'; public_key: string; valid_from: string;
  valid_until?: string; revoked_at?: string; last_good?: string | null;
}
/** The identity document. Versions form a chain: `seq` counts them and `prev`
 *  is the SHA-256 of the previous SIGNED document. `recovery` is the public
 *  half of the offline recovery key; its private half exists only as the
 *  backup code handed to the user once. `enc` is the X25519 key private
 *  batches are encrypted to. */
export interface IdentityDocBody {
  identity: string; seq: number; prev: string | null; keys: KeyEntry[];
  recovery: { key_id: string; public_key: string }; enc: { public_key: string }; issued_at: string;
  /** An AGENT's parent identity: this identity acts only while the parent's
   *  roflenox:delegate fact for it is live. */
  delegated_by?: string;
}
export interface IdentityDoc { doc: IdentityDocBody; key_id: string; sig: string }

export interface Manifest {
  identity: string;
  key_id: string;
  prev: string | null;
  claimed_at: string;
  count: number;
  digest: string;
  sig: string;
}

function publicKeyOf(x: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

export function keyIdOf(x: string): string {
  return sha256hex(Buffer.from(x, 'base64url'));
}

export function docHash(d: IdentityDoc): string {
  return sha256hex(canonicalize(d));
}

// The recovery key is derived from a 32-byte seed; the seed, in RFC 4648
// base32 grouped by four, IS the backup code.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(b: Buffer): string {
  let bits = 0, v = 0, out = '';
  for (const x of b) {
    v = (v << 8) | x; bits += 8;
    while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, v = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    v = (v << 5) | i; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The recovery key a backup code stands for. */
export function recoveryKeyFromCode(code: string): crypto.KeyObject {
  const seed = unbase32(code);
  if (seed.length !== 32) throw new Error('a recovery code is 52 base32 characters');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
}

function newRecovery(): { code: string; key: crypto.KeyObject } {
  const seed = crypto.randomBytes(32);
  const code = base32(seed).match(/.{1,4}/g)!.join('-');
  return { code, key: recoveryKeyFromCode(code) };
}

function xOf(k: crypto.KeyObject): string {
  return crypto.createPublicKey(k).export({ format: 'jwk' }).x as string;
}

export function signDoc(doc: IdentityDocBody, signer: crypto.KeyObject): IdentityDoc {
  const x = xOf(signer);
  return { doc, key_id: keyIdOf(x), sig: crypto.sign(null, Buffer.from(IDENTITY_CONTEXT + canonicalize(doc)), signer).toString('base64url') };
}

interface KeyFile { identity: string; private_key: string; enc_private_key: string; docs: IdentityDoc[] }

/** The local identity: a name, its current private key, its X25519 key, and
 *  its signed document chain. Never printed. */
export class LocalIdentity {
  readonly name: string;
  private readonly key: crypto.KeyObject;
  private readonly encKey: crypto.KeyObject;
  readonly docs: IdentityDoc[];
  readonly publicX: string;
  readonly keyId: string;
  /** Set only on the instance `create` returns: the backup code, shown once. */
  recoveryCode?: string;

  private constructor(name: string, key: crypto.KeyObject, encKey: crypto.KeyObject, docs: IdentityDoc[]) {
    this.name = name;
    this.key = key;
    this.encKey = encKey;
    this.docs = docs;
    this.publicX = xOf(key);
    this.keyId = keyIdOf(this.publicX);
  }

  static keyPath(dataDir: string): string {
    return path.join(dataDir, 'key', 'identity.json');
  }

  private static write(dataDir: string, f: KeyFile, overwrite: boolean): void {
    const p = LocalIdentity.keyPath(dataDir);
    if (!overwrite && fs.existsSync(p)) throw new Error(`an identity already exists in ${dataDir}`);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(f)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
  }

  private file(): KeyFile {
    return {
      identity: this.name,
      private_key: this.key.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      enc_private_key: this.encKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      docs: this.docs,
    };
  }

  /** Create the key file (0600, in a 0700 dir outside log/) with a first,
   *  self-signed document. Refuses to overwrite an existing one: a lost key is
   *  not silently replaced. The recovery key's private half is returned once,
   *  as `recoveryCode`, and stored nowhere. */
  static create(dataDir: string, name: string, now: Date = new Date(), o: { delegatedBy?: string } = {}): LocalIdentity {
    checkName(name);
    const key = crypto.generateKeyPairSync('ed25519').privateKey;
    const encKey = crypto.generateKeyPairSync('x25519').privateKey;
    const rec = newRecovery();
    const t = now.toISOString();
    const x = xOf(key);
    const doc: IdentityDocBody = {
      identity: name, seq: 0, prev: null,
      keys: [{ key_id: keyIdOf(x), alg: 'Ed25519', public_key: x, valid_from: t }],
      recovery: { key_id: keyIdOf(xOf(rec.key)), public_key: xOf(rec.key) },
      enc: { public_key: xOf(encKey) },
      issued_at: t,
      ...(o.delegatedBy ? { delegated_by: checkName(o.delegatedBy) } : {}),
    };
    const me = new LocalIdentity(name, key, encKey, [signDoc(doc, key)]);
    LocalIdentity.write(dataDir, me.file(), false);
    me.recoveryCode = rec.code;
    return me;
  }

  static load(dataDir: string): LocalIdentity | null {
    const p = LocalIdentity.keyPath(dataDir);
    if (!fs.existsSync(p)) return null;
    const mode = fs.statSync(p).mode & 0o777;
    if (mode & 0o077) throw new Error(`the identity key file is readable by others (mode ${mode.toString(8)}); expected 600`);
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as KeyFile;
    const der = (b: string) => crypto.createPrivateKey({ key: Buffer.from(b, 'base64'), format: 'der', type: 'pkcs8' });
    return new LocalIdentity(checkName(j.identity), der(j.private_key), der(j.enc_private_key), j.docs);
  }

  /** The current signed identity document. */
  identityDoc(): IdentityDoc {
    return this.docs[this.docs.length - 1]!;
  }

  /** Every version, oldest first: what a node that has none of them needs. */
  identityChain(): IdentityDoc[] {
    return [...this.docs];
  }

  /** The private X25519 key private batches to this identity are wrapped for. */
  encPrivateKey(): crypto.KeyObject {
    return this.encKey;
  }

  /** ROTATE: a new key valid from `now`, the current one valid until `now`,
   *  signed by the CURRENT key (r_rotation). Rewrites the key file; returns
   *  the identity as it now is. */
  rotate(dataDir: string, now: Date): LocalIdentity {
    const t = now.toISOString();
    const next = crypto.generateKeyPairSync('ed25519').privateKey;
    const x = xOf(next);
    const cur = this.identityDoc().doc;
    const doc: IdentityDocBody = {
      ...cur, seq: cur.seq + 1, prev: docHash(this.identityDoc()), issued_at: t,
      keys: [...cur.keys.map((k) => (k.key_id === this.keyId ? { ...k, valid_until: t } : k)),
        { key_id: keyIdOf(x), alg: 'Ed25519', public_key: x, valid_from: t }],
    };
    const me = new LocalIdentity(this.name, next, this.encKey, [...this.docs, signDoc(doc, this.key)]);
    LocalIdentity.write(dataDir, me.file(), true);
    return me;
  }

  /** RECOVER with the backup code: revoke every key in the chain as of `now`
   *  (vouching for the chain up to `lastGood`), add a fresh one, and sign the
   *  new document with the RECOVERY key (r_recovery). Rewrites the key file. */
  static recover(dataDir: string, code: string, current: IdentityDoc[], lastGood: string | null, now: Date): LocalIdentity {
    const rec = recoveryKeyFromCode(code);
    const last = current[current.length - 1]!;
    if (keyIdOf(xOf(rec)) !== last.doc.recovery.key_id) throw new Error('that recovery code is not this identity\'s');
    const t = now.toISOString();
    const next = crypto.generateKeyPairSync('ed25519').privateKey;
    const x = xOf(next);
    const doc: IdentityDocBody = {
      ...last.doc, seq: last.doc.seq + 1, prev: docHash(last), issued_at: t,
      keys: [...last.doc.keys.map((k) => (k.revoked_at ? k : { ...k, revoked_at: t, last_good: lastGood })),
        { key_id: keyIdOf(x), alg: 'Ed25519', public_key: x, valid_from: t }],
    };
    const old = LocalIdentity.load(dataDir);
    const encKey = old ? old.encKey : crypto.generateKeyPairSync('x25519').privateKey;
    const me = new LocalIdentity(last.doc.identity, next, encKey, [...current, signDoc(doc, rec)]);
    LocalIdentity.write(dataDir, me.file(), true);
    return me;
  }

  /** Raw Ed25519 over bytes the caller has already framed (RFC 9421 base). */
  signBytes(data: Buffer): Buffer {
    return crypto.sign(null, data, this.key);
  }

  /** Sign `body` (which must name this identity's key_id) under `context`. */
  sign<T extends object>(context: string, body: T): T & { sig: string } {
    const sig = crypto.sign(null, Buffer.from(context + canonicalize(body)), this.key).toString('base64url');
    return { ...body, sig };
  }

  /** A checkpoint: this identity's feed head, signed at `at`, to sit beside a
   *  static copy of the feed. */
  checkpoint(head: string | null, at: string): Checkpoint {
    return this.sign(CHECKPOINT_CONTEXT, { identity: this.name, key_id: this.keyId, head, checkpoint_at: at });
  }

  /** Re-attest a batch: the same digest, this key, a current time (r_reattest). */
  reattest(digest: string, attestedAt: string): Attestation {
    return this.sign(REATTEST_CONTEXT, { identity: this.name, key_id: this.keyId, digest, attested_at: attestedAt });
  }

  /** Sign a batch. `jsonl` must already be canonical (see facts.toJsonl). */
  signBatch(jsonl: string, prev: string | null, claimedAt: string, salt: string): Manifest {
    const unsigned = {
      identity: this.name,
      key_id: this.keyId,
      prev,
      claimed_at: claimedAt,
      count: jsonl.split('\n').length - 1,
      digest: batchDigest(salt, jsonl),
    };
    const sig = crypto.sign(null, Buffer.from(BATCH_CONTEXT + canonicalize(unsigned)), this.key).toString('base64url');
    return { ...unsigned, sig };
  }
}

/** Check an identity document's shape (not who signed it). */
export function checkIdentityDoc(d: unknown): IdentityDoc {
  const bad = (m: string) => new Refusal(422, 'bad_identity_doc', m);
  const x = d as IdentityDoc;
  if (!x || typeof x !== 'object' || !x.doc || typeof x.sig !== 'string' || typeof x.key_id !== 'string') {
    throw bad('an identity document is {doc, key_id, sig}');
  }
  checkName(x.doc.identity);
  if (!Number.isInteger(x.doc.seq) || x.doc.seq < 0) throw bad('seq is a non-negative integer');
  if ((x.doc.seq === 0) !== (x.doc.prev === null)) throw bad('only the first document (seq 0) has no prev');
  if (x.doc.prev !== null && !HEX64.test(String(x.doc.prev))) throw bad('prev is 64 hex');
  if (!Array.isArray(x.doc.keys) || x.doc.keys.length === 0) throw bad('an identity document lists at least one key');
  for (const k of x.doc.keys) {
    if (k.alg !== 'Ed25519' || typeof k.public_key !== 'string' || !isTime(k.valid_from)
      || (k.valid_until !== undefined && !isTime(k.valid_until))
      || (k.revoked_at !== undefined && !isTime(k.revoked_at))) throw bad('malformed key entry');
    if (keyIdOf(k.public_key) !== k.key_id) throw bad('a key_id does not match its key');
  }
  if (!x.doc.recovery || keyIdOf(String(x.doc.recovery.public_key)) !== x.doc.recovery.key_id) throw bad('malformed recovery key');
  if (!x.doc.enc || typeof x.doc.enc.public_key !== 'string') throw bad('malformed encryption key');
  if (!isTime(x.doc.issued_at)) throw bad('issued_at is RFC 3339 UTC');
  if (x.doc.delegated_by !== undefined && (checkName(x.doc.delegated_by) === x.doc.identity)) throw bad('an identity is not its own agent');
  return x;
}

/** True iff `d` is signed by the key with public half `publicKey`. */
export function docSignedBy(d: IdentityDoc, publicKey: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(IDENTITY_CONTEXT + canonicalize(d.doc)), publicKeyOf(publicKey), Buffer.from(d.sig, 'base64url'));
  } catch { return false; }
}

/** A FIRST document: well formed, seq 0, and signed by one of its own keys. */
export function verifyIdentityDoc(d: unknown): IdentityDoc {
  const x = checkIdentityDoc(d);
  const signer = x.doc.keys.find((k) => k.key_id === x.key_id);
  if (!signer) throw new Refusal(422, 'bad_identity_doc', 'the document is signed by a key it does not list');
  if (!docSignedBy(x, signer.public_key)) throw new Refusal(422, 'bad_identity_doc', 'the identity document signature does not verify');
  return x;
}

/** Shape of a manifest; a 400 names the first thing wrong with it. */
export function checkManifest(m: unknown): Manifest {
  const bad = (msg: string) => new Refusal(400, 'malformed_manifest', msg);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('a manifest is a JSON object');
  const x = m as Record<string, unknown>;
  const want = ['claimed_at', 'count', 'digest', 'identity', 'key_id', 'prev', 'sig'];
  if (Object.keys(x).sort().join(',') !== want.join(',')) throw bad(`a manifest has exactly ${want.join(', ')}`);
  if (typeof x.identity !== 'string') throw bad('identity is a string');
  checkName(x.identity);
  if (typeof x.key_id !== 'string' || !HEX64.test(x.key_id)) throw bad('key_id is 64 hex');
  if (x.prev !== null && (typeof x.prev !== 'string' || !HEX64.test(x.prev))) throw bad('prev is null or 64 hex');
  if (!isTime(x.claimed_at)) throw bad('claimed_at is RFC 3339 UTC with milliseconds, e.g. 2026-09-26T12:00:00.000Z');
  if (!Number.isInteger(x.count) || (x.count as number) < 1) throw bad('count is a positive integer');
  if (typeof x.digest !== 'string' || !HEX64.test(x.digest)) throw bad('digest is 64 hex');
  if (typeof x.sig !== 'string') throw bad('sig is a string');
  return x as unknown as Manifest;
}

export interface Attestation { identity: string; key_id: string; digest: string; attested_at: string; sig: string }
export interface Checkpoint { identity: string; key_id: string; head: string | null; checkpoint_at: string; sig: string }
export interface FeedAttestation { identity: string; key_id: string; head: string | null; nonce: string; attested_at: string; sig: string }

/** True iff `o.sig` is a valid signature by `key` of `o` without `sig`, under `context`. */
export function verifySigned(context: string, o: { sig: string }, key: KeyEntry): boolean {
  const { sig, ...body } = o;
  try {
    return crypto.verify(null, Buffer.from(context + canonicalize(body)), publicKeyOf(key.public_key),
      Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

/** True iff `key` was valid at time `t` (ms): inside its interval, and not
 *  revoked by then. */
export function keyValidAt(key: KeyEntry, t: number): boolean {
  return t >= Date.parse(key.valid_from) && !(key.valid_until && t >= Date.parse(key.valid_until))
    && !(key.revoked_at && t >= Date.parse(key.revoked_at));
}

/** True iff `m.sig` is a valid signature of the manifest by `key`. */
export function verifyManifestSig(m: Manifest, key: KeyEntry): boolean {
  const { sig, ...unsigned } = m;
  try {
    return crypto.verify(null, Buffer.from(BATCH_CONTEXT + canonicalize(unsigned)), publicKeyOf(key.public_key),
      Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}
