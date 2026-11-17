// SUBSCRIPTIONS (r_subscribe): a reader names one literal and is sent its
// whole answer once, then after every admission only the rows that came and
// went — taken from the engine's own delta (rofl serve `watch`), never by
// asking again.
//
// One engine watch serves every subscriber of a relation: the main world is
// watched per relation in every book, an author's rule world per relation in
// that author's book. A change is fanned out here, to each subscription whose
// literal it matches (its constants, its repeated variables) and whose reader
// may see the book — the same scope `ask` answers in. A subscription holds its
// literal and that scope, never the rows.
//
// A full frame is sent again, as `ask` answers it, whenever the rows cannot
// be carried over: at the start, when the reader's access changed (a grant,
// an export, a new book, a grant that expired), when the world it was watched
// in was rebuilt (the engine says `lost`, or the node built the rule world
// anew), and for the relations the node answers itself rather than the engine
// (live, conf, persp, asserted, admitted_at, answered: those are asked again
// after every admission and diffed — the one place a subscription keeps its
// answer's row keys).
import { match } from './assertions.ts';
import { parseLiteral, rowKey, sortRows, splitArgs, termCell, type AskAnswer, type AskRow, type BookScope, type Change } from './engine.ts';

/** What a subscriber is sent. `full`: the whole answer; `delta`: rows added
 *  and removed since the last frame; `refused`: the subscription ends. */
export interface Frame {
  kind: 'full' | 'delta' | 'refused';
  /** The log head the frame is of. */
  head: string | null;
  /** The batch whose admission moved these rows (a digest), or why a full
   *  frame was sent: `start`, `access`, `rebuilt`, `lost`, `clock`. */
  cause: string | null;
  vars?: string[];
  rows?: AskRow[];
  added?: AskRow[];
  removed?: AskRow[];
  /** How the engine took the change: delta, whole, diff — or reask, for a
   *  relation the node answers. A full frame of a world built anew says
   *  `whole`, and `why` names what made the node build it. */
  by?: string;
  why?: string;
  unknown?: AskAnswer['unknown'];
  error?: string;
  message?: string;
}
export type Sink = (f: Frame) => void;

/** What the hub needs of its node. Every call is made inside the node's serial slot. */
export interface Host {
  mainSession(): number;
  watch(session: number, rels: { rel: string; book?: string }[], on: boolean): Promise<void>;
  /** Settle the main world, if a load left it unevaluated. */
  settle(): Promise<void>;
  scope(requester: string | null): Promise<Map<string, BookScope>>;
  /** The earliest time (Unix seconds) a book the reader sees whole stops being readable. */
  expiry(requester: string | null): Promise<number | null>;
  ask(query: string, requester: string | null): Promise<AskAnswer>;
  /** The session of `author`'s rule world, kept current (built, or advanced by delta), or null if it has none. */
  world(author: string): Promise<number | null>;
  /** The rows of `rel[book](args)` in `author`'s rule world, each its cells as `ask` gives them; null if the world lacks the relation. */
  worldRows(author: string, rel: string, book: string, args: string[]): Promise<(string | number)[][] | null>;
  /** Why `author`'s rule world was last built whole, if it was. */
  rebuilt(author: string): string | null;
  head(): string;
  /** The node's clock, Unix seconds. */
  now(): number;
}

/** Relations the node answers from its own records, not from a world (node.askOrdered). */
const NODE_ANSWERED = new Set(['live', 'conf', 'persp', 'asserted', 'admitted_at', 'answered']);
const FACT_KEYED = new Set(['edge', 'edge_num']);
const isVar = (x: string) => /^[A-Z_]/.test(x);

interface Sub {
  id: number; query: string; rel: string; book: string | null; args: string[]; requester: string | null; sink: Sink;
  scope: Map<string, BookScope>; until: number | null;
  /** The row keys of the last answer, for a relation the node answers; null otherwise. */
  reask: Set<string> | null;
  owes: string | null;
  added: Map<string, AskRow>; removed: Map<string, AskRow>;
  /** The rule worlds it is watched in, by author. */
  authors: Set<string>;
  /** Why it owes a full frame of a world built anew. */
  why: string | null;
}

