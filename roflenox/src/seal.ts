// Private batches (r_encrypt_private): a signed batch sealed to its
// recipients with X25519, HKDF-SHA256 and AES-256-GCM, so it can sit on dumb
// static hosting that cannot read it. The shape is age's and HPKE's, with node
// built-ins only:
//
//   cek          random 32 bytes; the payload key
//   epk          one ephemeral X25519 key per envelope
//   per recipient: kek = HKDF-SHA256(X25519(eph, recipient), salt = epk ‖ recipient key,
//                                    info = "roflenox-seal-v1 wrap")
//                  wrapped = AES-256-GCM(kek, cek), bound to the recipient's name
//   payload      AES-256-GCM(cek, JCS({manifest, jsonl, identity chain})), with the whole header
//                (version, epk, every stanza) as associated data
//
// The batch inside keeps its own Ed25519 signature: sealing hides it, it does
// not replace it. A recipient opens the envelope and admits the batch like any
// other — the signature, the chain and the signer's book all still apply.
import * as crypto from 'node:crypto';
import { canonicalize } from './jcs.ts';
import { Refusal } from './facts.ts';
import type { IdentityDoc, Manifest } from './identity.ts';

/** What travels inside: the signed batch and the signer's document chain, so
 *  a recipient's node can verify it without asking anyone. */
export interface Sealed { manifest: Manifest; jsonl: string; salt: string; identity: IdentityDoc[] }

export const SEAL_VERSION = 'roflenox-sealed-v1';
const WRAP_INFO = Buffer.from('roflenox-seal-v1 wrap');

export interface Stanza { identity: string; iv: string; wrapped: string }
export interface Envelope { v: string; epk: string; recipients: Stanza[]; iv: string; ciphertext: string }
export interface Recipient { identity: string; enc_public_key: string }

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

function x25519Public(x: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
}

function xOf(k: crypto.KeyObject): string {
  return crypto.createPublicKey(k).export({ format: 'jwk' }).x as string;
}

/** The key that wraps the content key for one recipient. Exported so a test
 *  can hold it to depending on the X25519 shared secret, not only public data. */
export function kek(shared: Buffer, epk: string, recipientKey: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([unb64(epk), unb64(recipientKey)]), WRAP_INFO, 32));
}

function gcmSeal(key: Buffer, plain: Buffer, aad: Buffer): { iv: Buffer; out: Buffer } {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv, out };
}

function gcmOpen(key: Buffer, iv: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

/** The associated data of the payload: everything in the envelope but the payload. */
function header(e: Omit<Envelope, 'iv' | 'ciphertext'>): Buffer {
  return Buffer.from(canonicalize({ v: e.v, epk: e.epk, recipients: e.recipients }));
}

/** Seal a signed batch to `recipients` (their names and X25519 keys). */
export function seal(batch: Sealed, recipients: Recipient[]): Envelope {
  if (recipients.length === 0) throw new Error('a sealed batch has at least one recipient');
  const cek = crypto.randomBytes(32);
  const eph = crypto.generateKeyPairSync('x25519').privateKey;
  const epk = xOf(eph);
  const stanzas = recipients.map((r): Stanza => {
    const shared = crypto.diffieHellman({ privateKey: eph, publicKey: x25519Public(r.enc_public_key) });
    const { iv, out } = gcmSeal(kek(shared, epk, r.enc_public_key), cek, Buffer.from(r.identity));
    return { identity: r.identity, iv: b64(iv), wrapped: b64(out) };
  });
  const h = { v: SEAL_VERSION, epk, recipients: stanzas };
  const { iv, out } = gcmSeal(cek, Buffer.from(canonicalize({ manifest: batch.manifest, jsonl: batch.jsonl, salt: batch.salt, identity: batch.identity })), header(h));
  return { ...h, iv: b64(iv), ciphertext: b64(out) };
}

/** Open an envelope as `identity` holding `encPrivate`. Refuses (never
 *  returns partial content) if this identity is not a recipient or anything
 *  in the envelope was altered. */
export function open(e: Envelope, identity: string, encPrivate: crypto.KeyObject): Sealed {
  if (!e || e.v !== SEAL_VERSION || !Array.isArray(e.recipients)) throw new Refusal(400, 'not_sealed', 'not a roflenox sealed batch');
  const mine = e.recipients.filter((s) => s.identity === identity);
  if (mine.length === 0) throw new Refusal(403, 'not_a_recipient', `this batch is not sealed to ${identity}`);
  const myKey = xOf(encPrivate);
  const shared = crypto.diffieHellman({ privateKey: encPrivate, publicKey: x25519Public(e.epk) });
  for (const s of mine) {
    let cek: Buffer;
    try { cek = gcmOpen(kek(shared, e.epk, myKey), unb64(s.iv), unb64(s.wrapped), Buffer.from(identity)); } catch { continue; }
    try {
      const plain = gcmOpen(cek, unb64(e.iv), unb64(e.ciphertext), header(e));
      return JSON.parse(plain.toString('utf8')) as Sealed;
    } catch {
      throw new Refusal(422, 'sealed_tampered', 'the sealed batch was altered after sealing');
    }
  }
  throw new Refusal(403, 'cannot_unwrap', `no key for ${identity} in this envelope opens with this identity's key`);
}
