// The engine: rofl-serve through the vendored RoflPort. Everything here is
// DERIVED — rebuilt from the log by replay, and only that way.
import * as os from 'node:os';
import * as path from 'node:path';
import { RoflPort, type RoflSession } from '../vendor/rofl-port.ts';
import { decodeCell, Refusal, roflString } from './facts.ts';

/** The engine's record of which log batches it holds. */
export const SYSTEM_BOOK = 'sys_roflenox';
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
const VIEWS: Record<string, { rel: string; arity: number; place: (a: string[]) => string[]; whole?: true }> = {
  conf: { rel: 'current', arity: 2, place: (a) => [a[0]!, 'RoflenoxP', a[1]!] },
  // answered(Key, Executor, Value): an intent of this book with its result.
  // Not fact-keyed, so only a reader of the WHOLE book sees it.
  answered: { rel: 'answered', arity: 3, place: (a) => a, whole: true },
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
    // A follow (r_follow) is a fact of the follower's: {source: <publisher>,
    // relation: "roflenox:follow", target: <where its feed is>}. It is an
    // intent addressed to the follower itself — its own executor keeps the
    // mirror current; there is no second scheduler.
    `intent[${book}](P, ${roflString(owner)}, "follow", U) :- edge[${book}](F, P, "roflenox:follow", U).`,
    `may_read[${SYSTEM_BOOK}](${roflString(owner)}, ${b}).`,
    // Agents (r_agents_as_identities): an identity whose document names a
    // parent acts only while the parent's live delegation says so.
    `delegated[${SYSTEM_BOOK}](A, ${roflString(owner)}) :- delegate[${book}](A, U), clock[${SYSTEM_BOOK}](T), T < U.`,
    `may_read[${SYSTEM_BOOK}](R, ${b}) :- grant[${book}](R, U), clock[${SYSTEM_BOOK}](T), T < U.`,
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}](Rel, A).`,
    `exported[${SYSTEM_BOOK}](${b}, F, A) :- edge[${book}](F, S, Rel, T), export[${book}]("*", A).`,
    '',
  ].join('\n');
}

export interface AskRow { identity: string; cells: (string | number)[] }
/** `unknown`: books whose authors' rules ran out of their budget — their
 *  rows are what was derived before the wall, not the whole answer. */
export interface AskAnswer { vars: string[]; rows: AskRow[]; unknown?: { identity: string; reason: string; budget: number; unit: string }[] }
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
    // must not also crash this process. The vendored port does not listen for
    // it, so the engine wrapper does.
    (port as unknown as { child: { stdin: NodeJS.WritableStream } }).child.stdin.on('error', () => {});
    return new Engine(port, await port.fresh());
  }

  /** Load a program into a FORK of the world. Nothing is visible until
   *  `commit`; `abort` leaves the world exactly as it was. */
  /** True once the rofl-serve process has died (a crash, a kill). */
  get dead(): boolean {
    return (this.port as unknown as { dead: Error | null }).dead !== null;
  }

  /** The engine process id (tests kill it to prove the node survives). */
  pid(): number | undefined {
    return (this.port as unknown as { child: { pid?: number } }).child.pid;
  }

  async stage(rofl: string, who: string, rules: string | null = null,
    beforeEvaluate: () => void = () => {}): Promise<{ commit: () => Promise<void>; abort: () => Promise<void> }> {
    const work = await this.session.fork().catch((e: Error) => { throw this.down(e); });
    try {
      if (rules) await work.load(rules, SYSTEM_WHO);
      await work.load(rofl, who);
      beforeEvaluate();
      await work.evaluate();
    } catch (e) {
      if (this.dead) throw this.down(e as Error);
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



  /** Ask one literal over the books in `scope`. A literal without a book is
   *  asked of every book in scope and each row names its identity; a literal
   *  naming a book must name one in scope (the caller refuses otherwise, with
   *  the engine's whynot). A book seen only through exports answers only its
   *  exported facts, and only through fact-keyed relations. */
  /** REPLAY: load already-verified batches straight into the world, in log
   *  order, and evaluate once at the end. No fork per batch — the log was
   *  verified before this runs, and a replay that fails refuses the start. */
  async replay(entries: { rofl: string; who: string; rules: string | null }[]): Promise<void> {
    for (const e of entries) {
      if (e.rules) await this.session.load(e.rules, SYSTEM_WHO);
      await this.session.load(e.rofl, e.who);
    }
    await this.session.evaluate();
  }

  /** Set the engine's clock (whole seconds) that grant expiry is judged on. */
  async setClock(sec: number): Promise<void> {
    const a = await this.session.ask(`clock[${SYSTEM_BOOK}](T)`);
    if (a.rows.length === 1 && Number(a.rows[0]![0]) === sec) return;
    for (const r of a.rows) await this.port.send({ op: 'retract', session: this.session.id, query: `clock[${SYSTEM_BOOK}](${r[0]})` });
    await this.session.assert(`clock[${SYSTEM_BOOK}](${sec}).`);
    await this.session.evaluate();
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
    return (await this.session.ask(query)).rows.map((r) => r.map(decodeCell));
  }

  /** The engine's own explanation of why a system fact does not hold. */
  async sysWhynot(query: string): Promise<string> {
    const r = await this.port.send({ op: 'whynot', session: this.session.id, query });
    return r.text as string;
  }

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
      if (perspective === null && VIEWS[rel]!.whole && sc.only !== null) continue;
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
    // A view explains through its sys relation, the book a constant: why of an
    // answer walks from the executor's result back to the rule that asked.
    const v = VIEWS[rel];
    const a = splitArgs(args);
    if (v && (a.length !== v.arity || v.place(a).some((x) => x.startsWith('Roflenox')))) {
      throw new Refusal(400, 'bad_query', `why/whynot of ${rel} takes ${v.arity} ground arguments`);
    }
    for (const [b, sc] of targets(book, scope)) {
      if (sc.only !== null) continue;
      const q = v ? `${v.rel}[${SYSTEM_BOOK}](${[roflString(b), ...v.place(a)].join(', ')})` : `${rel}[${b}](${args})`;
      const r = await engineCall(() => this.port.send({ op, session: this.session.id, query: q }));
      out.push({ identity: sc.identity, holds: (op === 'why' ? r.okay : r.holds) as boolean, text: r.text as string });
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
    + `may_read[${SYSTEM_BOOK}](R, ${b}) :- grant[${book}](R, U), clock[${SYSTEM_BOOK}](T), T < U.\n`;
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
    const r = await engineCall(() => this.port.send({ op, session: this.session.id, query: q }));
    return { holds: (op === 'why' ? r.okay : r.holds) as boolean, text: r.text as string };
  }
  close() { return this.session.close(); }
}