export class Hub {
  private readonly host: Host;
  private readonly subs = new Map<number, Sub>();
  private next = 1;
  /** Main world: relation → its subscribers. */
  private readonly main = new Map<string, Set<Sub>>();
  /** Rule worlds: author → the session watched and relation → subscribers. */
  private readonly worlds = new Map<string, { session: number; rels: Map<string, Set<Sub>> }>();
  /** Rows that moved since the last flush: session|rel → book\0row → +1 / −1. */
  private readonly pending = new Map<string, Map<string, { book: string; values: (string | number)[]; sign: number }>>();
  private readonly lost = new Set<number>();
  private by = new Set<string>();

  constructor(host: Host) { this.host = host; }

  get size(): number { return this.subs.size; }

  /** The engine's changes, as each answer carried them. */
  changes(session: number, changes: Change[], by: string): void {
    this.by.add(by);
    if (by === 'lost') this.lost.add(session);
    for (const c of changes) {
      const k = `${session}|${c.rel}`;
      let p = this.pending.get(k);
      if (!p) { p = new Map(); this.pending.set(k, p); }
      for (const [rows, sign] of [[c.added, 1], [c.removed, -1]] as const) {
        for (const args of rows) {
          const values = args.map(termCell);
          const key = `${c.book}\0${JSON.stringify(values)}`;
          const was = p.get(key);
          // A row that went and came back (or came and went) did not move.
          if (was && was.sign !== sign) p.delete(key); else p.set(key, { book: c.book, values, sign });
        }
      }
    }
  }

  /** Start a subscription: it is sent its full answer at once. */
  async add(query: string, requester: string | null, sink: Sink): Promise<number> {
    const { rel, book, args } = parseLiteral(query);
    const sub: Sub = {
      id: this.next++, query, rel, book: book !== null && !isVar(book) ? book : null, args: splitArgs(args), requester, sink,
      scope: await this.host.scope(requester), until: await this.host.expiry(requester),
      reask: NODE_ANSWERED.has(rel) ? new Set() : null, owes: 'start', added: new Map(), removed: new Map(), authors: new Set(), why: null,
    };
    this.subs.set(sub.id, sub);
    try {
      await this.attach(sub);
      await this.flush(null);
    } catch (e) {
      await this.remove(sub.id);
      throw e;
    }
    return sub.id;
  }

  async remove(id: number): Promise<void> {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    await this.detach(sub);
  }

