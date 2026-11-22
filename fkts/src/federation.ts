// PODS (r_pods): a federation where each pod settles only its files and a
// coordinator holds the question.
//
// A pod is a NODE of the engine's world by levels, a process of its own
// (`rofl serve` with ROFL_FAR, Disentinel/rofl docs/cli.md, *The nodes as
// processes*): every process runs the same levels over the same corpus,
// settles the units of its block of files and asks the others for the units it
// reads, over a unix socket or TCP. The coordinator's engine is the ROOT: it
// settles the units over more than one pod and answers the question. What
// crosses between pods is decided by the engine from the rules' keys, never by
// a list kept here: no relation is named, no rule is copied.
//
// An edit of a file goes to the root, which sends it to every pod; each settles
// again only its units the edit moved, and what they moved crosses as facts.
// An edit the levels cannot take (a file that comes, or the core of the corpus
// moving: the listing, the strings) stands the engines up anew over the corpus
// as it is now.
//
// What is SIGNED is the coordinator's answers (owner, 2026-11-22): after each
// step the root's rows that came are published as the coordinator's facts and
// those that went re-asserted at confidence 0; one rule reads them back as the
// question's relation. The units cross between the pods of one owner unsigned.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RoflPort } from '@grafema/rofl/port';
import { DEFAULT_ROFL_BIN } from './engine.ts';
import { decodeCell, roflString, type Fact } from './facts.ts';

export const ROW = 'row:';
/** The walls of an engine's world: a corpus's program runs far past the engine's default rows. */
export const WALLS = { budget: 1e9, space: 1e9 };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** The scanner's prefix of every node id of a file (oxc_scan `prefix`). */
export const filePrefix = (file: string) => `n${sha(file).slice(0, 16)}_`;
const NODE = /n[0-9a-f]{16}_/;
/** A unit of the engine holds the files of a leaf (4); a pod holds whole leaves. */
const LEAF = 4;

