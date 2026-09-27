// User rules (r_user_rules): an identity publishes ROFL rules as ordinary
// signed facts in its own book —
//
//   {source: <rule name>, relation: "roflenox:rule", target: "<head> :- <body>."}
//
// — and the node compiles each one before loading it, so that the rule
//   * concludes ONLY into its author's book: a head with no book, `[@author]`
//     or the author's own book atom is placed there; any other head refuses
//     the whole batch;
//   * reads its author's book by default (an unbooked body literal), another
//     identity's book by name (`edge[@bob](...)`), never the system book;
//   * reads another book only while the author may: every literal over a
//     foreign book gets the premise may_read[sys](author, that book), so a
//     grant that expires stops the rule from seeing it — dynamically, by the
//     same rule that answers asks (r_grants);
//   * may range over books: a body literal whose book is a VARIABLE
//     (`edge[B](...)`, B bound by the rule — e.g. from `follows(Name, B)`, which
//     the node derives from the author's roflenox:follow facts) reads every
//     book the author may read, each under the same may_read premise. One rule
//     then covers every followed feed, including one followed later.
import { Refusal, roflString } from './facts.ts';
import { bookOf, checkName } from './identity.ts';
import { SYSTEM_BOOK } from './engine.ts';

export const RULE = 'roflenox:rule';

const LITERAL = /^(not\s+)?([a-z][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*\(([\s\S]*)\)$/;
const BOOK = /^b_[0-9a-f]{16}$/;
const VAR = /^[A-Z][A-Za-z0-9_]*$/;

/** Split at top-level occurrences of `sep` (outside strings and brackets). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', inStr = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && s.startsWith(sep, i)) { out.push(cur.trim()); cur = ''; i += sep.length - 1; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function bad(why: string): Refusal {
  return new Refusal(422, 'bad_rule', why);
}

function resolveBook(ref: string | undefined, author: string, head: boolean): string {
  const own = bookOf(author);
  if (ref === undefined || ref.trim() === '') return own;
  const r = ref.trim();
  if (VAR.test(r)) {
    if (head) throw new Refusal(422, 'rule_scope', `a rule of ${author} concludes only into ${author}'s own book, not a book variable ${r}`);
    return r;
  }
  const book = r.startsWith('@') ? bookOf(checkName(r.slice(1))) : BOOK.test(r) ? r : null;
  if (book === null) throw bad(`a rule names books as @identity, b_<16 hex> or a variable; "${r}" is none of these`);
  if (head && book !== own) {
    throw new Refusal(422, 'rule_scope', `a rule of ${author} concludes only into ${author}'s own book, not ${r}`);
  }
  return book;
}

/** Compile one user rule for `author`: the ROFL text to load. */
export function compileRule(text: string, author: string): string {
  const t = text.trim();
  if (!t.endsWith('.')) throw bad('a rule ends with a full stop');
  const parts = splitTop(t.slice(0, -1), ':-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad('a rule is HEAD :- BODY.');
  const hm = LITERAL.exec(parts[0]);
  if (!hm || hm[1]) throw bad('a rule head is one positive literal');
  const headBook = resolveBook(hm[3], author, true);
  const foreign = new Set<string>();
  const variables = new Set<string>();
  const body = splitTop(parts[1], ',').map((lit) => {
    if (lit === '') throw bad('an empty premise');
    const m = LITERAL.exec(lit);
    if (!m) {
      // A comparison (X < Y, X != "a"): it may not name a book.
      if (/[[\]$]/.test(lit.replace(/"(?:[^"\\]|\\.)*"/g, ''))) throw bad(`"${lit}" names a book outside a literal`);
      return lit;
    }
    const book = resolveBook(m[3], author, false);
    if (VAR.test(book)) variables.add(book);
    else if (book !== bookOf(author)) foreign.add(book);
    return `${m[1] ?? ''}${m[2]}[${book}](${m[4]})`;
  });
  for (const b of [...foreign].sort()) body.push(`may_read[${SYSTEM_BOOK}](${roflString(author)}, ${roflString(b)})`);
  for (const v of [...variables].sort()) body.push(`may_read_book[${SYSTEM_BOOK}](${roflString(author)}, ${v})`);
  return `${hm[2]}[${headBook}](${hm[4]}) :- ${body.join(', ')}.`;
}
