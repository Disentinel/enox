// The engine: `rofl serve` through the RoflPort of @grafema/rofl. Everything here is
// DERIVED — rebuilt from the log by replay, and only that way.
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineRefusal, RoflPort, type RoflSession } from '@grafema/rofl/port';
import { decodeCell, NOT_BY_WILDCARD, Refusal, roflString } from './facts.ts';

/** The engine's record of which log batches it holds. */
export const SYSTEM_BOOK = 'sys_roflenox';
const SYSTEM_WHO = 'roflenox';

/** The `rofl` command of the installed package: it runs this platform's engine, held to the package's version. */
export const DEFAULT_ROFL_BIN = process.env.ROFL_BIN
  ?? path.join(path.dirname(fileURLToPath(import.meta.resolve('@grafema/rofl/package.json'))), 'npm/rofl.js');

// One literal in positional form: `rel(args)` or `rel[book](args)`.
const LITERAL = /^\s*([a-z][A-Za-z0-9_]*)\s*(?:\[([^\]]*)\])?\s*\(([\s\S]*)\)\s*$/;

/** What a reader may see of one book: all of it (`only` null), or only the
 *  facts whose ids are in `only` — and then only through fact-keyed relations. */
export interface BookScope { identity: string; only: Set<string> | null }
const FACT_KEYED = new Set(['edge', 'edge_num']);

// conf(F, C), persp(F, P), an edge question restricted to a perspective, and
// answered(K, E, V) are answered by the NODE (src/assertions.ts; rule worlds),
// not by rules in this world.

/** The system rules for one book: its owner reads it, a live grant lets its
 *  recipient read it, an export rule lets a fact of it leave to an audience.
 *  Written by the node into sys_roflenox, reading only the book they name. */
/** "Forever", in the same unit as grant expiries (Unix seconds): 2100-01-01. */
export const FOREVER = 4102444800;

export function bookRules(book: string, owner: string): string {
  const b = roflString(book);
  return [
    // (superseded/current/view — the current assertion of a fact — moved out
    // of the rules into admission: src/assertions.ts, r_batch_write.)
    // A follow (r_follow) is a fact of the follower's: {source: <publisher>,
    // relation: "roflenox:follow", target: <where its feed is>}. It is an
    // intent addressed to the follower itself — its own executor keeps the
    // mirror current; there is no second scheduler.
    `intent[${book}](P, ${roflString(owner)}, "follow", U) :- edge[${book}](F, P, "roflenox:follow", U).`,
    // A search by meaning (r_semantic_search) is a fact of the asker's too:
    // an intent to whichever embedder its book names. The embedder answers in
    // its own book; the node never embeds anything.
    `intent[${book}](K, E, "search", Q) :- edge[${book}](F, K, "roflenox:search", Q), edge[${book}](G, E, "roflenox:embedder", "search").`,
    // Who may read this book, and until when (r_grants); who acts for its
    // owner, and until when (r_agents_as_identities). The expiry is a COLUMN,
    // compared with the node's clock when a decision is made (src/expiry.ts):
    // a clock fact in this world would re-derive everything on every tick —
    // a WORKAROUND for a non-incremental engine; with an incremental evaluate
    // the clock premise (T < U) comes back into these rules.
    `readable_until[${SYSTEM_BOOK}](${roflString(owner)}, ${b}, ${FOREVER}).`,
    `readable_until[${SYSTEM_BOOK}](R, ${b}, U) :- grant[${book}](R, U).`,
    `delegated_until[${SYSTEM_BOOK}](A, ${roflString(owner)}, U) :- delegate[${book}](A, U).`,
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}](Rel, A).`,
    // A wildcard never covers the node's own relations (a search asked, a rule,
    // a grant…): only an export naming one does (r_semantic_search leak).
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}]("*", A), not reserved[${SYSTEM_BOOK}](Rel).`,
    ...NOT_BY_WILDCARD.map((r) => `reserved[${SYSTEM_BOOK}](${roflString(r)}).`),
    '',
  ].join('\n');
}

export interface AskRow { identity: string; cells: (string | number)[];
  /** The admission number of the batch that made the row true (r_admission_order), when asked for. */ admission?: number | null }
