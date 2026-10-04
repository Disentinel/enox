// An empty answer says why when the cause is in the question (r_empty_explains).
//
// The engine answers a question it cannot match with no rows, whatever the
// reason: `edge(F, S, supersedes, T)` (a bare word is an atom, and every
// stored value is a string), a misspelt relation, an unknown predicate, a
// perspective nothing is asserted under. Each of these reads like "the data
// holds none". So, when an answer has no rows, the node looks the question's
// names up in what it keeps (the predicates, the perspectives, each book's
// values by place) and, if that shows the cause is in the question, says so
// with the nearest names that do occur — at the cost of a hit, never of a
// scan (a scan per miss took ~3 s on an owner-sized book). A question that is
// well formed and simply matches nothing gets no note: the note is never noise.
import { parseLiteral, splitArgs } from './engine.ts';
import { ARITY, VALUE_MAX, type RoflenoxNode } from './node.ts';

const ATOM = /^[a-z][A-Za-z0-9_]*$/;
/** A hash-like id: hex of 16 or more, maybe after a kind (`search:…`). */
const HASHLIKE = /^(?:[a-z_]+:)?[0-9a-f]{16,}$/i;
const isString = (x: string) => x.startsWith('"');
const NAMED: Record<string, string[]> = { edge: ['fact', 'source', 'relation', 'target'], live: ['fact', 'source', 'relation', 'target'], edge_num: ['fact', 'source', 'relation', 'number'] };

/** Edit distance (Levenshtein), stopping early past `most`. */
let rowA = new Uint32Array(64), rowB = new Uint32Array(64);
export function distance(a: string, b: string, most = Infinity): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  if (rowA.length <= b.length) { rowA = new Uint32Array(b.length * 2 + 1); rowB = new Uint32Array(b.length * 2 + 1); }
  let prev = rowA, cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let low = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < low) low = v;
    }
    if (low > most) return most + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** The `n` names nearest to `word`, closest first (ties by name), from one
 *  or more sets — walked, not copied. */
export function nearest(word: string, names: Iterable<string> | Iterable<string>[], n = 3): string[] {
  const sources = Array.isArray(names) && names.length > 0 && typeof names[0] !== 'string' ? names as Iterable<string>[] : [names as Iterable<string>];
  const w = word.toLowerCase();
  const best: [number, string][] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const x of src) {
      const cut = best.length === n ? best[n - 1]![0] : Infinity;
      if (Math.abs(x.length - w.length) > cut || seen.has(x)) continue;
      const d = distance(w, x.toLowerCase(), cut);
      if (d > cut || (d === cut && best.length === n && x > best[n - 1]![1])) continue;
      seen.add(x);
      best.push([d, x]);
      best.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : 1));
      if (best.length > n) best.pop();
    }
  }
  return best.map(([, x]) => x);
}

const list = (xs: string[]) => xs.map((x) => JSON.stringify(x)).join(', ');

/** Why `query` (asked as `caller`, under `perspective`) has no rows, when the
 *  cause is in the question; undefined when the data simply holds none. */
