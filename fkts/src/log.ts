// The log: the only primary data (r_log_is_truth).
//
//   log/index.jsonl                         one receipt per admission, in order
//   log/<book>/<digest>.jsonl               the facts, bytes exactly as signed
//   log/<book>/<digest>.manifest.json       the signed manifest (JCS)
//   log/<book>/identity-<sha256>.json       an identity document (first contact, rotation, revocation)
//
// A receipt is a batch admission, or (kind "identity") an identity document
// admitted on its own: a requester introducing itself, a rotation. A batch
// mirrored WITHHELD — its reader was not allowed its content — is a chain link
// with a manifest and no JSONL.
//
// The log is split per identity (spec item 9) so that two identities which
// publish byte-identical JSONL — and therefore the same digest — do not
// collide on the manifest file.
//
// COMMIT POINT: the index line. Files are written temp + fsync + rename + fsync
// dir BEFORE the receipt is appended, so a crash anywhere leaves either no
// receipt (the admission never happened; its files are orphans nobody reads)
// or a complete one whose files are already durable. The only torn state a
// crash can leave in the index is a partial LAST line; it is moved to
// quarantine/ and reported, never read as a receipt (r_atomic_write,
// r_no_silent_reset).
import { createHash, type Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize } from './jcs.ts';
import { batchDigest, sha256hex } from './facts.ts';
import { bookOf, type Attestation, type IdentityDoc, type Manifest } from './identity.ts';

export interface Receipt {
  /** 'fork': a second validly signed successor of a batch already in the
   *  chain, kept (manifest only, never admitted) as proof of the fork (r_chain). */
  kind?: 'identity' | 'fork';
  received_at: string;
  /** The batch digest; for an identity receipt, the document's SHA-256. */
  digest: string;
  identity: string;
  /** SHA-256 of the identity document pinned by this admission, if any. */
  pin: string | null;
  /** 'feed' when admitted from a peer's feed under a live challenge. */
  via?: 'feed' | 'envelope';
  /** A fresh signature over the same digest, when the original was stale. */
  reattest?: Attestation;
  /** A chain link whose content this node was not given. */
  withheld?: true;
  /** The salt the digest commits to, alongside the content (absent when withheld). */
  salt?: string;
}

export interface StoredBatch { receipt: Receipt; manifest: Manifest; jsonl: string | null; salt: string | null; pinned: IdentityDoc | null }

/** Fault injection for crash tests: called at named points of a write. A test
 *  passes a hook that exits the process there. Never set in normal operation. */
export type Fault = (point: string) => void;

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** `syncDir: false` leaves the directory's fsync to the caller's next write
 *  in the same directory (it must come before anything names the file). */