/** `unknown`: books whose authors' rules ran out of their budget — their
 *  rows are what was derived before the wall, not the whole answer. */
/** Why part of an answer is unknown: a rule world that ran out of its budget
 *  (budget, unit), or a feed the answer reads that has gone silent (window,
 *  last_report) — never an empty answer that reads like an all-clear. */
export interface Unknown { identity: string; reason: string; budget?: number; unit?: string; window?: number; last_report?: string | null; proof?: unknown[] }
export interface AskAnswer { vars: string[]; rows: AskRow[]; unknown?: Unknown[]; /** Why there are no rows, when the cause is in the question (src/empty.ts). */ note?: string;
  /** The log head the answer is of (r_ask_at_revision). */ head?: string;
  /** When the asker asked for a window: how many rows the whole answer has,
   *  and how many come after the window's start (r_heap_headroom). */
  window?: { total: number; after: number } }
export interface AskOptions { /** A log head: answer as the node would have when it was the latest. */ at?: string;
  /** A batch digest: answer only from the facts admitted after that batch (r_ask_since). */ since?: string;
  /** 'admission': each row carries the admission number of the batch that made it true, and rows come in that order (r_admission_order). */ order?: 'admission';
  /** At most `limit` rows, the first after the row key `after`, in the fixed
   *  order: the answer is never held whole (r_heap_headroom). */
  window?: { after?: string; limit: number } }

/** A row's place in the one fixed order. */
export const rowKey = (r: { identity: string; cells: unknown[] }) => JSON.stringify([r.identity, r.cells]);

/** Rows as they are found, kept in the fixed order: all of them — or, with a
 *  window, only the `limit` first after its start, while the rest are only
 *  counted (r_heap_headroom). */
export class Collect {
  private readonly buf: { k: string; r: AskRow }[] = [];
  private readonly all: AskRow[] = [];
  total = 0;
  after = 0;
  private readonly w?: { after?: string; limit: number };
  constructor(w?: { after?: string; limit: number }) { this.w = w; }
  push(r: AskRow): void {
    this.total++;
    if (!this.w) { this.all.push(r); return; }
    const k = rowKey(r);
    if (this.w.after !== undefined && k <= this.w.after) return;
    this.after++;
    const b = this.buf;
    if (b.length >= this.w.limit && k >= b[b.length - 1]!.k) return;
    let lo = 0, hi = b.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid]!.k < k) lo = mid + 1; else hi = mid; }
    b.splice(lo, 0, { k, r });
    if (b.length > this.w.limit) b.pop();
  }
  answer(vars: string[]): AskAnswer {
    if (!this.w) return { vars, rows: sortRows(this.all) };
    return { vars, rows: this.buf.map((x) => x.r), window: { total: this.total, after: this.after } };
  }
}
export interface Explanation { identity: string; holds: boolean; text: string; unknown?: { reason: string; budget: number; unit: string } }

export class Engine {
  private port: RoflPort;
  private session: RoflSession;
  private constructor(port: RoflPort, session: RoflSession) {
    this.port = port;
    this.session = session;
  }

  static async fresh(bin = DEFAULT_ROFL_BIN): Promise<Engine> {
    const port = await RoflPort.start(bin);
    // A write to a dead engine is reported by the port's write callback (and
    // the port fails every outstanding request); the pipe's own 'error' event
    // must not also crash this process. The package's port does not listen for
    // it, so the engine wrapper does.
    (port as unknown as { child: { stdin: NodeJS.WritableStream } }).child.stdin.on('error', () => {});
    return new Engine(port, await port.fresh());
  }

  /** Load a program into a FORK of the world. Nothing is visible until
   *  `commit`; `abort` leaves the world exactly as it was. */
  /** True once the engine process has died (a crash, a kill). */
  get dead(): boolean {
    return (this.port as unknown as { dead: Error | null }).dead !== null;
  }

  /** The engine process id (tests kill it to prove the node survives) —
   *  undefined once it has died, so a stale id is never handed out (the OS
   *  may already have given it to another process). */
  pid(): number | undefined {
    if (this.dead) return undefined;
    const c = (this.port as unknown as { child: { pid?: number; exitCode: number | null; signalCode: string | null } }).child;
    return c.exitCode === null && c.signalCode === null ? c.pid : undefined;
  }

