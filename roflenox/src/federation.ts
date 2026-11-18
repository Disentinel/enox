// PODS (r_pods): a federation where each pod holds only its files and a
// coordinator holds the question.
//
//   pod  = a node of its own identity + an engine holding ONE program (any
//          ROFL files, e.g. the JS model) over the corpus's core and the
//          pod's files only;
//   coordinator = a plain node that follows the pods' feeds and holds the
//          cross-file rules (ordinary roflenox:rule facts) and the question.
//
// WHAT CROSSES is decided by the coordinator's rules, never by a model's
// relation names: every relation a cross-file rule's body reads is an
// ESCAPE, narrowed by the constants its premises spell (a premise
// `n(E, "export_all_declaration", F)` lets only those rows of `n` cross; one
// premise with no constant lets every row cross). The pod watches each escape
// in its engine (rofl serve `watch`) and publishes the rows as ordinary signed
// facts of its own book; after an edit, only the rows that came (asserted at
// confidence 1) and went (re-asserted at 0, which retires them).
//
// A ROW on the wire: relation R's row (a1, ..., an) is n facts
//   {source: <row id>, relation: "row:R#i", target: ai}
// the row id a hash of R and the cells, so the same row is the same facts on
// every pod and across restarts. The coordinator reads them back by one rule
// per escape (decodeRules), over every book it follows, through the facts'
// CURRENT assertion (asserted, confidence above 0).
//
// THE CORE is what a scan writes naming no node (n<16 hex>_, the scanner's
// file prefix): the directory listing, the strings cut as specifiers; a
// file's facts are those naming its prefix. A pod holds only the core its
// files reach BY THE PROGRAM'S KEYS (coreDemand, CoreRouter), as the engine's
// volumes lay a fact where a rule joins it (finding
// f_volumes_cross_by_the_rules_keys): the escapes are demanded whole, and
// demand flows from a rule's head to its premises in a sideways order (the
// relations with no core facts first), a premise keyed at the positions the
// head's demand or an earlier premise binds to a STORED value (one some base
// fact holds) or to one the rule's builtins compute from a single bound value:
// those the router computes FORWARD, on the pod's values and on the core
// fact's (forwardEval: a file's stem from its name). Each keyed position knows where
// its values come from: the places of base relations (through the derived
// relations between) and constants. A core fact is laid in a pod when one of
// its relation's keys holds, at each keyed position, a value the pod's world
// holds AT ONE OF THAT POSITION'S SOURCES: its files' facts and the core facts
// laid so far (to a fixpoint). A premise whose other places are `_` asks only
// whether some fact holds the keyed values: one fact of each such tuple, a
// witness, is laid. It is magic sets with each magic relation widened to the
// values its sources hold, so every fact the escapes' derivations read is laid.
//
// THE CUT IS SOUND WHEN every row a pod derives of an escape holds in the
// whole world, and every row the whole world derives is a pod's or the
// coordinator's — i.e. the rules that cross files are the coordinator's. The
// mechanism does not prove that of a program; the oracle of
// test/pods.test.ts holds the coordinator to the whole world, row for row.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineRefusal, RoflPort, type RoflSession } from '@grafema/rofl/port';
import { DEFAULT_ROFL_BIN, termCell, type Change } from './engine.ts';
import { roflString, type Fact } from './facts.ts';
import { BUILTIN, splitTop } from './rules.ts';

const ROFL_DIST = path.join(path.dirname(fileURLToPath(import.meta.resolve('@grafema/rofl/package.json'))), 'dist/src');
const PARSER = path.join(ROFL_DIST, 'parser.js');