/** The rule that reads a relation's rows back from the facts `book` publishes, by their current assertion. */
export function decodeRule(rel: string, arity: number, book: string): string {
  const vars = Array.from({ length: arity }, (_, i) => `A${i}`);
  const reads = vars.map((v, i) => `edge[${book}](F${i}, T, ${roflString(`${ROW}${rel}#${i + 1}`)}, ${v}), asserted[${book}](F${i}, P${i}, C${i}, S${i}), C${i} > 0`);
  return `${rel}(${vars.join(', ')}) :- ${reads.join(', ')}.`;
}

/** A row's facts: the same row, the same facts. */
export function rowFacts(rel: string, cells: string[], confidence: number): Fact[] {
  const id = `${rel}:${sha(JSON.stringify([rel, cells])).slice(0, 32)}`;
  return cells.map((c, i) => {
    if (c.trim() === '') throw new Error(`${rel}: a blank cell at ${i + 1} cannot be published (a fact's target is never blank)`);
    return { source: id, relation: `${ROW}${rel}#${i + 1}`, target: c, perspective: 'answers', confidence };
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

/** The corpus as the engines read it: the core, then each file's facts in `files`' order, which is the order of
 *  the files' places in every engine (a pod's block is a run of them). */
export function corpusText(core: Iterable<string>, files: string[], facts: Map<string, Iterable<string>>): string {
  let t = [...core].join('\n') + '\n';
  for (const f of files) {
    const fs_ = [...(facts.get(f) ?? [])];
    if (fs_.length) t += fs_.join('\n') + '\n';
  }
  return t;
}

/** How many files a pod settles for `pods` pods over `files` files: whole leaves, as few pods as hold them. */
export const podSize = (files: number, pods: number) => Math.max(LEAF, Math.ceil(files / pods / LEAF) * LEAF);

export interface EngineOptions {
  /** The program every process runs: a `.files` list or a `.rofl`. */
  program: string;
  /** Where the processes meet: a unix socket each, or TCP where `dir/peers` says where each listens. */
  dir: string;
  /** Files a pod settles (podSize). */
  size: number;
  bin?: string;
  /** The steps an evaluation may take (WALLS.budget by default): a process that reaches it refuses, and so does
   *  every process that waits for its units, saying the wall. */
  budget?: number;
}

/** One process of the engine's world by levels: a pod (`me` its number) or the root. */
export class EngineNode {
  readonly me: number | 'root';
  private readonly port: RoflPort;
  private readonly world: number;
  private following: Promise<void> | null = null;

  private constructor(me: number | 'root', port: RoflPort, world: number) { this.me = me; this.port = port; this.world = world; }

  /** The process stood up: the program loaded and the corpus at `corpus` (a path) settled by levels; a pod settles
   *  its block and answers the others, the root waits for them and settles what is over them. */
  static async start(o: EngineOptions, me: number | 'root', corpus: string): Promise<EngineNode> {
    // (the engine reads where it is and which it is from its environment, taken when it is spawned)
    const env = { ROFL_FAR: o.dir, ROFL_FAR_ME: String(me), ROFL_HELD: String(o.size) };
    const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    let port: RoflPort;
    try { port = await RoflPort.start(o.bin ?? DEFAULT_ROFL_BIN); } finally {
      for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      const base = await port.fresh(o.budget ?? WALLS.budget, { space: WALLS.space });
      for (const f of programFiles(o.program)) await base.loadFile(f);
      const r = await port.send({ op: 'volumes', session: base.id, path: corpus }) as { session: number };
      const n = new EngineNode(me, port, r.session);
      if (me !== 'root') n.following = n.follow();
      return n;
    } catch (e) { await port.stop().catch(() => {}); throw e; }
  }

  /** A pod takes each edit the root sends, until the root goes. */
  private async follow(): Promise<void> {
    for (;;) {
      try { await this.port.send({ op: 'volumes_edit', session: this.world }); } catch { return; }
    }
  }

  /** The root: files edited by their place (`rofl`: the file's facts now, '' when it is gone), sent to every pod and
   *  settled again where they moved the world. */
  async edit(files: { at: number; rofl: string }[]): Promise<number> {
    if (this.me !== 'root') throw new Error('an edit goes to the root, which sends it to every pod');
    const r = await this.port.send({ op: 'volumes_edit', session: this.world, files }) as { ms: number };
    return r.ms;
  }

  /** The question's rows, each a list of cells. */
  async rows(query: string): Promise<string[][]> {
    const r = await this.port.send({ op: 'ask', session: this.world, query }) as { rows: string[][]; partial?: boolean };
    if (r.partial) throw new Error(`the world stopped at a wall before it answered ${query}`);
    return r.rows.map((row) => row.map((t) => String(decodeCell(t))));
  }

  /** The proof of a row, down into the units of the pods that settled them. */
  async why(query: string): Promise<string> {
    return ((await this.port.send({ op: 'why', session: this.world, query })) as { text: string }).text;
  }

  /** The engine process, for its memory. */
  get pid(): number | undefined { return (this.port as unknown as { child: { pid?: number } }).child.pid; }

  async close(): Promise<void> {
    await this.port.stop();
    await this.following;
  }
}

/** What a step published: the rows that came and went, and how long the engines and the publishing took. */
export interface Published { added: number; removed: number; facts: number; ms: { engine: number; publish: number };
  /** How the engines took it: `levels` (each settled again what the edit moved), or `anew` (stood up again). */
  by: 'levels' | 'anew' }

/** The coordinator's answers to one question, as its signed facts: each step publishes the rows that came and
 *  re-asserts at confidence 0 those that went. */
export class Answers {
  private readonly rel: string;
  private readonly publish: (facts: Fact[]) => Promise<void>;
  private readonly batch: number;
  private held = new Map<string, string[]>();

  constructor(rel: string, publish: (facts: Fact[]) => Promise<void>, batch = 20_000) { this.rel = rel; this.publish = publish; this.batch = batch; }

  async step(rows: string[][], t0: number, t1: number, by: Published['by']): Promise<Published> {
    const now = new Map(rows.map((r) => [JSON.stringify(r), r]));
    const facts: Fact[] = [];
    let added = 0, removed = 0;
    for (const [k, r] of now) if (!this.held.has(k)) { facts.push(...rowFacts(this.rel, r, 1)); added++; }
    for (const [k, r] of this.held) if (!now.has(k)) { facts.push(...rowFacts(this.rel, r, 0)); removed++; }
    this.held = now;
    for (let i = 0; i < facts.length; i += this.batch) await this.publish(facts.slice(i, i + this.batch));
    return { added, removed, facts: facts.length, ms: { engine: t1 - t0, publish: performance.now() - t1 }, by };
  }
}

/** The files of a program: a `.files` list (one path a line, from its directory), or one file. */
export function programFiles(p: string): string[] {
  if (!p.endsWith('.files')) return [p];
  return fs.readFileSync(p, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('--')).map((x) => path.resolve(path.dirname(p), x));
}