  /** ADMISSION INTO THE ENGINE, without a fork and without an evaluation
   *  (r_batch_write). The main world holds facts and system rules only — no
   *  author's rules — and a load is atomic (a refused program leaves the world
   *  as it was), so there is nothing a fork would protect. The world is left
   *  as an evaluated world takes a load: by delta, or DIRTY when the engine
   *  says it cannot (`full`), and then the next read settles it once (ensure).
   *  `abort` cannot unload: it marks the engine stale, and the node rebuilds
   *  it from the log before the next operation. */
  async stage(rofl: string, who: string, rules: string | null = null,
    beforeLoad: () => void = () => {}): Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }> {
    try {
      if (rules) await this.load(rules, SYSTEM_WHO);
      beforeLoad();
      await this.load(rofl, who);
    } catch (e) {
      if (this.dead) throw this.down(e as Error);
      throw new Refusal(422, 'engine_refused', `the engine refused the batch: ${(e as Error).message}`);
    }
    return { commit: async () => {}, abort: async () => { this.stale = true; } };
  }

  /** Set when the world holds something the log does not (an aborted admission). */
  stale = false;

  /** Set while the world holds something no evaluation has settled. */
  private dirty = true;

  private async load(rofl: string, who: string): Promise<void> {
    const r = await this.port.send({ op: 'load', session: this.session.id, rofl, who });
    if (r.full !== null) this.dirty = true;
  }

  /** Settle a dirty world before reading it: a no-op if nothing changed. */
  async ensure(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.session.evaluate();
    } catch (e) {
      if (this.dead || !(e instanceof EngineRefusal)) throw e;
      throw new Refusal(422, 'engine_refused', `the world does not stratify: ${e.message}`);
    }
    this.dirty = false;
  }




  /** Ask one literal over the books in `scope`. A literal without a book is
   *  asked of every book in scope and each row names its identity; a literal
   *  naming a book must name one in scope (the caller refuses otherwise, with
   *  the engine's whynot). A book seen only through exports answers only its
   *  exported facts, and only through fact-keyed relations. */
  /** REPLAY: load already-verified batches straight into the world, in log
   *  order, and evaluate once at the end. No fork per batch — the log was
   *  verified before this runs, and a replay that fails refuses the start. */
  async replay(entries: Iterable<{ rofl: string; who: string; rules: string | null }>): Promise<void> {
    for (const e of entries) {
      if (e.rules) await this.session.load(e.rules, SYSTEM_WHO);
      await this.session.load(e.rofl, e.who);
    }
    await this.session.evaluate();
    this.dirty = false;
  }



  /** Retract base rows (ground literals without the full stop). */
  async retract(rows: string[]): Promise<void> {
    for (const q of rows) {
      const r = await this.port.send({ op: 'retract', session: this.session.id, query: q });
      if (r.full !== null) this.dirty = true;
    }
  }

  /** The whynot of `query` in a small, fresh world holding only `rofl` —
   *  explanations of time-judged decisions (src/expiry.ts). */
  async explainAlone(rofl: string, query: string): Promise<string> {
    const w = await this.port.fresh(1_000_000);
    try {
      await w.load(rofl, SYSTEM_WHO);
      await w.evaluate();
      const r = await this.port.send({ op: 'whynot', session: w.id, query });
      return r.text as string;
    } finally {
      await w.close();
    }
  }

  /** A fresh world with `budget` steps per evaluation (rule worlds). */
  async world(budget: number): Promise<World> {
    return new World(this.port, await this.port.fresh(budget));
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

  /** Rows of a system question, decoded. */
  async sysRows(query: string): Promise<(string | number)[][]> {
    await this.ensure();
    return (await this.session.ask(query)).rows.map((r) => r.map(decodeCell));
  }

  /** The engine's own explanation of why a system fact does not hold. */
  async sysWhynot(query: string): Promise<string> {
    await this.ensure();
    const r = await this.port.send({ op: 'whynot', session: this.session.id, query });
    return r.text as string;
  }

  async ask(query: string, scope: Map<string, BookScope>, perspective: string | null = null): Promise<AskAnswer> {
    await this.ensure();
    void perspective;
    const { rel, book, args } = parseLiteral(query);
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
    sortRows(rows);
    return { vars, rows };
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
    await this.ensure();
    const { rel, book, args } = parseLiteral(query);
    const out: Explanation[] = [];
    for (const [b, sc] of targets(book, scope)) {
      if (sc.only !== null) continue;
      const q = `${rel}[${b}](${args})`;
      out.push({ identity: sc.identity, ...await explainOne(this.port, this.session.id, op, q) });
    }
    return out;
  }

  private down(e: Error): Refusal {
    return new Refusal(503, 'engine_down',
      `the engine stopped during this admission (${e.message.split('\n')[0]}); the batch was NOT admitted and the log is unchanged — the engine is rebuilt from the log; send it again`);
  }

  async stop(): Promise<void> {
    if (this.dead) return;
    await this.port.stop();
  }
}

