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
import { RoflPort, type RoflSession } from '@grafema/rofl/port';
import { DEFAULT_ROFL_BIN, termCell, type Change } from './engine.ts';
import { roflString, type Fact } from './facts.ts';
import { BUILTIN, splitTop } from './rules.ts';

export const ROW = 'row:';
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

/** A scan's facts cut by file: those naming a file's node prefix, and the core naming none. */
export function splitFacts(text: string, files: string[]): { core: Set<string>; byFile: Map<string, Set<string>> } {
  const of = new Map(files.map((f) => [filePrefix(f), f]));
  const core = new Set<string>();
  const byFile = new Map(files.map((f) => [f, new Set<string>()]));
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l === '' || l.startsWith('--')) continue;
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

export interface Published { added: number; removed: number; facts: number; ms: { engine: number; publish: number } }

export class Pod {
  private readonly o: PodOptions;
  private readonly port: RoflPort;
  private readonly s: RoflSession;
  private readonly files = new Map<string, Set<string>>();
  private core = new Set<string>();
  /** Row id → [relation, cells, books holding it]. */
  private readonly rows = new Map<string, { rel: string; cells: string[]; n: number }>();
  private moved: Change[] = [];
  private readonly escapes: Map<string, Escape>;

  private constructor(o: PodOptions, port: RoflPort, s: RoflSession) {
    this.o = o; this.port = port; this.s = s;
    this.escapes = new Map(o.escapes.map((e) => [e.rel, e]));
    const send = port.send.bind(port);
    port.send = (req: Record<string, unknown>) => send(req).then((r: Record<string, unknown>) => {
      if (Array.isArray(r.changes)) this.moved.push(...(r.changes as Change[]));
      return r;
    });
  }

  /** Evaluate the program over the core and the pod's files, and publish every escaping row. */
  static async start(o: PodOptions, core: Iterable<string>, files: Map<string, Iterable<string>>): Promise<{ pod: Pod; published: Published }> {
    const port = await RoflPort.start(o.bin ?? DEFAULT_ROFL_BIN);
    const pod = new Pod(o, port, await port.fresh());
    for (const f of programFiles(o.program)) await pod.s.loadFile(f);
    pod.core = new Set(core);
    let text = [...pod.core].join('\n');
    for (const [f, facts] of files) { pod.files.set(f, new Set(facts)); text += `\n${[...facts].join('\n')}`; }
    // Watched before the facts come: base rows are told at the load, derived ones at the evaluation.
    await port.send({ op: 'watch', session: pod.s.id, rels: o.escapes.map((e) => ({ rel: e.rel })) });
    const t0 = performance.now();
    await pod.s.load(`${text}\n`);
    await pod.s.evaluate();
    return { pod, published: await pod.flush(t0) };
  }

  /** One file's facts now (null: the file is gone), and the core as it is now: the engine takes
   *  the difference by delta, and the pod publishes only the escaping rows that came and went. */
  async edit(file: string, facts: Iterable<string> | null, core?: Iterable<string>): Promise<Published> {
    const t0 = performance.now();
    const was = this.files.get(file) ?? new Set<string>();
    const now = new Set(facts ?? []);
    const coreNow = core ? new Set(core) : this.core;
    const out = [...was].filter((l) => !now.has(l)).concat([...this.core].filter((l) => !coreNow.has(l)));
    const add = [...now].filter((l) => !was.has(l)).concat([...coreNow].filter((l) => !this.core.has(l)));
    for (const l of out) await this.s.retract(l.replace(/\.$/, ''));
    if (add.length) await this.s.assert(`${add.join('\n')}\n`);
    if (facts === null) this.files.delete(file); else this.files.set(file, now);
    this.core = coreNow;
    return this.flush(t0);
  }

  /** The rows the engine said came and went since the last flush, netted, published as one batch (or a few). */
  private async flush(t0: number): Promise<Published> {
    const net = new Map<string, { rel: string; cells: string[]; d: number }>();
    for (const c of this.moved) {
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
    this.moved = [];
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
    return { added, removed, facts: facts.length, ms: { engine: t1 - t0, publish: performance.now() - t1 } };
  }

  /** The escaping rows the pod has published and not retired. */
  get published(): number { return this.rows.size; }
  /** The engine process, for its memory. */
  get pid(): number | undefined { return (this.port as unknown as { child: { pid?: number } }).child.pid; }
  /** Explain a row in the pod's own world: the proof below the batch the coordinator stops at. */
  why(query: string): Promise<string> { return this.s.why(query); }
  async close(): Promise<void> { await this.port.stop(); }
}
