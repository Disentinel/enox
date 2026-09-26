// The engine: rofl-serve through the vendored RoflPort. Everything here is
// DERIVED — rebuilt from the log, or opened from a snapshot that names the log
// head it was taken at (r_snapshot_is_cache).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RoflPort, type RoflSession } from '../vendor/rofl-port.ts';
import { decodeCell, Refusal, roflString, sha256hex } from './facts.ts';

/** The engine's record of which log batches it holds. */
export const SYSTEM_BOOK = 'sys_roflenox';
const LOADED = 'loaded_batch';
const SYSTEM_WHO = 'roflenox';

export const DEFAULT_ROFL_BIN = process.env.ROFL_BIN
  ?? path.join(os.homedir(), 'rofl-rust/rust/target/release/rofl-serve');

// One literal in positional form: `rel(args)` or `rel[book](args)`.
const LITERAL = /^\s*([a-z][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*\(([\s\S]*)\)\s*$/;

/** What a reader may see of one book: all of it (`only` null), or only the
 *  facts whose ids are in `only` — and then only through fact-keyed relations. */
export interface BookScope { identity: string; only: Set<string> | null }
const FACT_KEYED = new Set(['edge']);

// Relations a question may name that are VIEWS in sys_roflenox, derived per
// book by bookRules: the current assertion of each fact, and the fact joined
// with it. They are asked with the book as their first column.
//   conf(F, C)    ← current[sys](Book, F, _, C)
//   persp(F, P)   ← current[sys](Book, F, P, _)
//   edge(F,S,R,T) with a perspective P ← view[sys](Book, F, S, R, T, P, _)
const VIEWS: Record<string, { rel: string; arity: number; place: (a: string[]) => string[] }> = {
  conf: { rel: 'current', arity: 2, place: (a) => [a[0]!, 'RoflenoxP', a[1]!] },
  persp: { rel: 'current', arity: 2, place: (a) => [a[0]!, a[1]!, 'RoflenoxC'] },
};

/** The system rules for one book: its owner reads it, a live grant lets its
 *  recipient read it, an export rule lets a fact of it leave to an audience.
 *  Written by the node into sys_roflenox, reading only the book they name. */
export function bookRules(book: string, owner: string): string {
  const b = roflString(book);
  return [
    // The current assertion of a fact by this identity: the one latest in its
    // chain (r_confidence) — a ROFL rule over the chain position, not a fix-up.
    `superseded[${SYSTEM_BOOK}](${b}, F, S1) :- asserted[${book}](F, P1, C1, S1), asserted[${book}](F, P2, C2, S2), S1 < S2.`,
    `current[${SYSTEM_BOOK}](${b}, F, P, C) :- asserted[${book}](F, P, C, S), not superseded[${SYSTEM_BOOK}](${b}, F, S).`,
    // The fact joined with its current perspective and confidence (r_perspective).
    `view[${SYSTEM_BOOK}](${b}, F, S, R, T, P, C) :- edge[${book}](F, S, R, T), current[${SYSTEM_BOOK}](${b}, F, P, C).`,
    // Executor intents (r_executors_off_read_path): a fact needs an embedding
    // until SOME book holds one for it; an executor's results are ordinary
    // facts of relation "roflenox:embedding" in the executor's own book.
    `has_embedding[${SYSTEM_BOOK}](F) :- edge[${book}](E, F, "roflenox:embedding", V).`,
    `needs_embedding[${SYSTEM_BOOK}](${b}, F, S) :- edge[${book}](F, S, R, T), R != "roflenox:embedding", not has_embedding[${SYSTEM_BOOK}](F).`,
    `may_read[${SYSTEM_BOOK}](${roflString(owner)}, ${b}).`,
    `may_read[${SYSTEM_BOOK}](R, ${b}) :- grant[${book}](R, U), clock[${SYSTEM_BOOK}](T), T < U.`,
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}](Rel, A).`,
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}]("*", A).`,
    '',
  ].join('\n');
}

export interface AskRow { identity: string; cells: (string | number)[] }
export interface AskAnswer { vars: string[]; rows: AskRow[] }
export interface Explanation { identity: string; holds: boolean; text: string }

export class Engine {
  private port: RoflPort;
  private session: RoflSession;
  /** 'replay' or 'snapshot': how the current world was built. */
  source: 'replay' | 'snapshot' = 'replay';

  private constructor(port: RoflPort, session: RoflSession) {
    this.port = port;
    this.session = session;
  }

  static async fresh(bin = DEFAULT_ROFL_BIN): Promise<Engine> {
    const port = await RoflPort.start(bin);
    return new Engine(port, await port.fresh());
  }

  /** Open from a snapshot seed. The caller has already checked it names the
   *  current log head. */
  static async fromSnapshot(seedPath: string, bin = DEFAULT_ROFL_BIN): Promise<Engine> {
    const port = await RoflPort.start(bin);
    const e = new Engine(port, await port.open({ seedPath }));
    e.source = 'snapshot';
    return e;
  }