/** An engine error on a question is the question's fault (400) — the engine
 *  reports a malformed literal as an error answer, not a crash. */
/** `why` refuses a fact that does not hold, with the reference's text; a
 *  query it cannot read is refused too, and whynot tells the two apart. */
async function explainOne(port: RoflPort, session: number, op: 'why' | 'whynot', query: string): Promise<{ holds: boolean; text: string }> {
  const whynot = () => engineCall(() => port.send({ op: 'whynot', session, query }));
  if (op === 'whynot') {
    const r = await whynot();
    return { holds: r.holds as boolean, text: r.text as string };
  }
  try {
    const r = await port.send({ op: 'why', session, query });
    return { holds: true, text: r.text as string };
  } catch (e) {
    if (!(e instanceof EngineRefusal)) throw e;
    const r = await whynot();
    return { holds: r.holds as boolean, text: e.message };
  }
}

async function engineCall<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    // The engine's own wording names its parser's internals; the asker gets
    // what to change (r_query_errors).
    void e;
    throw new Refusal(400, 'bad_query', `not a literal this node can read: ${ONE_LITERAL}; check its quotes and parentheses`);
  }
}

function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Rows in their one fixed order — by [identity, cells] as JSON — each key
 *  made once (in the comparator it was made 2 log n times a row: seconds at
 *  200 000 rows). In place. */
export function sortRows<T extends { identity: string; cells: unknown[] }>(rows: T[]): T[] {
  const keyed = rows.map((r) => ({ k: JSON.stringify([r.identity, r.cells]), r }));
  keyed.sort((x, y) => cmp(x.k, y.k));
  keyed.forEach((x, i) => { rows[i] = x.r; });
  return rows;
}

