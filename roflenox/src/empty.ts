// An empty answer says why when the cause is in the question (r_empty_explains).
//
// The engine answers a question it cannot match with no rows, whatever the
// reason: `edge(F, S, supersedes, T)` (a bare word is an atom, and every
// stored value is a string), a misspelt relation, an unknown predicate, a
// perspective nothing is asserted under. Each of these reads like "the data
// holds none". So, when an answer has no rows, the node asks a few more
// questions of the same scope and, if one of them shows the cause is in the
// question, says so with the nearest names that do occur. A question that is
// well formed and simply matches nothing gets no note: the note is never noise.
import { parseLiteral, splitArgs } from './engine.ts';
import { ARITY, type RoflenoxNode } from './node.ts';

const ATOM = /^[a-z][A-Za-z0-9_]*$/;
const isString = (x: string) => x.startsWith('"');
/** Fact-keyed predicates: their first argument is a fact id, which has no
 *  "nearest" worth naming. */
const FACT_FIRST = new Set(['edge', 'edge_num', 'asserted', 'conf', 'persp']);
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const NAMED: Record<string, string[]> = { edge: ['fact', 'source', 'relation', 'target'], edge_num: ['fact', 'source', 'relation', 'number'] };

/** Edit distance (Levenshtein), stopping early past `most`. */
export function distance(a: string, b: string, most = Infinity): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]!);
    }
    if (low > most) return most + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The `n` names nearest to `word`, closest first (ties by name). */
export function nearest(word: string, names: Iterable<string>, n = 3): string[] {
  const best: [number, string][] = [];
  for (const x of new Set(names)) {
    const d = distance(word.toLowerCase(), x.toLowerCase(), best.length === n ? best[n - 1]![0] : Infinity);
    if (best.length === n && d > best[n - 1]![0]) continue;
    best.push([d, x]);
    best.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : 1));
    if (best.length > n) best.pop();
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
  const { predicates, perspectives } = await node.vocabulary(caller);

  if (!predicates.has(rel)) {
    return `no predicate ${rel} here; the nearest that exist: ${nearest(rel, predicates).join(', ')}`;
  }
  const arity = ARITY[rel];
  if (arity !== undefined && a.length !== arity) return `${rel} takes ${arity} arguments, not ${a.length}`;
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

  // A constant that occurs nowhere: in no place of the predicate, under any
  // perspective (one that occurs elsewhere is data that holds none, not a
  // question at fault).
  // A fact id is looked for only where fact ids are.
  const notes: string[] = [];
  const occurs = async (x: string, at: number) => {
    for (let j = 0; j < quoted.length; j++) {
      if (FACT_FIRST.has(rel) && (j === 0) !== (at === 0)) continue;
      if ((await rows(quoted.map((_, k) => (k === j ? x : `V${k}`)), null)).length > 0) return true;
    }
    return false;
  };
  for (let i = 0; i < quoted.length; i++) {
    const x = quoted[i]!;
    if (!isString(x) || await occurs(x, i)) continue;
    const what = NAMED[rel]?.[i] ? `as its ${NAMED[rel]![i]}` : `as its ${ORDINAL[i] ?? `${i + 1}th`} argument`;
    const value = JSON.parse(x) as string;
    let note = `no ${rel} has ${x} ${what}`;
    if (!(i === 0 && FACT_FIRST.has(rel))) {
      const all = quoted.map((_, j) => `V${j}`);
      const seen = new Set<string>();
      for (const r of await rows(all, null)) {
        const c = r.cells[i];
        if (typeof c === 'string') seen.add(c);
      }
      note += seen.size ? `; the nearest that do: ${list(nearest(value, seen))}` : '; none has any';
    }
    notes.push(note);
  }
  return notes.length ? notes.join('; ') : undefined;
}
