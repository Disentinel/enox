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
// file prefix): the directory listing, the strings cut as specifiers. Every
// pod holds the corpus's core, as the engine's own volumes do (docs/cli.md of
// Disentinel/rofl, *A corpus larger than one heap*: "the facts naming no file
// ... read by all"); a file's facts are those naming its prefix.
//
// THE CUT IS SOUND WHEN every row a pod derives of an escape holds in the
// whole world, and every row the whole world derives is a pod's or the
// coordinator's — i.e. the rules that cross files are the coordinator's. The
// mechanism does not prove that of a program; the oracle of
// test/pods.test.ts holds the coordinator to the whole world, row for row.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EngineRefusal, RoflPort, type RoflSession } from '@grafema/rofl/port';
import { DEFAULT_ROFL_BIN, termCell, type Change } from './engine.ts';
import { roflString, type Fact } from './facts.ts';
import { BUILTIN, splitTop } from './rules.ts';

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
