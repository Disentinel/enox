// Facts, their canonical line form, and how they are written into the engine.
//
// One fact per JSONL line; the line IS the JCS of {source, relation, target,
// perspective, confidence}, each line ends in "\n", and the batch digest is
// SHA-256 over exactly those bytes. A line that parses but is not already
// canonical is refused rather than repaired: a recipient must be able to
// recompute the digest from the bytes it holds (r_verify_without_author).
import { createHash, randomBytes } from 'node:crypto';
import { canonicalize, JcsError } from './jcs.ts';

export interface Fact {
  source: string;
  relation: string;
  target: string;
  perspective: string;
  confidence: number;
}

const FIELDS = ['confidence', 'perspective', 'relation', 'source', 'target'];

// Access facts: ordinary signed facts with a reserved relation, admitted into
// the OWNER's book like any other, so an identity can only speak about its own.
//   {source: <recipient>, relation: "roflenox:grant",  target: <until, RFC 3339>}
//     — the recipient may read the whole of this book until then.
//   {source: <relation or "*">, relation: "roflenox:export", target: "public" | <identity>}
//     — facts of that relation may leave this node to that audience.
export const GRANT = 'roflenox:grant';
export const EXPORT = 'roflenox:export';
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class Refusal extends Error {
  readonly status: number;
  readonly reason: string;
  /** Anything the refusal carries besides its message — e.g. the engine's whynot. */
  readonly detail: Record<string, unknown>;
  constructor(status: number, reason: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A batch's digest commits to a random 256-bit SALT as well as its JSONL:
 *  SHA-256(salt ‖ JSONL bytes). The salt travels only with the content, so a
 *  manifest shown without its content (withheld) cannot be used to confirm a
 *  guess at what it signs (r_withheld_unguessable). */
export function batchDigest(salt: string, jsonl: string): string {
  return createHash('sha256').update(Buffer.from(salt, 'base64url')).update(jsonl).digest('hex');
}

export function newSalt(): string {
  return randomBytes(32).toString('base64url');
}

export function isSalt(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
}

/** fact_id = SHA-256 hex of JCS([source, relation, target]). Derived, never primary. */
export function factId(f: { source: string; relation: string; target: string }): string {
  return sha256hex(canonicalize([f.source, f.relation, f.target]));
}

/** Throws a 400 Refusal naming the line if `o` is not a well-formed fact. */
export function checkFact(o: unknown, line: number): Fact {
  const at = `line ${line}`;
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new Refusal(400, 'malformed_fact', `${at}: a fact is a JSON object`);
  }
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== FIELDS.join(',')) {
    throw new Refusal(400, 'malformed_fact',
      `${at}: a fact has exactly the fields ${FIELDS.join(', ')}; got ${keys.join(', ')}`);
  }
  const f = o as Record<string, unknown>;
  for (const k of ['source', 'relation', 'target', 'perspective']) {
    if (typeof f[k] !== 'string' || (f[k] as string).length === 0) {
      throw new Refusal(400, 'malformed_fact', `${at}: ${k} must be a non-empty string`);
    }
  }
  if (f.relation === GRANT && (!TIME.test(f.target as string) || Number.isNaN(Date.parse(f.target as string)))) {
    throw new Refusal(400, 'malformed_fact', `${at}: a grant's target is its expiry, RFC 3339 UTC with milliseconds`);
  }
  const c = f.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
    throw new Refusal(400, 'malformed_fact', `${at}: confidence must be a number in [0, 1]`);
  }
  return f as unknown as Fact;
}

/** The canonical JSONL of a list of facts. */
export function toJsonl(facts: Fact[]): string {
  return facts.map((f, i) => {
    checkFact(f, i + 1);
    return `${canonicalize(f)}\n`;
  }).join('');
}

/** Parse and validate canonical JSONL. Every refusal is a 400 naming the line. */
export function parseJsonl(text: string): Fact[] {
  if (text.length === 0) throw new Refusal(400, 'empty_batch', 'a batch has at least one fact');
  if (!text.endsWith('\n')) throw new Refusal(400, 'non_canonical', 'every line, including the last, ends in \\n');
  const lines = text.slice(0, -1).split('\n');
  const seen = new Set<string>();
  return lines.map((l, i) => {
    let o: unknown;
    try { o = JSON.parse(l); } catch (e) {
      throw new Refusal(400, 'malformed_fact', `line ${i + 1}: not JSON (${(e as Error).message})`);
    }
    const f = checkFact(o, i + 1);
    let canon: string;
    try { canon = canonicalize(f); } catch (e) {
      if (e instanceof JcsError) throw new Refusal(400, 'non_canonical', `line ${i + 1}: ${e.message}`);
      throw e;
    }
    if (canon !== l) throw new Refusal(400, 'non_canonical', `line ${i + 1}: not in RFC 8785 canonical form`);
    const id = factId(f);
    if (seen.has(id)) {
      throw new Refusal(400, 'duplicate_fact', `line ${i + 1}: the same [source, relation, target] appears twice in one batch`);
    }
    seen.add(id);
    return f;
  });
}

// ---------------------------------------------------------------------------
// Into ROFL. The engine's string escapes are exactly \n \t \r \\ \" (measured
// against rofl-serve: `\u` is refused, any other character is taken raw), so
// the encoder escapes those five and nothing else. Its OUTPUT uses JSON escapes,
// so a cell that comes back is decoded with JSON.parse.

export function roflString(s: string): string {
  return `"${s.replace(/[\\"\n\t\r]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' })[c]!)}"`;
}

/** Confidence in the engine is an integer permille: ROFL terms are ints,
 *  strings and atoms, and a float would have to become a string anyway. */
export function permille(c: number): number {
  return Math.round(c * 1000);
}

/** The ROFL program for one batch, every fact in `book` and nowhere else. The
 *  book is chosen by the caller from the SIGNER; nothing in a fact can name it.
 *
 *  `seq` is the batch's position in its signer's chain (0-based), which is the
 *  log order of that identity's assertions — proven by the chain, the same on
 *  every node. Each assertion is kept as asserted[book](F, Perspective,
 *  Permille, Seq); which one is CURRENT is a rule over seq (engine.bookRules),
 *  so a re-assertion replaces the earlier one (r_confidence). */
export function toRofl(facts: Fact[], book: string, seq: number): string {
  if (!/^b_[0-9a-f]{16}$/.test(book)) throw new Error(`not a book atom: ${book}`);
  const out: string[] = [];
  for (const f of facts) {
    const id = roflString(factId(f));
    out.push(`edge[${book}](${id}, ${roflString(f.source)}, ${roflString(f.relation)}, ${roflString(f.target)}).`);
    out.push(`asserted[${book}](${id}, ${roflString(f.perspective)}, ${permille(f.confidence)}, ${seq}).`);
    if (f.relation === GRANT) out.push(`grant[${book}](${roflString(f.source)}, ${Math.floor(Date.parse(f.target) / 1000)}).`);
    if (f.relation === EXPORT) out.push(`export[${book}](${roflString(f.source)}, ${roflString(f.target)}).`);
  }
  return `${out.join('\n')}\n`;
}

/** A cell as the engine prints it, as a JSON value: strings and integers
 *  decoded, anything else (an atom, a compound term) left as its text. */
export function decodeCell(cell: string): string | number {
  if (cell.startsWith('"')) return JSON.parse(cell) as string;
  if (/^-?\d+$/.test(cell)) return Number(cell);
  return cell;
}