export const ROW = 'row:';
/** The walls of a pod's world: a corpus's program runs far past the engine's default rows. */
export const WALLS = { budget: 1e9, space: 1e9 };
const LITERAL = /^(not\s+)?([a-z][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*\(([\s\S]*)\)$/;
const VAR = /^[A-Z_]/;

/** A relation that crosses: its arity and, unless `all`, the premises' constants (position → value) a row must match one of. */
export interface Escape { rel: string; arity: number; all: boolean; filters: Map<number, string>[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** The scanner's prefix of every node id of a file (oxc_scan `prefix`). */
export const filePrefix = (file: string) => `n${sha(file).slice(0, 16)}_`;
const NODE = /n[0-9a-f]{16}_/;

function constant(arg: string): string | null {
  const a = arg.trim();
  if (a === '' || VAR.test(a)) return null;
  if (a.startsWith('"')) return JSON.parse(a) as string;
  return a;
}

/** The relations the coordinator's rules read, each with the constants that narrow it. */
export function escapesOf(rules: string[]): Escape[] {
  const by = new Map<string, Escape>();
  for (const text of rules) {
    const t = text.trim().replace(/\.$/, '');
    const [, body] = splitTop(t, ':-');
    if (body === undefined) throw new Error(`not a rule: ${text}`);
    for (const lit of splitTop(body, ',')) {
      const m = LITERAL.exec(lit.trim());
      if (!m || m[3] !== undefined || BUILTIN.has(m[2]!)) continue;
      const args = splitTop(m[4]!, ',');
      const rel = m[2]!;
      let e = by.get(rel);
      if (!e) { e = { rel, arity: args.length, all: false, filters: [] }; by.set(rel, e); }
      if (e.arity !== args.length) throw new Error(`${rel} is read with ${e.arity} and ${args.length} arguments`);
      const f = new Map<number, string>();
      args.forEach((a, i) => { const c = constant(a); if (c !== null) f.set(i, c); });
      // A negated premise reads the relation whole: its absence must be judged on every row.
      if (f.size === 0 || m[1]) e.all = true; else e.filters.push(f);
    }
  }
  return [...by.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

const passes = (e: Escape, cells: string[]) => e.all || e.filters.some((f) => [...f].every(([i, v]) => cells[i] === v));

/** The coordinator's rules that read the escapes back from every followed pod, by their current assertion. */
export function decodeRules(escapes: Escape[]): string[] {
  return escapes.map((e) => {
    const vars = Array.from({ length: e.arity }, (_, i) => `A${i}`);
    const reads = vars.map((v, i) => `edge[B](F${i}, T, ${roflString(`${ROW}${e.rel}#${i + 1}`)}, ${v}), asserted[B](F${i}, P${i}, C${i}, S${i}), C${i} > 0`);
    return `${e.rel}(${vars.join(', ')}) :- follows(N, B), ${reads.join(', ')}.`;
  });
}

/** A row's facts: the same row, the same facts. */
export function rowFacts(rel: string, cells: string[], confidence: number): Fact[] {
  const id = `${rel}:${sha(JSON.stringify([rel, cells])).slice(0, 32)}`;
  return cells.map((c, i) => {
    if (c.trim() === '') throw new Error(`${rel}: a blank cell at ${i + 1} cannot be published (a fact's target is never blank)`);
    return { source: id, relation: `${ROW}${rel}#${i + 1}`, target: c, perspective: 'pod', confidence };
  });
}

/** The facts of a ROFL text, one a clause: a string may hold a line break, a `--` line between clauses is a comment. */
export function factsOf(text: string): string[] {
  const out: string[] = [];
  let start = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '-' && text[i + 1] === '-' && text.slice(start, i).trim() === '') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; start = i + 1; continue; }
    if (c === '.' && (i + 1 === text.length || text[i + 1] === '\n')) { const f = text.slice(start, i + 1).trim(); if (f !== '.') out.push(f); start = i + 1; }
  }
  if (text.slice(start).trim() !== '') throw new Error(`a clause without its full stop: ${text.slice(start, start + 120)}`);
  return out;
}

/** A scan's facts cut by file: those naming a file's node prefix, and the core naming none. */
export function splitFacts(text: string, files: string[]): { core: Set<string>; byFile: Map<string, Set<string>> } {
  const of = new Map(files.map((f) => [filePrefix(f), f]));
  const core = new Set<string>();
  const byFile = new Map(files.map((f) => [f, new Set<string>()]));
  for (const l of factsOf(text)) {
    const m = NODE.exec(l);
    if (!m) { core.add(l); continue; }
    const f = of.get(m[0]);
    if (f === undefined) throw new Error(`a fact names a node of no listed file: ${l.slice(0, 120)}`);
    byFile.get(f)!.add(l);
  }
  return { core, byFile };
}

type Term = { k: 'v' | 'a'; name: string } | { k: 'i'; v: number | bigint } | { k: 's'; v: string } | { k: 'f'; name: string; args: Term[] };
interface Lit { rel: string; args: Term[] }
type Elem = { t: 'pos' | 'neg'; lit: Lit } | { t: 'bi'; op: string; l: Term; r: Term } | { t: 'agg'; body: Elem[] };
interface Clause { head: Lit; body: Elem[]; structure?: { kind: string; closure?: string; source?: Lit }; lattice?: string; dominator?: unknown; want?: boolean; ord?: unknown }

/** A value as the router compares it: s<text>, i<digits>, a<atom>. */
const valueOf = (t: Term): string | null => (t.k === 's' ? `s${t.v}` : t.k === 'i' ? `i${t.v}` : t.k === 'a' ? `a${t.name}` : null);

/** A key of a relation: the positions a fact's values must be held at and, at each, where they may come from: the
 *  values facts of `R` hold at `j` in the pod's world (a source `R#j`), or the program's constants. */
export interface Key { at: number[]; from: { sources: Set<string>; values: Set<string> }[];
  /** Every premise read by this key binds nothing else (its other places are `_`): a test that SOME fact holds the
   *  keyed values, so one fact of each such tuple, a witness, is all a derivation reads. */
  exists: boolean;
  /** Per position, where the key reads not the fact's value there but what the rule's builtins compute from it
   *  (a file's stem from its name): the values compared are those. */
  calc?: (Calc | undefined)[] }
/** A value computed forward by a rule's builtins from one value: every value the rule could bind its variable to. */
export interface Calc { id: string; fn: (cell: string) => string[] }
/** What the program reads of the core: per relation its keys; the sources a pod must track and every key's constants;
 *  the computed sources (`~id`): what a Calc gives of the values held at its input sources. */
export interface Demand { keys: Map<string, Key[]>; sources: Set<string>; values: Set<string>; calc: Map<string, { calc: Calc; input: Set<string> }> }

type Subst = Map<string, Term>;
/** A rule body's builtins run FORWARD from one variable's value, with the engine's own builtins (the package's
 *  evalStrOp, evalArith): `calc(els, x, v)` is the function giving every value `x` can take when `v` holds a
 *  value, or null when the builtins do not determine `x` from `v` alone. A derived premise that binds a variable a
 *  builtin needs is unfolded (its rules, to depth 2); every other premise is taken to hold, so the values given are
 *  a superset of what the engine derives, never fewer: a filter (`N > 1`) drops a value only where the engine's
 *  same builtin fails for every derivation through it. */
async function forwardEval(rules: Map<string, { head: Lit; body: Elem[] }[]>) {
  const U = await import(path.join(ROFL_DIST, 'unify.js')) as {
    walk: (t: Term, s: Subst) => Term; resolve: (t: Term, s: Subst) => Term; unify: (a: Term, b: Term, s: Subst) => Subst | null;
    isGround: (t: Term) => boolean; canonTerm: (t: Term) => string; evalArith: (t: Term, s: Subst, fail?: { code: number }) => number | bigint | null;
    mki: (v: number | bigint) => Term; mks: (v: string) => Term; mka: (n: string) => Term; ARITH_OPS: Set<string> };
  const { evalStrOp, STR_ARITY } = await import(path.join(ROFL_DIST, 'reflect.js')) as {
    evalStrOp: (t: Term, s: Subst, fail?: { code: number }) => Term | null | undefined; STR_ARITY: Map<string, number> };
  const SYM: Term = { k: 'a', name: '\u0001sym' };
  const known = (t: Term): boolean => t.k !== 'f' || ((U.ARITH_OPS.has(t.name) || STR_ARITY.has(t.name)) && t.args.every(known));
  const ground = (t: Term, s: Subst): boolean => { const w = U.walk(t, s); return w.k !== 'v' && (w.k !== 'f' || w.args.every((a) => ground(a, s))); };
  const hasSym = (t: Term): boolean => (t.k === 'a' && t.name === SYM.name) || (t.k === 'f' && t.args.some(hasSym));
  /** A number or string a builtin side evaluates to, as the engine compares them; null where it fails. */
  const side = (t: Term, s: Subst): bigint | null => {
    const so = evalStrOp(t, s, { code: 0 });
    if (so === undefined) { const n = U.evalArith(t, s, { code: 0 }); return n === null ? null : BigInt(n); }
    return so !== null && so.k === 'i' ? BigInt(so.v) : null;
  };
  /** One builtin: a substitution, null (it fails: no derivation goes through), undefined (not yet evaluable). */
  const step = (e: Elem & { t: 'bi' }, s: Subst, sym: boolean): Subst | null | undefined => {
    const gl = ground(e.l, s), gr = ground(e.r, s);
    if (e.op === 'is') {
      if (!gr || !known(e.r)) return undefined;
      if (sym) return gl ? s : U.unify(e.l, SYM, s);
      const so = evalStrOp(e.r, s, { code: 0 });
      let v: Term | null;
      if (so === undefined) { const n = U.evalArith(e.r, s, { code: 0 }); v = n === null ? null : U.mki(n); } else v = so;
      return v === null ? null : U.unify(e.l, v, s);
    }
    if (e.op === '=') return gl || gr ? (sym && gl && gr ? s : U.unify(e.l, e.r, s)) : undefined;
    if (!gl || !gr) return undefined;
    if (sym) return s;
    if (e.op === '!=') return U.canonTerm(U.resolve(e.l, s)) !== U.canonTerm(U.resolve(e.r, s)) ? s : null;
    if (!['<', '<=', '>', '>='].includes(e.op) || !known(e.l) || !known(e.r)) return undefined;
    const a = side(e.l, s), b = side(e.r, s);
    if (a === null || b === null) return null;
    return (e.op === '<' ? a < b : e.op === '<=' ? a <= b : e.op === '>' ? a > b : a >= b) ? s : null;
  };
  let fresh = 0;
  const rename = (t: Term, n: number): Term => (t.k === 'v' ? { k: 'v', name: `${t.name}'${n}` } : t.k === 'f' ? { ...t, args: t.args.map((a) => rename(a, n)) } : t);
  const renameEl = (e: Elem, n: number): Elem => (e.t === 'bi' ? { ...e, l: rename(e.l, n), r: rename(e.r, n) }
    : e.t === 'agg' ? { ...e, body: e.body.map((b) => renameEl(b, n)) } : { ...e, lit: { ...e.lit, args: e.lit.args.map((a) => rename(a, n)) } });
  const varsIn = (t: Term, into: Set<string>) => { if (t.k === 'v') into.add(t.name); if (t.k === 'f') t.args.forEach((a) => varsIn(a, into)); };
  /** The builtins, in the order they ran, of a symbolic run that unfolded nothing: a value's run is that order. */
  let trace: number[] | null = null;
  const solve = (els: Elem[], s: Subst, depth: number, sym: boolean, want: string, done: Set<number>): Subst[] => {
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!;
      if (done.has(i) || e.t !== 'bi') continue;
      const r = step(e, s, sym);
      if (r === undefined) continue;
      if (r === null) return [];
      trace?.push(i);
      return solve(els, r, depth, sym, want, new Set(done).add(i));
    }
    // No builtin moves: unfold a derived premise holding a variable an open builtin (or the wanted one) needs.
    const needed = new Set<string>([want]);
    els.forEach((e, i) => { if (!done.has(i) && e.t === 'bi') { varsIn(e.l, needed); varsIn(e.r, needed); } });
    for (let i = 0; i < els.length && depth > 0; i++) {
      const e = els[i]!;
      if (done.has(i) || e.t !== 'pos' || !rules.has(e.lit.rel)) continue;
      const open = e.lit.args.filter((a) => a.k === 'v' && needed.has(a.name) && !ground(a, s));
      if (open.length === 0 || !e.lit.args.some((a) => ground(a, s))) continue;
      trace = null;
      const out: Subst[] = [];
      for (const r of rules.get(e.lit.rel)!) {
        const n = ++fresh;
        let s1: Subst | null = s;
        r.head.args.forEach((h, j) => {
          if (s1 === null) return;
          const a = e.lit.args[j]!;
          // Symbolically a value matches any constant of a head: the rule may hold for it.
          if (sym && h.k !== 'v' && h.k !== 'f' && ground(a, s1) && hasSym(U.resolve(a, s1))) return;
          s1 = U.unify(rename(h, n), a, s1);
        });
        if (s1 === null) continue;
        const body = r.body.map((b) => renameEl(b, n));
        for (const s2 of solve(body, s1, depth - 1, sym, '', new Set())) out.push(...solve(els, s2, depth, sym, want, new Set(done).add(i)));
      }
      return out;
    }
    return [s];
  };
  const memo = new Map<Elem[], Map<string, Calc | null>>();
  let ids = 0;
  return (els: Elem[], x: string, v: string): Calc | null => {
    const m = memo.get(els) ?? new Map<string, Calc | null>();
    memo.set(els, m);
    const k = `${x}\0${v}`;
    if (m.has(k)) return m.get(k)!;
    trace = [];
    const outs = solve(els, new Map([[v, SYM]]), 2, true, x, new Set());
    const plan = trace as number[] | null;
    trace = null;
    const run = (cell: string): Subst[] => {
      const s0: Subst = new Map([[v, termOfCell(cell, U)]]);
      if (!plan) return solve(els, s0, 2, false, x, new Set());
      let s: Subst | null | undefined = s0;
      for (const i of plan) {
        const e = els[i] as Elem & { t: 'bi' };
        // An `is` writing a variable no step bound yet binds it in place; every other step as the engine runs it.
        if (e.op === 'is' && e.l.k === 'v' && U.walk(e.l, s).k === 'v' && known(e.r) && ground(e.r, s)) {
          const so = evalStrOp(e.r, s, { code: 0 });
          let w: Term | null;
          if (so === undefined) { const n = U.evalArith(e.r, s, { code: 0 }); w = n === null ? null : U.mki(n); } else w = so;
          if (w === null) { s = null; break; }
          s.set((U.walk(e.l, s) as { name: string }).name, w);
          continue;
        }
        s = step(e, s, false);
        if (!s) break;
      }
      return s === null ? [] : s === undefined ? solve(els, s0, 2, false, x, new Set()) : [s];
    };
    let c: Calc | null = null;
    if (outs.length > 0 && outs.every((s) => ground({ k: 'v', name: x }, s))) {
      const cache = new Map<string, string[]>();
      c = { id: String(ids++), fn: (cell) => {
        let got = cache.get(cell);
        if (got) return got;
        const vals = new Set<string>();
        for (const s of run(cell)) {
          const t = U.resolve({ k: 'v', name: x }, s);
          const w = U.isGround(t) ? valueOf(t) : null;
          // The analysis said the builtins bind x; a run that does not is a defect, not an answer.
          if (w === null) throw new Error(`the router computed no value of ${x} from ${v}=${cell}`);
          vals.add(w);
        }
        got = [...vals];
        cache.set(cell, got);
        return got;
      } };
    }
    m.set(k, c);
    return c;
  };
}
/** A router value (valueOf) as a term. */
const termOfCell = (c: string, U: { mki: (v: number | bigint) => Term; mks: (v: string) => Term; mka: (n: string) => Term }): Term =>
  (c[0] === 's' ? U.mks(c.slice(1)) : c[0] === 'i' ? U.mki(BigInt(c.slice(1))) : U.mka(c.slice(1)));

/** The program's demand on the relations of `homeless` (those the core holds facts of), from the escapes down;
 *  null where the program holds a construct the analysis does not model (then a pod is given the whole core). */
export async function coreDemand(program: string, roots: string[], homeless: Set<string>): Promise<Demand | null> {
  const { parseProgram } = await import(PARSER) as { parseProgram: (src: string) => Clause[] };
  const clauses: Clause[] = [];
  for (const f of programFiles(program)) clauses.push(...parseProgram(fs.readFileSync(f, 'utf8')));
  const rules = new Map<string, { head: Lit; body: Elem[] }[]>();
  const rule = (head: Lit, body: Elem[]) => { const r = rules.get(head.rel) ?? []; r.push({ head, body }); rules.set(head.rel, r); };
  for (const c of clauses) {
    if (c.lattice !== undefined || c.dominator !== undefined || c.want || c.ord !== undefined) return null;
    const s = c.structure;
    if (!s) rule(c.head, c.body);
    else if (s.kind === 'alias' && s.source) rule(c.head, [{ t: 'pos', lit: s.source }]);
    else if (s.kind === 'tree' && s.closure && c.head.args.length === 2) {
      const [X, Y, Z] = ['X', 'Y', 'Z'].map((name) => ({ k: 'v', name }) as Term);
      rule({ rel: s.closure, args: [X!, Y!] }, [{ t: 'pos', lit: { rel: c.head.rel, args: [X!, Y!] } }]);
      rule({ rel: s.closure, args: [X!, Z!] }, [{ t: 'pos', lit: { rel: c.head.rel, args: [X!, Y!] } }, { t: 'pos', lit: { rel: s.closure, args: [Y!, Z!] } }]);
    } else if (s.kind !== 'function') return null;
  }
  const forward = await forwardEval(rules);
  // Where a variable's values come from, as tokens: `b:R#j` the values facts of R hold at j in the pod's world,
  // `d:R#j` those a derived R holds at j (resolved below to the base tokens and constants its rules read), `c:V` V.
  const tok = (rel: string, j: number) => `${rules.has(rel) ? 'd' : 'b'}:${rel}#${j}`;
  const constTok = (t: Term) => { const v = valueOf(t); return v === null ? null : `c:${v}`; };
  // A position is STORED when every value it takes is a value of some base fact or a constant of the program:
  // the greatest fixpoint, a position falling where a rule writes a computed value (`is`, a compound) there.
  const stored = new Map<string, boolean[]>();
  const isStored = (rel: string, j: number) => stored.get(rel)?.[j] ?? true;
  /** `=` binds a variable to what the other side is bound to. */
  const equate = (els: Elem[], bound: Map<string, Set<string>>) => {
    for (let more = true; more;) {
      more = false;
      for (const e of els) {
        if (e.t !== 'bi' || e.op !== '=') continue;
        for (const [x, y] of [[e.l, e.r], [e.r, e.l]] as const) {
          if (x.k !== 'v' || bound.has(x.name)) continue;
          const from = y.k === 'v' ? bound.get(y.name) : constTok(y) === null ? undefined : new Set([constTok(y)!]);
          if (from) { bound.set(x.name, new Set(from)); more = true; }
        }
      }
    }
  };
  /** The premises bind each variable at a stored position to that position; the first binding is kept. */
  const bindAll = (els: Elem[], bound = new Map<string, Set<string>>()) => {
    for (const e of els) if (e.t === 'pos') e.lit.args.forEach((a, j) => { if (a.k === 'v' && isStored(e.lit.rel, j) && !bound.has(a.name)) bound.set(a.name, new Set([tok(e.lit.rel, j)])); });
    equate(els, bound);
    return bound;
  };
  for (const [rel, rs] of rules) stored.set(rel, rs[0]!.head.args.map(() => true));
  for (let changed = true; changed;) {
    changed = false;
    for (const [rel, rs] of rules) {
      const st = stored.get(rel)!;
      for (const r of rs) {
        const sv = bindAll(r.body);
        r.head.args.forEach((a, j) => { if (st[j] && !(a.k === 'v' ? sv.has(a.name) : valueOf(a) !== null)) { st[j] = false; changed = true; } });
      }
    }
  }
  // What a derived relation holds at a stored position: what its rules' bodies bind there, and its own base facts.
  const derived = new Map<string, Set<string>>();
  for (const [rel, rs] of rules) {
    rs[0]!.head.args.forEach((_a, j) => {
      const from = new Set<string>([`b:${rel}#${j}`]);
      for (const r of rs) {
        const a = r.head.args[j]!;
        for (const t of a.k === 'v' ? bindAll(r.body).get(a.name) ?? [] : [constTok(a)].filter((x) => x !== null)) from.add(t);
      }
      derived.set(`${rel}#${j}`, from);
    });
  }
  // `x:id` the values a rule's builtins compute from those of a bound variable (a Calc, run forward): resolved to
  // the computed source `~id`, whose input is what that variable's tokens resolve to, and to the Calc's values of
  // the input's constants.
  const computed = new Map<string, { calc: Calc; tokens: Set<string> }>();
  const calcs = new Map<string, { calc: Calc; input: Set<string> }>();
  const resolve = (tokens: Iterable<string>): { sources: Set<string>; values: Set<string> } => {
    const sources = new Set<string>(), values = new Set<string>(), seen = new Set<string>();
    const go = (t: string) => {
      if (seen.has(t)) return;
      seen.add(t);
      if (t.startsWith('c:')) values.add(t.slice(2));
      else if (t.startsWith('b:')) sources.add(t.slice(2));
      else if (t.startsWith('x:')) {
        const id = t.slice(2), c = computed.get(id)!;
        sources.add(`~${id}`);
        if (!calcs.has(`~${id}`)) {
          calcs.set(`~${id}`, { calc: c.calc, input: new Set() });
          const input = resolve(c.tokens);
          calcs.set(`~${id}`, { calc: c.calc, input: input.sources });
          for (const v of input.values) for (const w of c.calc.fn(v)) values.add(w);
        } else for (const v of resolve(c.tokens).values) for (const w of c.calc.fn(v)) values.add(w);
      } else for (const u of derived.get(t.slice(2)) ?? []) go(u);
    };
    for (const t of tokens) go(t);
    return { sources, values };
  };
  // ANCHORED: every derivation of the relation reads a fact the core does not hold (a file's), so its values come
  // from the pod's own world; the greatest fixpoint.
  const anchor = new Map<string, boolean>([...rules.keys()].map((r) => [r, true]));
  const anchored = (rel: string) => anchor.get(rel) ?? !homeless.has(rel);
  for (let changed = true; changed;) {
    changed = false;
    for (const [rel, rs] of rules) {
      if (anchor.get(rel) && rs.some((r) => !r.body.some((e) => e.t === 'pos' && anchored(e.lit.rel)))) { anchor.set(rel, false); changed = true; }
    }
  }
  // RIGID: the program's own facts, every derivation reading only rigid premises (a table such as index_file): no
  // core fact is read through it, so it is read first, its constants keying the premises after it.
  const rigid = new Map<string, boolean>([...rules.keys()].map((r) => [r, true]));
  for (let changed = true; changed;) {
    changed = false;
    for (const [rel, rs] of rules) {
      if (rigid.get(rel) && rs.some((r) => r.body.some((e) => e.t !== 'bi' && (e.t !== 'pos' || !rigid.get(e.lit.rel))))) { rigid.set(rel, false); changed = true; }
    }
  }
  // Demand, from the escapes down: rel -> its keys ('' all of it), each position with the tokens its values come from.
  // Magic sets with each magic relation widened to the values its sources hold, one set per key position.
  type Alt = { at: number[]; calc: (Calc | undefined)[]; from: Set<string>[]; exists: boolean };
  const alts = new Map<string, Map<string, Alt>>();
  const todo: [string, string][] = [];
  const want = (rel: string, at: number[], from: Set<string>[], exists = false, calc: (Calc | undefined)[] = []) => {
    const a = alts.get(rel) ?? new Map<string, Alt>();
    alts.set(rel, a);
    const k = at.map((j, i) => (calc[i] ? `${j}~${calc[i]!.id}` : j)).join(',');
    const was = a.get(k);
    if (!was) { a.set(k, { at, calc, from: from.map((s) => new Set(s)), exists: exists && !calc.some(Boolean) }); todo.push([rel, k]); return; }
    was.exists &&= exists;
    let grew = false;
    from.forEach((s, i) => { for (const t of s) if (!was.from[i]!.has(t)) { was.from[i]!.add(t); grew = true; } });
    if (grew) todo.push([rel, k]);
  };
  const varsOf = (t: Term, into: Set<string>) => { if (t.k === 'v') into.add(t.name); if (t.k === 'f') t.args.forEach((a) => varsOf(a, into)); };
  /** A variable an `is` writes, its values computed forward from one bound variable's: bound to a computed token. */
  const compute = (els: Elem[], bound: Map<string, Set<string>>) => {
    const used = new Set<string>();
    for (const e of els) if (e.t === 'bi') { varsOf(e.l, used); varsOf(e.r, used); }
    for (let more = true; more;) {
      more = false;
      for (const e of els) {
        if (e.t !== 'bi' || e.op !== 'is' || e.l.k !== 'v' || bound.has(e.l.name)) continue;
        for (const v of used) {
          const c = bound.has(v) ? forward(els, e.l.name, v) : null;
          if (!c) continue;
          const x = computed.get(c.id) ?? { calc: c, tokens: new Set<string>() };
          computed.set(c.id, x);
          bound.get(v)!.forEach((t) => x.tokens.add(t));
          bound.set(e.l.name, new Set([`x:${c.id}`]));
          more = true;
          break;
        }
      }
    }
  };
  /** The variables written once in a rule: a premise's place it alone holds binds nothing. */
  const onceIn = (head: Lit, els: Elem[]) => {
    const n = new Map<string, number>();
    const count = (t: Term) => { if (t.k === 'v') n.set(t.name, (n.get(t.name) ?? 0) + 1); if (t.k === 'f') t.args.forEach(count); };
    const terms = (e: Elem): Term[] => (e.t === 'bi' ? [e.l, e.r] : e.t === 'agg' ? e.body.flatMap(terms) : e.lit.args);
    head.args.forEach(count);
    els.flatMap(terms).forEach(count);
    return new Set([...n].filter(([, c]) => c === 1).map(([v]) => v));
  };
  const body = (els: Elem[], bound: Map<string, Set<string>>, once: Set<string>) => {
    const left = els.filter((e): e is Elem & { t: 'pos' } => e.t === 'pos');
    const keyed = (l: Lit) => l.args.flatMap((a, j) => ((a.k === 'v' && bound.has(a.name)) || valueOf(a) !== null ? [j] : []));
    const fromOf = (l: Lit, at: number[]) => at.map((j) => { const a = l.args[j]!; return a.k === 'v' ? bound.get(a.name)! : new Set([constTok(a)!]); });
    const only = (l: Lit, at: number[]) => l.args.every((a, j) => at.includes(j) || (a.k === 'v' && once.has(a.name)));
    // Sideways, greedily: next a premise over an anchored relation, then one over a rigid one, then one something
    // already binds, then the one bound at most places; else the first written.
    const rank = (e: Elem & { t: 'pos' }) => { const k = keyed(e.lit).length; return (anchored(e.lit.rel) ? 4 : rigid.get(e.lit.rel) ? 3 : 0) + (k > 0 ? 2 : 0) + k / 100; };
    // The variables a builtin of this body writes: one bound already (by the head's demand) and absent from a
    // premise over base facts keys that premise at the place it is computed from.
    const written = new Set(els.flatMap((e) => (e.t === 'bi' && e.op === 'is' && e.l.k === 'v' ? [e.l.name] : [])));
    compute(els, bound);
    while (left.length) {
      let i = 0;
      for (let j = 1; j < left.length; j++) if (rank(left[j]!) > rank(left[i]!)) i = j;
      const e = left.splice(i, 1)[0]!;
      const at = keyed(e.lit), from = fromOf(e.lit, at), calc: (Calc | undefined)[] = at.map(() => undefined);
      if (!rules.has(e.lit.rel)) {
        const here = new Set<string>();
        e.lit.args.forEach((a) => varsOf(a, here));
        e.lit.args.forEach((a, j) => {
          if (a.k !== 'v' || bound.has(a.name) || at.includes(j)) return;
          for (const x of written) {
            const c = bound.has(x) && !here.has(x) ? forward(els, x, a.name) : null;
            if (!c) continue;
            at.push(j); from.push(bound.get(x)!); calc.push(c);
            return;
          }
        });
      }
      want(e.lit.rel, at, from, only(e.lit, at), calc);
      e.lit.args.forEach((a, j) => { if (a.k === 'v' && isStored(e.lit.rel, j) && !bound.has(a.name)) bound.set(a.name, new Set([tok(e.lit.rel, j)])); });
      equate(els, bound);
      compute(els, bound);
    }
    for (const e of els) {
      if (e.t === 'neg') { const at = keyed(e.lit); want(e.lit.rel, at, fromOf(e.lit, at), only(e.lit, at)); }
      if (e.t === 'agg') body(e.body, new Map(bound), once);
    }
  };
  for (const r of roots) want(r, [], []);
  while (todo.length) {
    const [rel, k] = todo.pop()!;
    const { at, from } = alts.get(rel)!.get(k)!;
    for (const r of rules.get(rel) ?? []) {
      const bound = new Map<string, Set<string>>();
      at.forEach((j, i) => { const h = r.head.args[j]; if (h?.k === 'v') bound.set(h.name, new Set(from[i])); });
      body(r.body, bound, onceIn(r.head, r.body));
    }
  }
  const keys = new Map<string, Key[]>();
  const sources = new Set<string>(), values = new Set<string>();
  const place = (k: Key) => k.at.map((j, i) => (k.calc?.[i] ? `${j}~${k.calc[i]!.id}` : String(j)));
  const covers = (o: Key, k: Key) => (!o.exists || k.exists) && o.at.length < k.at.length && place(o).every((p, i) => {
    const m = place(k).indexOf(p);
    return m >= 0 && [...k.from[m]!.sources].every((s) => o.from[i]!.sources.has(s)) && [...k.from[m]!.values].every((v) => o.from[i]!.values.has(v));
  });
  for (const rel of homeless) {
    const a = alts.get(rel);
    if (!a) continue;
    const ks: Key[] = [...a.values()].map(({ at, calc, from, exists }) => ({ at, from: from.map(resolve), exists, ...(calc.some(Boolean) ? { calc } : {}) }));
    // A key that another covers adds nothing: the smaller one already lays every fact the larger does.
    const kept = ks.filter((k) => !ks.some((o) => covers(o, k)));
    for (const k of kept) for (const f of k.from) { f.sources.forEach((s) => sources.add(s)); f.values.forEach((v) => values.add(v)); }
    keys.set(rel, kept);
  }
  // The computed sources a kept key reads, and their inputs down to the base sources, tracked as any source is.
  const calc = new Map<string, { calc: Calc; input: Set<string> }>();
  const need = [...sources].filter((s) => s.startsWith('~'));
  while (need.length) {
    const x = need.pop()!;
    if (calc.has(x)) continue;
    calc.set(x, calcs.get(x)!);
    for (const s of calcs.get(x)!.input) if (s.startsWith('~')) need.push(s); else sources.add(s);
  }
  for (const s of sources) if (s.startsWith('~')) sources.delete(s);
  return { keys, sources, values, calc };
}

const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', b: '\b', f: '\f' };
/** A fact's relation and its cells as values (valueOf), read off its text. */
export function cellsOf(line: string): { rel: string; cells: string[] } {
  const open = line.indexOf('(');
  const name = line.slice(0, open);
  const rel = name.includes('[') ? name.slice(0, name.indexOf('[')) : name;
  const cells: string[] = [];
  let i = open + 1;
  const fail = () => { throw new Error(`a fact the router cannot read: ${line.slice(0, 160)}`); };
  for (;;) {
    while (line[i] === ' ') i++;
    if (line[i] === ')') break;
    if (line[i] === '"') {
      let v = '';
      for (i++; line[i] !== '"'; i++) {
        if (i >= line.length) fail();
        if (line[i] === '\\') {
          const e = line[++i]!;
          if (e === 'u') { v += String.fromCharCode(parseInt(line.slice(i + 1, i + 5), 16)); i += 4; } else v += ESC[e] ?? fail();
        } else v += line[i];
      }
      i++;
      cells.push(`s${v}`);
    } else {
      const m = /^-?\d+|^[a-z][A-Za-z0-9_]*/.exec(line.slice(i, i + 200)) ?? fail();
      cells.push(/^-?\d/.test(m[0]) ? `i${BigInt(m[0])}` : `a${m[0]}`);
      i += m[0].length;
    }
    while (line[i] === ' ') i++;
    if (line[i] === ',') i++; else if (line[i] !== ')') fail();
  }
  return { rel, cells };
}

const NODE_CELL = /^an[0-9a-f]{16}_/;
/** The values a key compares at its i-th position for a fact's value there: the value, or what its Calc computes. */
const valuesAt = (k: Key, i: number, c: string): string[] => { const x = k.calc?.[i]; return x ? x.fn(c) : [c]; };
/** The values held, per group of sources (one key position's): a value held at any source of a group is the group's. */
type Held = { has: (c: string) => boolean }[];
/** Groups to a word of bits: a value's groups are one number in a map, not one entry in a set per group. */
const WORD = 30;

/** The corpus's core, routed: each pod is given the core facts its files reach by the program's keys (coreDemand),
 *  and a change of the core reaches only the pods whose share it moves. With no demand (null) every pod is given all. */
export class CoreRouter {
  private readonly d: Demand | null;
  private readonly facts = new Map<string, { rel: string; cells: string[] }>();
  /** a key position's group and a value there -> the core facts a key may hold once that value is held there. A
   *  position whose value is a constant of the key always holds and is not indexed: a constant every fact of the
   *  relation holds there (`str_seg(S, 0, _)`) would make each pod's route visit the whole corpus's relation. */
  private readonly at: (Map<string, Set<string>> | undefined)[] = [];
  /** the core facts a key holds by its constants alone: every pod considers them */
  private readonly free = new Set<string>();
  /** per pod: its files' values at each source (counted), the values held at each source, the core laid */
  private readonly pods = new Map<number, { values: Map<string, Map<string, number>>; held: Held; laid: Set<string>; dirty: boolean }>();

  /** a key position's sources as one group, and the groups each source is in */
  private readonly group = new Map<object, number>();
  private readonly groupsOf = new Map<string, number[]>();
  /** a computed source's input sources as one group -> the computed sources it feeds */
  private readonly feeds: ({ x: string; calc: Calc }[] | undefined)[] = [];

  constructor(d: Demand | null) {
    this.d = d;
    // A group is numbered: it indexes the values held and the core facts.
    const ids = new Map<string, number>();
    const id = (sources: Set<string>) => { const n = [...sources].sort().join(' '); if (!ids.has(n)) ids.set(n, ids.size); return ids.get(n)!; };
    for (const [x, { calc, input }] of d?.calc ?? []) {
      const g = id(input);
      (this.feeds[g] ??= []).push({ x, calc });
      for (const s of input) { const gs = this.groupsOf.get(s) ?? []; if (!gs.includes(g)) gs.push(g); this.groupsOf.set(s, gs); }
    }
    for (const k of [...d?.keys.values() ?? []].flat()) {
      for (const from of k.from) {
        const g = id(from.sources);
        this.group.set(from, g);
        for (const s of from.sources) { const gs = this.groupsOf.get(s) ?? []; if (!gs.includes(g)) gs.push(g); this.groupsOf.set(s, gs); }
      }
    }
    for (const gs of this.groupsOf.values()) gs.sort((a, b) => a - b);
    this.groups = ids.size;
  }
  private readonly groups: number;

  /** per relation, the groups each of its places' values are held in */
  private readonly placeGroups = new Map<string, (number[] | undefined)[]>();
  private groupsAt(rel: string, n: number): (number[] | undefined)[] {
    let gs = this.placeGroups.get(rel);
    if (!gs || gs.length < n) { gs = Array.from({ length: n }, (_, j) => this.groupsOf.get(`${rel}#${j}`)); this.placeGroups.set(rel, gs); }
    return gs;
  }
  /** Where a fact is indexed: per key, each position its constants do not hold, by the position's group and value;
   *  and whether some key holds it by its constants alone. */
  private entries(f: { rel: string; cells: string[] }): { at: [number, string][]; free: boolean } {
    const out: [number, string][] = [];
    let free = false;
    for (const k of this.keysOf(f.rel) ?? []) {
      let open = false;
      k.at.forEach((j, i) => {
        const from = k.from[i]!, vs = valuesAt(k, i, f.cells[j]!);
        if (vs.some((v) => from.values.has(v))) return;
        open = true;
        const g = this.group.get(from);
        for (const v of vs) out.push([g!, v]);
      });
      if (!open) free = true;
    }
    return { at: out, free };
  }
  private keysOf(rel: string): Key[] | undefined { return this.d ? this.d.keys.get(rel) : [{ at: [], from: [], exists: false }]; }
  /** A key holds a fact when at each of its positions the fact's value is a constant of it or held at one of its sources. */
  private holds(k: Key, f: { rel: string; cells: string[] }, held: Held): boolean {
    for (let i = 0; i < k.at.length; i++) {
      const from = k.from[i]!, h = held[this.group.get(from)!], x = k.calc?.[i], c = f.cells[k.at[i]!]!;
      if (!x) { if (!from.values.has(c) && h?.has(c) !== true) return false; continue; }
      if (!x.fn(c).some((v) => from.values.has(v) || h?.has(v) === true)) return false;
    }
    return true;
  }
  /** Some key holds the fact: the pod may lay it. */
  private passes(f: { rel: string; cells: string[] }, held: Held): boolean {
    return (this.keysOf(f.rel) ?? []).some((k) => this.holds(k, f, held));
  }

  /** The corpus's core changed: facts in and out. Pods whose share it may move are marked to be routed again. */
  core(added: Iterable<string>, removed: Iterable<string>): void {
    for (const l of removed) {
      const f = this.facts.get(l);
      if (!f) continue;
      this.facts.delete(l);
      this.free.delete(l);
      for (const [g, v] of this.entries(f).at) this.at[g]?.get(v)?.delete(l);
      for (const p of this.pods.values()) if (p.laid.has(l)) p.dirty = true;
    }
    for (const l of added) {
      if (this.facts.has(l)) continue;
      const f = cellsOf(l.replace(/\.$/, ''));
      this.facts.set(l, f);
      const e = this.entries(f);
      if (e.free) this.free.add(l);
      for (const [g, v] of e.at) {
        const byV = (this.at[g] ??= new Map<string, Set<string>>());
        const s = byV.get(v) ?? new Set<string>();
        s.add(l);
        byV.set(v, s);
      }
      for (const p of this.pods.values()) if (!p.dirty && this.passes(f, p.held)) p.dirty = true;
    }
  }

  /** A pod's file facts in and out: their values counted at each source the keys read. */
  files(pod: number, added: Iterable<string>, removed: Iterable<string>): void {
    const p = this.pods.get(pod) ?? { values: new Map(), held: [], laid: new Set<string>(), dirty: true };
    this.pods.set(pod, p);
    const count = (lines: Iterable<string>, d: 1 | -1) => {
      for (const l of lines) {
        const { rel, cells } = cellsOf(l.replace(/\.$/, ''));
        cells.forEach((c, j) => {
          const s = `${rel}#${j}`;
          if (NODE_CELL.test(c) || !this.d?.sources.has(s)) return;
          const at = p.values.get(s) ?? new Map<string, number>();
          p.values.set(s, at);
          const n = (at.get(c) ?? 0) + d;
          if (n === 0) at.delete(c); else at.set(c, n);
        });
      }
    };
    count(added, 1);
    count(removed, -1);
    p.dirty = true;
  }

  /** The pods whose share moved, each with its share now. */
  route(): Map<number, Set<string>> {
    const out = new Map<number, Set<string>>();
    for (const [id, p] of this.pods) {
      if (!p.dirty) continue;
      p.dirty = false;
      const laid = this.reach(p);
      if (laid.size !== p.laid.size || [...laid].some((l) => !p.laid.has(l))) out.set(id, laid);
      p.laid = laid;
    }
    return out;
  }

  /** A pod's share now. */
  share(pod: number): Set<string> { return this.pods.get(pod)?.laid ?? new Set(); }

  /** The fixpoint: a fact is laid when a key of its relation holds it (an existence key: when no fact laid holds its
   *  tuple yet, the least such fact), and its values are then held at its sources. */
  private reach(p: { values: Map<string, Map<string, number>>; held: Held }): Set<string> {
    const laid = new Set<string>();
    const words: Map<string, number>[] = [];
    const held: Held = Array.from({ length: this.groups }, (_, g) => {
      const w = (words[Math.floor(g / WORD)] ??= new Map()), b = 1 << g % WORD;
      return { has: (c: string) => ((w.get(c) ?? 0) & b) !== 0 };
    });
    const todo: Set<string>[] = [];
    const hold = (s: string, c: string) => holdIn(this.groupsOf.get(s), c);
    const holdIn = (groups: number[] | undefined, c: string) => {
      if (!groups) return;
      let fed: { x: string; calc: Calc }[] | undefined;
      let wi = -1, w: Map<string, number> | undefined, was = 0, now = 0;
      for (const g of groups) {
        const i = Math.floor(g / WORD), b = 1 << g % WORD;
        if (i !== wi) { if (now !== was) w!.set(c, now); wi = i; w = words[i]!; was = now = w.get(c) ?? 0; }
        if (now & b) continue;
        now |= b;
        const ls = this.at[g]?.get(c);
        if (ls) todo.push(ls);
        const f = this.feeds[g];
        if (f) fed = fed ? fed.concat(f) : f;
      }
      if (now !== was) w!.set(c, now);
      // A value new at a computed source's inputs: what its Calc computes of it is held there.
      for (const { x, calc } of fed ?? []) for (const v of calc.fn(c)) hold(x, v);
    };
    for (const [s, at] of p.values) { const gs = this.groupsOf.get(s); if (gs) for (const c of at.keys()) holdIn(gs, c); }
    /** the existence tuples a laid fact holds; the least fact for each wanted one no laid fact holds */
    const witness = new Set<string>(), wanting = new Map<string, string>();
    const tuple = (ki: number, k: Key, f: { rel: string; cells: string[] }) => `${f.rel}\0${ki}\0${k.at.map((j) => f.cells[j]).join('\0')}`;
    const consider = (l: string, f: { rel: string; cells: string[] }) => {
      if (laid.has(l)) return;
      const ks = this.keysOf(f.rel) ?? [];
      for (let ki = 0; ki < ks.length; ki++) {
        const k = ks[ki]!;
        if (!this.holds(k, f, held)) continue;
        if (!k.exists) { lay(l, f); return; }
        const t = tuple(ki, k, f);
        if (!witness.has(t) && !(wanting.get(t)! <= l)) wanting.set(t, l);
      }
    };
    const lay = (l: string, f: { rel: string; cells: string[] }) => {
      laid.add(l);
      (this.keysOf(f.rel) ?? []).forEach((k, ki) => { if (k.exists) witness.add(tuple(ki, k, f)); });
      const gs = this.groupsAt(f.rel, f.cells.length);
      for (let j = 0; j < f.cells.length; j++) holdIn(gs[j], f.cells[j]!);
    };
    for (const l of this.free) consider(l, this.facts.get(l)!);
    for (let more = true; more;) {
      while (todo.length) for (const l of todo.pop()!) consider(l, this.facts.get(l)!);
      more = false;
      for (const [t, l] of wanting) if (!witness.has(t) && !laid.has(l)) { lay(l, this.facts.get(l)!); more = true; }
      wanting.clear();
    }
    p.held = held;
    return laid;
  }
}

/** The files of a program: a `.files` list (one path a line, from its directory), or one file. */
function programFiles(p: string): string[] {
  if (!p.endsWith('.files')) return [p];
  return fs.readFileSync(p, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('--')).map((x) => path.resolve(path.dirname(p), x));
}

export interface PodOptions {
  /** The program every pod runs: a `.files` list or a `.rofl`. */
  program: string;
  escapes: Escape[];
  /** Publish facts as the pod's identity (one signed batch). */
  publish: (facts: Fact[]) => Promise<void>;
  bin?: string;
  /** At most this many facts a batch (a body is at most 16 MB). */
  batch?: number;
}

export interface Published { added: number; removed: number; facts: number; ms: { engine: number; publish: number };
  /** The pod's facts the edit took out and put in (0 at the start). */
  moved?: { out: number; in: number };
  /** How the engine took the edit: `delta` (the facts out and in, in one request by delta), `whole` (the engine
   *  refused the delta and evaluated the same world whole, its watch still told the difference), or `anew` (the
   *  engine refused the edit or lost the watch: the pod's world evaluated again from its files). */
  by: 'delta' | 'whole' | 'anew' }

type Net = Map<string, { rel: string; cells: string[]; d: number }>;

export class Pod {
  private readonly o: PodOptions;
  private readonly port: RoflPort;
  /** The program, loaded and never evaluated: each world of the pod is a fork of it. */
  private readonly base: RoflSession;
  private s!: RoflSession;
  private readonly files = new Map<string, Set<string>>();
  private core = new Set<string>();
  /** Row key → its relation, cells and how many books hold it. */
  private readonly rows = new Map<string, { rel: string; cells: string[]; n: number }>();
  /** What the engine said came and went, per session. */
  private readonly told = new Map<number, Change[]>();
  private readonly escapes: Map<string, Escape>;

  private constructor(o: PodOptions, port: RoflPort, base: RoflSession) {
    this.o = o; this.port = port; this.base = base;
    this.escapes = new Map(o.escapes.map((e) => [e.rel, e]));
    const send = port.send.bind(port);
    port.send = (req: Record<string, unknown>) => send(req).then((r: Record<string, unknown>) => {
      if (Array.isArray(r.changes)) this.told.get(req.session as number)?.push(...(r.changes as Change[]));
      return r;
    });
  }

  /** Evaluate the program over the core and the pod's files, and publish every escaping row. */
  static async start(o: PodOptions, core: Iterable<string>, files: Map<string, Iterable<string>>): Promise<{ pod: Pod; published: Published }> {
    const port = await RoflPort.start(o.bin ?? DEFAULT_ROFL_BIN);
    const base = await port.fresh(WALLS.budget, { space: WALLS.space });
    for (const f of programFiles(o.program)) await base.loadFile(f);
    const pod = new Pod(o, port, base);
    pod.core = new Set(core);
    for (const [f, facts] of files) pod.files.set(f, new Set(facts));
    const t0 = performance.now();
    pod.s = await pod.world();
    return { pod, published: await pod.publish(pod.net(pod.s), t0, 'anew') };
  }

  /** A world of the program over the core and the pod's files, evaluated; its escaping rows told as they came. */
  private async world(): Promise<RoflSession> {
    const w = await this.base.fork();
    this.told.set(w.id, []);
    // Watched before the facts come: base rows are told at the load, derived ones at the evaluation.
    await this.port.send({ op: 'watch', session: w.id, rels: this.o.escapes.map((e) => ({ rel: e.rel })) });
    let text = [...this.core].join('\n');
    for (const facts of this.files.values()) text += `\n${[...facts].join('\n')}`;
    await w.load(`${text}\n`);
    const ev = await w.evaluate();
    // A pod that stopped at a wall would publish part of its rows as if whole: it says so instead.
    if (ev.partial) throw new Error(`the pod's world stopped at a wall (${JSON.stringify(ev).slice(0, 200)}); its rows are not published`);
    return w;
  }

  /** One file's facts now (null: the file is gone; file '' with facts null: none), and the core as it is now.
   *  The engine takes the difference in one request by delta (`edit`); where it refuses the edit or loses the
   *  watch, the pod's world is evaluated anew from its files. Either way the pod publishes only the escaping rows that came and went. */
  async edit(file: string, facts: Iterable<string> | null, core?: Iterable<string>): Promise<Published> {
    const t0 = performance.now();
    const was = this.files.get(file) ?? new Set<string>();
    const now = new Set(facts ?? []);
    const coreNow = core ? new Set(core) : this.core;
    const out = [...was].filter((l) => !now.has(l)).concat([...this.core].filter((l) => !coreNow.has(l)));
    const add = [...now].filter((l) => !was.has(l)).concat([...coreNow].filter((l) => !this.core.has(l)));
    if (facts === null) this.files.delete(file); else this.files.set(file, now);
    this.core = coreNow;
    const r = await this.port.send({ op: 'edit', session: this.s.id, out: out.map((l) => l.replace(/\.$/, '')), rofl: add.length ? `${add.join('\n')}\n` : '' })
      .catch((e: unknown) => { if (e instanceof EngineRefusal) return { ok: false }; throw e; });
    const moved = { out: out.length, in: add.length };
    if (r.ok !== false && r.changes_by !== 'lost') return { ...await this.publish(this.net(this.s), t0, r.full == null ? 'delta' : 'whole'), moved };
    const w = await this.world();
    const net = this.net(w);
    // Anew, the new world told every row it holds: what the pod published and the new world lacks went.
    for (const [k, r] of this.rows) {
      const x = net.get(k) ?? { rel: r.rel, cells: r.cells, d: 0 };
      x.d -= r.n;
      net.set(k, x);
    }
    this.told.delete(this.s.id);
    await this.s.close();
    this.s = w;
    return { ...await this.publish(net, t0, 'anew'), moved };
  }

  /** The rows a world's engine said came and went since last asked, netted, of the escapes and their constants. */
  private net(w: RoflSession): Net {
    const net: Net = new Map();
    for (const c of this.told.get(w.id) ?? []) {
      const e = this.escapes.get(c.rel);
      if (!e) continue;
      for (const [rows, d] of [[c.added, 1], [c.removed, -1]] as const) {
        for (const args of rows) {
          const cells = args.map((t) => String(termCell(t)));
          if (!passes(e, cells)) continue;
          const k = JSON.stringify([c.rel, cells]);
          const x = net.get(k) ?? { rel: c.rel, cells, d: 0 };
          x.d += d;
          net.set(k, x);
        }
      }
    }
    this.told.set(w.id, []);
    return net;
  }

  /** Publish what moved, as one batch (or a few). */
  private async publish(net: Net, t0: number, by: Published['by']): Promise<Published> {
    const facts: Fact[] = [];
    let added = 0, removed = 0;
    for (const [k, x] of net) {
      if (x.d === 0) continue;
      const r = this.rows.get(k) ?? { rel: x.rel, cells: x.cells, n: 0 };
      const before = r.n;
      r.n += x.d;
      // A row in two books is one row on the wire: it comes with its first book and goes with its last.
      if (before === 0 && r.n > 0) { facts.push(...rowFacts(x.rel, x.cells, 1)); added++; }
      if (before > 0 && r.n === 0) { facts.push(...rowFacts(x.rel, x.cells, 0)); removed++; }
      if (r.n === 0) this.rows.delete(k); else this.rows.set(k, r);
    }
    const t1 = performance.now();
    const size = this.o.batch ?? 20_000;
    for (let i = 0; i < facts.length; i += size) await this.o.publish(facts.slice(i, i + size));
    return { added, removed, facts: facts.length, ms: { engine: t1 - t0, publish: performance.now() - t1 }, by };
  }

  /** The escaping rows the pod has published and not retired. */
  get published(): number { return this.rows.size; }
  /** The engine process, for its memory. */
  get pid(): number | undefined { return (this.port as unknown as { child: { pid?: number } }).child.pid; }
  /** Explain a row in the pod's own world: the proof below the batch the coordinator stops at. */
  why(query: string): Promise<string> { return this.s.why(query); }
  async close(): Promise<void> { await this.port.stop(); }
}