/** Split a literal's arguments at top-level commas (strings may hold commas). */
export function splitArgs(args: string): string[] {
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

/** What a question is, said the same way by every refusal of one that is not. */
export const ONE_LITERAL = 'a question is one literal, rel(Args) or rel[book](Args), or a conjunction of them, a, b, not c (r_conjunction): each literal well formed, with its quotes and parentheses closed';

/** One literal of a question: negated or not. */
export interface QueryLiteral { neg: boolean; text: string; rel: string; book: string | null; args: string }

/** A question as literals (r_conjunction): split at the top-level commas,
 *  each one a literal, `not` before a negated one. A piece that is no
 *  literal refuses the whole question in one wording, never the engine's. */
export function parseQuery(q: string): QueryLiteral[] {
  if (typeof q !== 'string') throw new Refusal(400, 'bad_query', 'a query is a string');
  const pieces: string[] = [];
  let cur = '', depth = 0, inStr = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    if (inStr) { cur += c; if (c === '\\') { cur += q[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && --depth < 0) throw new Refusal(400, 'bad_query', ONE_LITERAL);
    if (c === ',' && depth === 0) { pieces.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (inStr || depth !== 0) throw new Refusal(400, 'bad_query', ONE_LITERAL);
  pieces.push(cur);
  return pieces.map((p) => {
    const m = /^\s*(not\s+|\\\+\s*)?([\s\S]*)$/.exec(p)!;
    const text = m[2]!.trim();
    if (text === '') throw new Refusal(400, 'bad_query', ONE_LITERAL);
    return { neg: m[1] !== undefined, text, ...parseLiteral(text) };
  });
}

export function parseLiteral(q: string): { rel: string; book: string | null; args: string } {
  if (typeof q !== 'string') throw new Refusal(400, 'bad_query', 'a query is a string');
  const m = LITERAL.exec(q);
  // `rel(...)` matches from the first ( to the last ): a conjunction closes
  // the first literal's parenthesis before its end (r_query_errors).
  if (!m || !balanced(m[3]!)) throw new Refusal(400, 'bad_query', ONE_LITERAL);
  return { rel: m[1]!, book: m[2]?.trim() || null, args: m[3]! };
}

/** Do an argument list's parentheses stay open-then-closed outside strings? */
function balanced(args: string): boolean {
  let depth = 0, inStr = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false;
  }
  return depth === 0 && !inStr;
}

function targets(book: string | null, scope: Map<string, BookScope>): [string, BookScope][] {
  const all = [...scope.entries()].sort((a, b) => cmp(a[0], b[0]));
  if (book === null) return all;
  if (!scope.has(book)) throw new Refusal(404, 'unknown_book', `no visible book ${book}`);
  return [[book, scope.get(book)!]];
}

/** The intent loop (r_intent_loop), loaded in an author's RULE WORLD (see
 *  node.ts): a rule in a book derives intent[book](Key, Executor, Kind, Input)
 *  addressed to an executor by NAME; the executor publishes, in its own book,
 *  {source: Key, relation: "roflenox:result", target: Value}. A result counts
 *  as the executor's only from the executor's own book (the name is bound to
 *  the book), and `answered` joins the two, so why of an answer walks from the
 *  result back through the rule that asked. */
export function resultRule(book: string, owner: string): string {
  return `result_of[${SYSTEM_BOOK}](K, ${roflString(owner)}, V) :- edge[${book}](F, K, "roflenox:result", V).\n`;
}
export function answeredRule(book: string): string {
  return `answered[${SYSTEM_BOOK}](${roflString(book)}, K, E, V) :- intent[${book}](K, E, Kind, In), result_of[${SYSTEM_BOOK}](K, E, V).\n`;
}
/** The grant rule for one book, alone (a rule world needs no other system rule). */
export function mayReadRules(book: string, owner: string): string {
  const b = roflString(book);
  return `may_read[${SYSTEM_BOOK}](${roflString(owner)}, ${b}).\n`
    + `may_read[${SYSTEM_BOOK}](R, ${b}) :- grant[${book}](R, U), clock[${SYSTEM_BOOK}](T), T < U.\n`
    // The same, keyed by the book ATOM: what a book variable in a rule binds to.
    + `may_read_book[${SYSTEM_BOOK}](R, ${book}) :- may_read[${SYSTEM_BOOK}](R, ${b}).\n`;
}

/** A separate world with its own step budget: an author's rules run here and
 *  nowhere else, so a rule that does not terminate costs only its author's
 *  answers (r_rule_budget). */
export class World {
  readonly session: RoflSession;
  private readonly port: RoflPort;
  partial = false;
  holes: string[] = [];
  constructor(port: RoflPort, session: RoflSession) { this.port = port; this.session = session; }
  async evaluate(): Promise<void> {
    const e = await this.session.evaluate();
    this.partial = e.partial;
    this.holes = this.partial ? (await this.session.ask('hole(W, Why)')).rows.map((r) => `${decodeCell(r[1]!)} at ${r[0]}`) : [];
  }
  async ask(q: string) { return engineCall(() => this.session.ask(q)); }
  async setClock(sec: number): Promise<void> {
    const a = await this.session.ask(`clock[${SYSTEM_BOOK}](T)`);
    if (a.rows.length === 1 && Number(a.rows[0]![0]) === sec) return;
    for (const r of a.rows) await this.port.send({ op: 'retract', session: this.session.id, query: `clock[${SYSTEM_BOOK}](${r[0]})` });
    await this.session.assert(`clock[${SYSTEM_BOOK}](${sec}).`);
    await this.evaluate();
  }
  async explain(op: 'why' | 'whynot', q: string): Promise<{ holds: boolean; text: string }> {
    return explainOne(this.port, this.session.id, op, q);
  }
  close() { return this.session.close(); }
}