export async function explainEmpty(node: RoflenoxNode, query: string, caller: string | null, perspective: string | null): Promise<string | undefined> {
  const { rel, book, args } = parseLiteral(query);
  const a = splitArgs(args);
  const lit = (xs: string[]) => `${rel}${book !== null ? `[${book}]` : ''}(${xs.join(', ')})`;
  const { predicates, perspectives, whole, partial, arity: heads } = await node.vocabulary(caller, perspective !== null);

  if (!predicates.has(rel)) {
    return `no predicate ${rel} here; the nearest that exist: ${nearest(rel, predicates).join(', ')}`;
  }
  const arity = ARITY[rel] ?? heads.get(rel);
  if (arity !== undefined && a.length !== arity) return `${rel} takes ${arity} argument${arity === 1 ? '' : 's'}, not ${a.length}`;
  if (perspective !== null && !perspectives.has(perspective)) {
    return perspectives.size === 0
      ? `no fact here is asserted under any perspective you may read, so none under ${JSON.stringify(perspective)}`
      : `no fact is asserted under perspective ${JSON.stringify(perspective)}; the perspectives here: ${list([...perspectives].sort())}`;
  }
  const rows = async (xs: string[], under = perspective) => (await node.ask(lit(xs), caller, under)).rows;

  // A bare lowercase word is an atom; stored values are strings.
  const words = a.map((x, i) => (ATOM.test(x) ? i : -1)).filter((i) => i >= 0);
  const quoted = a.map((x) => (ATOM.test(x) ? JSON.stringify(x) : x));
  if (words.length > 0) {
    const n = (await rows(quoted)).length;
    if (n > 0) {
      return `${words.map((i) => a[i]).join(', ')} ${words.length === 1 ? 'is a bare word (an atom)' : 'are bare words (atoms)'}, and stored values are strings: `
        + `${lit(quoted)} has ${n} row${n === 1 ? '' : 's'}`;
    }
  }

  // A constant of an edge question that occurs nowhere: in no place of any
  // edge, under any perspective (one that occurs elsewhere is data that holds
  // none, not a question at fault). Looked up in what the node keeps of each
  // book by place (RoflenoxNode.vocabulary) — never by scanning the relation.
  // Only what the engine is not kept for — a book seen through its exports, a
  // value too long to keep — is asked of it, with the value bound.
  const notes: string[] = [];
  if (rel !== 'edge' && rel !== 'edge_num' && rel !== 'live') return undefined;
  // Facts that match under ANOTHER perspective: named, with how many.
  if (perspective !== null) {
    const elsewhere = await rows(a, null);
    if (elsewhere.length > 0) {
      const at = /^[A-Z_]/.test(a[0]!) && a[0] !== '_' ? 0 : -1;
      const by = new Map<string, number>();
      if (at === 0 || isString(a[0]!)) {
        for (const r of elsewhere) {
          const F = at === 0 ? String(r.cells[0]) : JSON.parse(a[0]!) as string;
          const P = whole.map((b) => b.facts.get(F)?.P).find((x) => x !== undefined);
          if (P !== undefined && P !== perspective) by.set(P, (by.get(P) ?? 0) + 1);
        }
      }
      const where = [...by].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([P, n]) => `${n} under ${JSON.stringify(P)}`);
      return `nothing under perspective ${JSON.stringify(perspective)} matches; ${lit(a)} has ${elsewhere.length} row${elsewhere.length === 1 ? '' : 's'}`
        + `${where.length ? ` asserted under other perspectives: ${where.join(', ')}` : ' under other perspectives'}`;
    }
  }
  const PLACES = ['F', 'S', 'R', 'T'] as const;
  const kept = (x: string) => x.length <= VALUE_MAX;
  const occurs = async (x: string, at: number) => {
    const value = JSON.parse(x) as string;
    if (at === 0) {
      if (whole.some((b) => b.facts.has(value))) return true;
    } else if (whole.some((b) => b.S.has(value) || b.R.has(value) || b.T.has(value))) return true;
    if (partial.length === 0 && (at === 0 || kept(value))) return false;
    const places = at === 0 ? [0] : [1, 2, 3];
    for (const j of places) if ((await rows(quoted.map((_, k) => (k === j ? x : `V${k}`)), null)).length > 0) return true;
    return false;
  };
  for (let i = 0; i < quoted.length; i++) {
    const x = quoted[i]!;
    if (!isString(x) || await occurs(x, i)) continue;
    const value = JSON.parse(x) as string;
    let note = `no ${rel} has ${x} as its ${NAMED[rel]![i]}`;
    // An id (a hash) has no near names worth naming: they would be any id.
    if (i > 0 && !HASHLIKE.test(value)) {
      const place = PLACES[i] as 'S' | 'R' | 'T';
      const sets = whole.map((b) => b[place]);
      note += sets.some((x) => x.size) ? `; the nearest that do: ${list(nearest(value, sets))}` : '; none has any you may read';
    }
    notes.push(note);
  }
  return notes.length ? notes.join('; ') : undefined;
}
