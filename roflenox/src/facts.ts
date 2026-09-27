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
/** The longest source (an entity: a name, a URI) and relation (a type). */
export const MAX_ENTITY = 2048;
export const MAX_RELATION = 256;

// Access facts: ordinary signed facts with a reserved relation, admitted into
// the OWNER's book like any other, so an identity can only speak about its own.
//   {source: <recipient>, relation: "roflenox:grant",  target: <until, RFC 3339>}
//     — the recipient may read the whole of this book until then.
//   {source: <relation or "*">, relation: "roflenox:export", target: "public" | <identity>}
//     — facts of that relation may leave this node to that audience.
export const GRANT = 'roflenox:grant';
/** {source: <agent identity>, relation: "roflenox:delegate", target: <until>}
 *  — the parent lets that identity act as its agent until then. */
export const DELEGATE = 'roflenox:delegate';
export const EXPORT = 'roflenox:export';
/** Search by meaning (r_semantic_search), all as facts:
 *    {source: <embedder identity>, relation: "roflenox:embedder", target: "search"}
 *      — the operator names who answers its searches;
 *    {source: <search key>, relation: "roflenox:search", target: <query>}
 *      — a search asked (a rule makes it an intent to that embedder);
 *    {source: <n:|f:id:text hash>, relation: "roflenox:embedding", target: <vector>}
 *      — the embedder's derived data, in the EMBEDDER's book. */
export const EMBEDDER = 'roflenox:embedder';
export const SEARCH = 'roflenox:search';
export const EMBEDDING = 'roflenox:embedding';
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

/** Characters that show nothing: white space, format characters (zero-width
 *  spaces and joiners, the BOM, the bidi controls) and control characters. */
const INVISIBLE = /[\p{White_Space}\p{Cf}\p{Cc}]/gu;
/** Bidi embeddings, overrides and isolates: they reorder how a name LOOKS
 *  without changing what it IS (Trojan Source). */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;

/** A line is a directed typed relation between two entities, not a document
 *  (r_relation_primary): the source is an entity — a name or id, one line, of
 *  bounded length — the relation a type of the same kind, and the target an
 *  entity or a value (Enox keeps attributes as relations to values: a label,
 *  a description). None of them is blank or made only of invisible
 *  characters, and a name never carries text-direction controls. The ONE
 *  check: the client (toJsonl, readFacts) and the node (parseJsonl, the
 *  operation table) all come through here, so they cannot drift. */
export function checkRelation(f: Fact, at: string): void {
  for (const k of ['source', 'relation', 'target'] as const) {
    if (f[k].replace(INVISIBLE, '').length === 0) {
      throw new Refusal(400, 'not_a_relation', `${at}: ${k} is blank — made only of invisible or text-direction characters`);
    }
  }
  for (const [k, max] of [['source', MAX_ENTITY], ['relation', MAX_RELATION]] as const) {
    const v = f[k];
    if (BIDI.test(v)) throw new Refusal(400, 'not_a_relation', `${at}: ${k} carries a text-direction control, which makes a name look like another`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Refusal(400, 'not_a_relation', `${at}: ${k} is an entity or a type, one line without control characters`);
    if (v.length > max) throw new Refusal(400, 'not_a_relation', `${at}: ${k} is ${v.length} characters; an entity or a type is at most ${max} — a document is a value, the target of a relation`);
  }
}

/** Throws a 400 Refusal naming the line if `o` is not a well-formed fact. */
export function checkFact(o: unknown, line: number, admission = true): Fact {
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
  // This is ADMISSION's rule: a batch the log already holds is not judged
  // again on replay (the log is truth).
  if (admission) checkRelation(f as unknown as Fact, at);
  if ((f.relation === GRANT || f.relation === DELEGATE) && (!TIME.test(f.target as string) || Number.isNaN(Date.parse(f.target as string)))) {
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
export function parseJsonl(text: string, admission = true): Fact[] {
  if (text.length === 0) throw new Refusal(400, 'empty_batch', 'a batch has at least one fact');
  if (!text.endsWith('\n')) throw new Refusal(400, 'non_canonical', 'every line, including the last, ends in \\n');
  const lines = text.slice(0, -1).split('\n');
  const seen = new Set<string>();
  return lines.map((l, i) => {
    let o: unknown;
    try { o = JSON.parse(l); } catch (e) {
      throw new Refusal(400, 'malformed_fact', `line ${i + 1}: not JSON (${(e as Error).message})`);
    }
    const f = checkFact(o, i + 1, admission);
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
export function toRofl(facts: Fact[], book: string, seq: number, withAsserted = true): string {
  if (!/^b_[0-9a-f]{16}$/.test(book)) throw new Error(`not a book atom: ${book}`);
  const out: string[] = [];
  for (const f of facts) {
    const id = roflString(factId(f));
    out.push(`edge[${book}](${id}, ${roflString(f.source)}, ${roflString(f.relation)}, ${roflString(f.target)}).`);
    if (withAsserted) out.push(`asserted[${book}](${id}, ${roflString(f.perspective)}, ${permille(f.confidence)}, ${seq}).`);
    if (f.relation === GRANT) out.push(`grant[${book}](${roflString(f.source)}, ${Math.floor(Date.parse(f.target) / 1000)}).`);
    if (f.relation === DELEGATE) out.push(`delegate[${book}](${roflString(f.source)}, ${Math.floor(Date.parse(f.target) / 1000)}).`);
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