  /** After an admission (`cause` its digest) or a tick of the clock: carry
   *  every subscription to the state the node is in now. `access`: the batch
   *  could change who reads what, or which rules run. A subscriber whose
   *  access did not change is sent what moved, by delta, even then: a rule
   *  added, retired or no longer trusted, a grant given, revoked or expired
   *  reach it as the rows the rule world gained and lost. Only a reader whose
   *  own scope changed, or one watching a world the node had to build anew,
   *  is sent its answer whole. */
  async settle(cause: string | null, access: boolean): Promise<void> {
    if (this.subs.size === 0) return;
    const now = this.host.now();
    for (const sub of [...this.subs.values()]) {
      if (!access && (sub.until === null || sub.until > now)) continue;
      const scope = await this.host.scope(sub.requester);
      sub.until = await this.host.expiry(sub.requester);
      if (sub.book !== null && !scope.has(sub.book)) {
        sub.sink({ kind: 'refused', head: this.host.head(), cause, error: 'no_grant', message: `${sub.requester ?? 'an anonymous reader'} may no longer read ${sub.book}` });
        await this.remove(sub.id);
        continue;
      }
      if (sig(scope) !== sig(sub.scope)) {
        await this.detach(sub);
        sub.scope = scope;
        await this.attach(sub);
        sub.owes = 'access';
      }
    }
    // Every rule world a subscription is watched in, carried forward. One
    // whose author has no rules left was emptied by delta before it closed:
    // its rows are already pending as removed. One built anew has lost its
    // watch, and its subscribers re-read, told why.
    const gone: [string, number][] = [];
    for (const [author, w] of [...this.worlds]) {
      const s = await this.host.world(author);
      if (s === w.session) continue;
      const subs = new Set([...w.rels.values()].flatMap((x) => [...x]));
      if (s === null) { gone.push([author, w.session]); for (const sub of subs) sub.authors.delete(author); continue; }
      this.worlds.delete(author);
      for (const sub of subs) { sub.authors.delete(author); if (sub.owes === null) { sub.owes = 'rebuilt'; sub.why = this.host.rebuilt(author); } }
      for (const sub of subs) await this.attach(sub);
    }
    // An author's first rules: a world where there was none. Its rows are
    // what the subscriber lacks; they are sent as added.
    if (access) {
      for (const sub of this.subs.values()) {
        if (sub.reask || FACT_KEYED.has(sub.rel)) continue;
        const before = new Set(sub.authors);
        await this.attach(sub);
        if (sub.owes !== null) continue;
        for (const [b, sc] of sub.scope) {
          if (sc.only !== null || before.has(sc.identity) || !sub.authors.has(sc.identity) || (sub.book !== null && sub.book !== b)) continue;
          const rows = await this.host.worldRows(sc.identity, sub.rel, b, sub.args);
          for (const cells of rows ?? []) {
            const row: AskRow = { identity: sc.identity, cells };
            sub.added.set(rowKey(row), row);
          }
          if (rows?.length) this.by.add('whole');
        }
      }
    }
    if (this.main.size) await this.host.settle();
    await this.flush(cause);
    for (const [author, session] of gone) if (this.worlds.get(author)?.session === session) this.worlds.delete(author);
  }

  /** The engine was replaced (it died and was rebuilt from the log): every
   *  watch went with it. Watch again, and send every subscriber its answer whole. */
  async rewatch(): Promise<void> {
    this.main.clear();
    this.worlds.clear();
    this.pending.clear();
    this.lost.clear();
    for (const sub of this.subs.values()) { sub.authors.clear(); sub.owes = 'lost'; await this.attach(sub); }
    await this.flush(null);
  }

  /** The earliest time any subscriber's access runs out (Unix seconds), for the node's timer. */
  nextExpiry(): number | null {
    let t: number | null = null;
    for (const s of this.subs.values()) if (s.until !== null && (t === null || s.until < t)) t = s.until;
    return t;
  }

  private async attach(sub: Sub): Promise<void> {
    if (sub.reask) return;
    let m = this.main.get(sub.rel);
    if (!m) {
      await this.host.watch(this.host.mainSession(), [{ rel: sub.rel }], true);
      m = new Set();
      this.main.set(sub.rel, m);
    }
    m.add(sub);
    if (FACT_KEYED.has(sub.rel)) return;
    for (const [b, sc] of sub.scope) {
      if (sc.only !== null || (sub.book !== null && sub.book !== b)) continue;
      const s = await this.host.world(sc.identity);
      if (s === null) continue;
      let w = this.worlds.get(sc.identity);
      if (w && w.session !== s) { this.worlds.delete(sc.identity); w = undefined; }
      if (!w) { w = { session: s, rels: new Map() }; this.worlds.set(sc.identity, w); }
      let r = w.rels.get(sub.rel);
      if (!r) {
        await this.host.watch(s, [{ rel: sub.rel, book: b }], true);
        r = new Set();
        w.rels.set(sub.rel, r);
      }
      r.add(sub);
      sub.authors.add(sc.identity);
    }
  }

  private async detach(sub: Sub): Promise<void> {
    const m = this.main.get(sub.rel);
    if (m?.delete(sub) && m.size === 0) {
      this.main.delete(sub.rel);
      await this.host.watch(this.host.mainSession(), [{ rel: sub.rel }], false).catch(() => {});
    }
    for (const a of sub.authors) {
      const w = this.worlds.get(a);
      const r = w?.rels.get(sub.rel);
      if (!w || !r?.delete(sub) || r.size) continue;
      w.rels.delete(sub.rel);
      await this.host.watch(w.session, [{ rel: sub.rel }], false).catch(() => {});
      if (w.rels.size === 0) this.worlds.delete(a);
    }
    sub.authors.clear();
  }