  /** Load a program into a FORK of the world. Nothing is visible until
   *  `commit`; `abort` leaves the world exactly as it was. */
  async stage(rofl: string, who: string, batch: { identity: string; digest: string }, rules: string | null = null):
    Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }> {
    const work = await this.session.fork();
    try {
      if (rules) await work.load(rules, SYSTEM_WHO);
      await work.load(rofl, who);
      // What this world was built from, in a book no identity can write into
      // (toRofl only writes b_<16 hex> books). A snapshot is checked against it.
      await work.load(`${LOADED}[${SYSTEM_BOOK}](${roflString(batch.identity)}, ${roflString(batch.digest)}).\n`, SYSTEM_WHO);
      await work.evaluate();
    } catch (e) {
      await work.close();
      throw new Refusal(422, 'engine_refused', `the engine refused the batch: ${(e as Error).message}`);
    }
    return {
      commit: async () => {
        const old = this.session;
        this.session = work;
        await old.close();
      },
      abort: async () => { await work.close(); },
    };
  }

  /** The batches this world was built from, as `identity digest` keys. */
  async loadedBatches(): Promise<Set<string>> {
    const a = await this.session.ask(`${LOADED}[${SYSTEM_BOOK}](I, D)`);
    return new Set(a.rows.map((r) => `${decodeCell(r[0]!)} ${decodeCell(r[1]!)}`));
  }

  /** Set the engine's clock (whole seconds) that grant expiry is judged on. */
  async setClock(sec: number): Promise<void> {
    const a = await this.session.ask(`clock[${SYSTEM_BOOK}](T)`);
    if (a.rows.length === 1 && Number(a.rows[0]![0]) === sec) return;
    for (const r of a.rows) await this.port.send({ op: 'retract', session: this.session.id, query: `clock[${SYSTEM_BOOK}](${r[0]})` });
    await this.session.assert(`clock[${SYSTEM_BOOK}](${sec}).`);
    await this.session.evaluate();
  }

  /** Decide one question in a THROWAWAY fork: load `rofl` (facts and rules)
   *  there, evaluate, ask. Holds → no text; fails → the engine's whynot. The
   *  world itself is untouched. */
  async decide(rofl: string, query: string): Promise<{ holds: boolean; whynot: string }> {
    const work = await this.session.fork();
    try {
      await work.load(rofl, SYSTEM_WHO);
      await work.evaluate();
      if ((await work.ask(query)).rows.length > 0) return { holds: true, whynot: '' };
      const r = await this.port.send({ op: 'whynot', session: work.id, query });
      return { holds: false, whynot: r.text as string };
    } finally {
      await work.close();
    }
  }

  /** Rows of a system question, decoded. Public so the node can read intents. */
  async sysRows(query: string): Promise<(string | number)[][]> {
    return (await this.session.ask(query)).rows.map((r) => r.map(decodeCell));
  }

  /** The engine's own explanation of why a system fact does not hold. */
  async sysWhynot(query: string): Promise<string> {
    const r = await this.port.send({ op: 'whynot', session: this.session.id, query });
    return r.text as string;
  }

  async save(seedPath: string): Promise<void> {
    await this.port.send({ op: 'save', session: this.session.id, path: seedPath });
  }

  /** Ask one literal over the books in `scope`. A literal without a book is
   *  asked of every book in scope and each row names its identity; a literal
   *  naming a book must name one in scope (the caller refuses otherwise, with
   *  the engine's whynot). A book seen only through exports answers only its
   *  exported facts, and only through fact-keyed relations. */
  async ask(query: string, scope: Map<string, BookScope>, perspective: string | null = null): Promise<AskAnswer> {
    const { rel, book, args } = parseLiteral(query);
    const view = perspective !== null ? 'view' : VIEWS[rel] ? rel : null;
    if (view !== null) return this.askView(rel, book, args, scope, perspective);
    let vars: string[] = [];
    const rows: AskRow[] = [];
    for (const [b, sc] of targets(book, scope)) {
      if (sc.only !== null && !FACT_KEYED.has(rel)) continue;
      const a = await engineCall(() => this.session.ask(`${rel}[${b}](${args})`));
      vars = a.vars;
      for (const r of a.rows) {
        const cells = r.map(decodeCell);
        if (sc.only !== null && !sc.only.has(String(cells[0]))) continue;
        rows.push({ identity: sc.identity, cells });
      }
    }
    rows.sort((x, y) => cmp(JSON.stringify([x.identity, x.cells]), JSON.stringify([y.identity, y.cells])));
    return { vars, rows };
  }

  /** A question through a sys view: ONE ask over every book at once, the book
   *  a column, then kept to the reader's scope. Hidden helper variables
   *  (Roflenox*) are asked and dropped. */
  private async askView(rel: string, book: string | null, args: string, scope: Map<string, BookScope>, perspective: string | null): Promise<AskAnswer> {
    const a = splitArgs(args);
    let target: string;
    let placed: string[];
    if (perspective !== null) {
      if (rel !== 'edge' || a.length !== 4) throw new Refusal(400, 'bad_query', 'a perspective restricts edge(F, S, R, T) questions');
      target = 'view';
      placed = [...a, roflString(perspective), 'RoflenoxC'];
    } else {
      const v = VIEWS[rel]!;
      if (a.length !== v.arity) throw new Refusal(400, 'bad_query', `${rel} takes ${v.arity} arguments`);
      target = v.rel;
      placed = v.place(a);
    }
    if (placed[0] === '_') placed[0] = 'RoflenoxF';
    if (book !== null && !scope.has(book)) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
    const bookArg = book !== null ? roflString(book) : 'RoflenoxB';
    const ans = await engineCall(() => this.session.ask(`${target}[${SYSTEM_BOOK}](${[bookArg, ...placed].join(', ')})`));
    const keep = ans.vars.map((v, i) => [v, i] as const).filter(([v]) => !v.startsWith('Roflenox'));
    const bi = ans.vars.indexOf('RoflenoxB');
    const fi = ans.vars.indexOf(placed[0]!);
    const rows: AskRow[] = [];
    for (const r of ans.rows) {
      const cells = r.map(decodeCell);
      const b = bi >= 0 ? String(cells[bi]) : book!;
      const sc = scope.get(b);
      if (!sc) continue;
      const f = fi >= 0 ? String(cells[fi]) : String(decodeCell(placed[0]!));
      if (sc.only !== null && !sc.only.has(f)) continue;
      rows.push({ identity: sc.identity, cells: keep.map(([, i]) => cells[i]!) });
    }
    rows.sort((x, y) => cmp(JSON.stringify([x.identity, x.cells]), JSON.stringify([y.identity, y.cells])));
    return { vars: keep.map(([v]) => v), rows };
  }

  /** `why` for a ground literal, over the books the reader sees WHOLE only:
   *  an explanation walks premises, and premises are not all exported. */
  async why(query: string, scope: Map<string, BookScope>): Promise<Explanation[]> {
    return this.explain('why', query, scope);
  }

  async whynot(query: string, scope: Map<string, BookScope>): Promise<Explanation[]> {
    return this.explain('whynot', query, scope);
  }

  private async explain(op: 'why' | 'whynot', query: string, scope: Map<string, BookScope>): Promise<Explanation[]> {
    const { rel, book, args } = parseLiteral(query);
    const out: Explanation[] = [];
    for (const [b, sc] of targets(book, scope)) {
      if (sc.only !== null) continue;
      const r = await engineCall(() => this.port.send({ op, session: this.session.id, query: `${rel}[${b}](${args})` }));
      out.push({ identity: sc.identity, holds: (op === 'why' ? r.okay : r.holds) as boolean, text: r.text as string });
    }
    return out;
  }

  async stop(): Promise<void> {
    await this.port.stop();
  }
}