export function writeFileAtomic(p: string, data: string, fault: Fault = () => {}, label = path.basename(p), syncDir = true): void {
  const tmp = `${p}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fault(`${label}:temp-written`);
  fs.renameSync(tmp, p);
  if (syncDir) fsyncDir(path.dirname(p));
  fault(`${label}:renamed`);
}

export class Log {
  readonly dir: string;
  readonly quarantine: string;
  private readonly fault: Fault;
  receipts: Receipt[] = [];
  /** What opening had to set aside; reported by /health, never silent. */
  recovered: string[] = [];
  /** Every head this log has had, by how many receipts it held then
   *  (r_ask_at_revision): kept from a running SHA-256 of the index, so
   *  neither a head nor its lookup re-reads the file. */
  private running: Hash = createHash('sha256');
  private readonly heads: string[] = [];
  private readonly countOf = new Map<string, number>();

  constructor(dataDir: string, fault: Fault = () => {}) {
    this.dir = path.join(dataDir, 'log');
    this.quarantine = path.join(dataDir, 'quarantine');
    this.fault = fault;
  }

  get indexPath(): string { return path.join(this.dir, 'index.jsonl'); }

  /** Read the index, setting aside a torn tail and stray temp files. A line
   *  that is complete but unreadable is corruption, not a crash: refuse. */
  open(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    let text = fs.existsSync(this.indexPath) ? fs.readFileSync(this.indexPath, 'utf8') : '';
    if (text.length > 0 && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      const tail = text.slice(cut);
      const q = this.quarantineWrite(`index-tail-${Date.now()}`, tail);
      fs.truncateSync(this.indexPath, Buffer.byteLength(text.slice(0, cut)));
      fsyncDir(this.dir);
      text = text.slice(0, cut);
      this.recovered.push(`a torn last index line (${tail.length} chars, an admission interrupted before its commit) was moved to ${q}`);
    }
    this.running = createHash('sha256');
    this.heads.length = 0;
    this.countOf.clear();
    this.noteHead(0);
    this.receipts = text.split('\n').filter((l) => l.length > 0).map((l, i) => {
      this.running.update(`${l}\n`);
      this.noteHead(i + 1);
      try { return JSON.parse(l) as Receipt; } catch {
        throw new Error(`log/index.jsonl line ${i + 1} is complete but unreadable; refusing to start (the log is not replaced)`);
      }
    });
    for (const sub of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(this.dir, sub.name))) {
        if (f.includes('.tmp-')) {
          const from = path.join(this.dir, sub.name, f);
          const q = this.quarantineWrite(`${sub.name}-${f}`, fs.readFileSync(from, 'utf8'));
          fs.rmSync(from);
          this.recovered.push(`an unfinished temp file log/${sub.name}/${f} was moved to ${q}`);
        }
      }
    }
  }

  private quarantineWrite(name: string, data: string): string {
    fs.mkdirSync(this.quarantine, { recursive: true });
    const p = path.join(this.quarantine, name);
    fs.writeFileSync(p, data);
    return p;
  }

  /** SHA-256 of the index bytes: names this exact log state. */
  head(): string {
    return this.heads[this.heads.length - 1] ?? sha256hex('');
  }

  /** How many receipts the log held when `head` was its head; undefined for
   *  a head it never had. */
  receiptsAt(head: string): number | undefined {
    return this.countOf.get(head);
  }

  /** The head the log had when it held `n` receipts. */
  headAt(n: number): string {
    return this.heads[n]!;
  }

  private noteHead(n: number): void {
    const h = this.running.copy().digest('hex');
    this.heads[n] = h;
    this.countOf.set(h, n);
  }

  private batchPath(identity: string, digest: string, ext: string): string {
    return path.join(this.dir, bookOf(identity), `${digest}.${ext}`);
  }

  read(r: Receipt): StoredBatch {
    const where = `log/${bookOf(r.identity)}/${r.digest}`;
    const need = (p: string) => {
      if (!fs.existsSync(p)) throw new Error(`${where}: a committed file is missing (${path.basename(p)}); refusing to start`);
      return fs.readFileSync(p, 'utf8');
    };
    const jsonl = r.withheld ? null : need(this.batchPath(r.identity, r.digest, 'jsonl'));
    if (jsonl !== null && (r.salt === undefined || batchDigest(r.salt, jsonl) !== r.digest)) {
      throw new Error(`${where}.jsonl does not match its digest; refusing to start`);
    }
    const manifest = JSON.parse(need(this.batchPath(r.identity, r.digest, 'manifest.json'))) as Manifest;
    let pinned: IdentityDoc | null = null;
    if (r.pin) {
      const text = need(path.join(this.dir, bookOf(r.identity), `identity-${r.pin}.json`));
      if (sha256hex(text) !== r.pin) throw new Error(`${where}: pinned identity document does not match its digest`);
      pinned = JSON.parse(text) as IdentityDoc;
    }
    return { receipt: r, manifest, jsonl, salt: r.salt ?? null, pinned };
  }

  /** Durably write one admission. Returns the receipt once committed. */
  append(manifest: Manifest, jsonl: string | null, receivedAt: string, pin: IdentityDoc | null,
    extra: { via?: 'feed' | 'envelope'; reattest?: Attestation; withheld?: true; salt?: string } = {}): Receipt {
    const bookDir = path.join(this.dir, bookOf(manifest.identity));
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
      fsyncDir(this.dir);
    }
    let pinDigest: string | null = null;
    if (pin) {
      const text = canonicalize(pin);
      pinDigest = sha256hex(text);
      writeFileAtomic(path.join(bookDir, `identity-${pinDigest}.json`), text, this.fault, 'identity');
    }
    // (The batch's two files share a directory: one fsync of it, after the
    // manifest's rename, makes both renames durable before the receipt.)
    if (jsonl !== null) writeFileAtomic(this.batchPath(manifest.identity, manifest.digest, 'jsonl'), jsonl, this.fault, 'jsonl', false);
    writeFileAtomic(this.batchPath(manifest.identity, manifest.digest, 'manifest.json'), canonicalize(manifest), this.fault, 'manifest');
    return this.commit({ received_at: receivedAt, digest: manifest.digest, identity: manifest.identity, pin: pinDigest, ...extra });
  }

  /** Durably keep a fork's second successor: its signed manifest, and a
   *  receipt that is not a batch of the chain. */
  appendFork(manifest: Manifest, receivedAt: string): Receipt {
    const bookDir = path.join(this.dir, bookOf(manifest.identity));
    fs.mkdirSync(bookDir, { recursive: true });
    writeFileAtomic(this.batchPath(manifest.identity, manifest.digest, 'manifest.json'), canonicalize(manifest), this.fault, 'fork');
    return this.commit({ kind: 'fork', received_at: receivedAt, digest: manifest.digest, identity: manifest.identity, pin: null, withheld: true });
  }

  /** Durably admit an identity document on its own. */
  appendIdentity(doc: IdentityDoc, receivedAt: string): Receipt {
    const bookDir = path.join(this.dir, bookOf(doc.doc.identity));
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
      fsyncDir(this.dir);
    }
    const text = canonicalize(doc);
    const d = sha256hex(text);
    writeFileAtomic(path.join(bookDir, `identity-${d}.json`), text, this.fault, 'identity');
    return this.commit({ kind: 'identity', received_at: receivedAt, digest: d, identity: doc.doc.identity, pin: d });
  }

  /** The identity document an identity receipt names. */
  readIdentity(r: Receipt): IdentityDoc {
    const p = path.join(this.dir, bookOf(r.identity), `identity-${r.pin}.json`);
    if (!fs.existsSync(p)) throw new Error(`log/${bookOf(r.identity)}: a committed identity document is missing; refusing to start`);
    const text = fs.readFileSync(p, 'utf8');
    if (sha256hex(text) !== r.pin) throw new Error(`log/${bookOf(r.identity)}: identity document does not match its digest`);
    return JSON.parse(text) as IdentityDoc;
  }

  private commit(receipt: Receipt): Receipt {
    const line = `${canonicalize(receipt)}\n`;
    // Written in two halves, so a crash test can stop the real code with a
    // torn line on disk instead of a test forging one (a killed process's
    // writes stay in the page cache; one fsync makes the line durable).
    const fd = fs.openSync(this.indexPath, 'a');
    try {
      const half = Math.floor(line.length / 2);
      fs.writeSync(fd, line.slice(0, half));
      this.fault('index:half-written');
      fs.writeSync(fd, line.slice(half));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.fault('index:committed');
    this.receipts.push(receipt);
    this.running.update(line);
    this.noteHead(this.receipts.length);
    return receipt;
  }
}