  /** Fan the pending changes out, and send each subscription its frame. */
  private async flush(cause: string | null): Promise<void> {
    const main = this.host.mainSession();
    const lost = this.lost;
    for (const [k, rows] of this.pending) {
      const bar = k.indexOf('|');
      const session = Number(k.slice(0, bar));
      const rel = k.slice(bar + 1);
      const subs = session === main ? this.main.get(rel)
        : [...this.worlds.values()].find((w) => w.session === session)?.rels.get(rel);
      if (!subs) continue;
      for (const sub of subs) {
        if (lost.has(session)) { sub.owes ??= 'lost'; continue; }
        for (const { book, values, sign } of rows.values()) {
          const sc = sub.scope.get(book);
          if (!sc || (sub.book !== null && sub.book !== book)) continue;
          if (sc.only !== null && (!FACT_KEYED.has(rel) || !sc.only.has(String(values[0])))) continue;
          const m = match(sub.args, values);
          if (!m) continue;
          const row: AskRow = { identity: sc.identity, cells: m.cells };
          const key = rowKey(row);
          const [to, from] = sign > 0 ? [sub.added, sub.removed] : [sub.removed, sub.added];
          if (from.has(key)) from.delete(key); else to.set(key, row);
        }
      }
    }
    this.pending.clear();
    this.lost.clear();
    const by = [...this.by].filter((b) => b !== 'lost').sort().join(',') || undefined;
    this.by = new Set();
    const head = this.host.head();
    for (const sub of [...this.subs.values()]) {
      if (sub.reask) { await this.reask(sub, cause, head); continue; }
      if (sub.owes !== null) {
        const a = await this.host.ask(sub.query, sub.requester);
        const whole = sub.owes === 'rebuilt' || sub.owes === 'lost';
        sub.sink({ kind: 'full', head, cause: sub.owes === 'start' ? 'start' : cause ?? sub.owes, vars: a.vars, rows: a.rows, ...(a.unknown ? { unknown: a.unknown } : {}),
          ...(whole ? { by: 'whole', why: sub.owes === 'lost' ? 'the engine was replaced, or its watch lost' : sub.why ?? 'the rule world was built anew' } : {}) });
        sub.owes = null;
        sub.why = null;
      } else if (sub.added.size || sub.removed.size) {
        sub.sink({ kind: 'delta', head, cause, added: sortRows([...sub.added.values()]), removed: sortRows([...sub.removed.values()]), by });
      }
      sub.added.clear();
      sub.removed.clear();
    }
  }

  private async reask(sub: Sub, cause: string | null, head: string): Promise<void> {
    const a = await this.host.ask(sub.query, sub.requester);
    const now = new Map(a.rows.map((r) => [rowKey(r), r]));
    if (sub.owes !== null) {
      sub.sink({ kind: 'full', head, cause: sub.owes === 'start' ? 'start' : cause ?? sub.owes, vars: a.vars, rows: a.rows });
      sub.owes = null;
    } else {
      const added = [...now].filter(([k]) => !sub.reask!.has(k)).map(([, r]) => r);
      const removed = [...sub.reask!].filter((k) => !now.has(k)).map((k) => JSON.parse(k) as [string, (string | number)[]]).map(([identity, cells]) => ({ identity, cells }));
      if (added.length || removed.length) sub.sink({ kind: 'delta', head, cause, added, removed, by: 'reask' });
    }
    sub.reask = new Set(now.keys());
  }
}

/** A scope's shape, to tell whether it changed. */
function sig(scope: Map<string, BookScope>): string {
  return JSON.stringify([...scope].sort(([a], [b]) => (a < b ? -1 : 1)).map(([b, sc]) => [b, sc.only === null ? null : [...sc.only].sort()]));
}