/** An engine error on a question is the question's fault (400) — the engine
 *  reports a malformed literal as an error answer, not a crash. */
async function engineCall<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    throw new Refusal(400, 'bad_query', `the engine could not answer: ${(e as Error).message}`);
  }
}

function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Split a literal's arguments at top-level commas (strings may hold commas). */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let cur = '', inStr = false, depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += args[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

export function parseLiteral(q: string): { rel: string; book: string | null; args: string } {
  if (typeof q !== 'string') throw new Refusal(400, 'bad_query', 'a query is a string');
  const m = LITERAL.exec(q);
  if (!m) throw new Refusal(400, 'bad_query', 'a query is one ROFL literal: rel(Args) or rel[book](Args)');
  return { rel: m[1]!, book: m[2]?.trim() || null, args: m[3]! };
}

function targets(book: string | null, scope: Map<string, BookScope>): [string, BookScope][] {
  const all = [...scope.entries()].sort((a, b) => cmp(a[0], b[0]));
  if (book === null) return all;
  if (!scope.has(book)) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
  return [[book, scope.get(book)!]];
}

/** A snapshot is a seed plus a sidecar naming the log head and the seed's own
 *  digest. Anything else found in cache/ is discarded. */
export interface SnapshotMeta { log_head: string; seed_sha256: string }

export function snapshotPaths(dataDir: string): { seed: string; meta: string } {
  const dir = path.join(dataDir, 'cache');
  return { seed: path.join(dir, 'snapshot.seed'), meta: path.join(dir, 'snapshot.json') };
}

/** The seed path if a usable snapshot for `logHead` exists, else null — and
 *  a snapshot that does not match is deleted, so it cannot be used later by
 *  mistake. */
export function usableSnapshot(dataDir: string, logHead: string): string | null {
  const p = snapshotPaths(dataDir);
  if (!fs.existsSync(p.meta) || !fs.existsSync(p.seed)) return null;
  let meta: SnapshotMeta | null = null;
  try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as SnapshotMeta; } catch { meta = null; }
  if (meta && meta.log_head === logHead && meta.seed_sha256 === sha256hex(fs.readFileSync(p.seed))) return p.seed;
  discardSnapshot(dataDir);
  return null;
}

export function discardSnapshot(dataDir: string): void {
  const p = snapshotPaths(dataDir);
  fs.rmSync(p.seed, { force: true });
  fs.rmSync(p.meta, { force: true });
}
