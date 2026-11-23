// CODE: a node's questions over a directory of JS/TS code, kept answered as the code changes.
//
// The directory is scanned by the JS scanner, its facts cut by file, and the corpus settled by levels in the engine
// (`rofl serve` op `volumes`) under the JS model and the owner's own rules. The answers to the owner's questions are
// published as the owner's facts (Answers), so a view on the node shows them and a subscriber gets what moved. An
// edit of a file is scanned alone and sent to the engine, which settles again only the units it moved; a file that
// comes, or the corpus's core moving (the listing, the strings), stands the engine up anew.
//
// The model and the scanner are those of the engine's own source: the rofl tree it was built in, or the
// @grafema/rofl package it came with. An engine and a model of different versions meet defects neither has alone
// (owner, 2026-11-22).
//
// One engine by default. Pods (`pods` > 0, src/federation.ts) split one corpus over processes; that is no way to
// speed (owner, 2026-11-23): it is for the federation's own checks.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROFL_BIN } from './engine.ts';
import type { Fact } from './facts.ts';
import { Answers, corpusText, decodeRule, EngineNode, podSize, splitFacts, type Published } from './federation.ts';

/** Where an engine's JS model and scanner are. */
export interface Source {
  root: string;
  /** models/lang/js/js.files: the model's files, one a line */
  model: string;
  /** The scanner over `args` (DIR [FILE]): its facts as text. */
  scan(args: string[]): Promise<string>;
}

/** The source the engine `bin` was built from: `<tree>/rust/target/<profile>/rofl`, the package's `npm/rofl.js`, or
 *  the platform binary installed beside @grafema/rofl. */
export async function sourceOf(bin: string = DEFAULT_ROFL_BIN): Promise<Source> {
  const real = fs.realpathSync(bin);
  const at = real.split(path.sep);
  const t = at.lastIndexOf('target');
  const root = t >= 2 && at[t - 1] === 'rust' ? at.slice(0, t - 1).join(path.sep)
    : path.basename(path.dirname(real)) === 'npm' ? path.dirname(path.dirname(real))
    : path.join(path.dirname(real), '../../rofl');
  const ts = fs.existsSync(path.join(root, 'src/parser.ts'));
  const ext = ts ? 'ts' : 'js';
  const model = path.join(root, 'models/lang/js/js.files');
  const scanner = path.join(root, `models/lang/js/scanner/cli.${ext}`);
  for (const f of [model, scanner]) {
    if (!fs.existsSync(f)) throw new Error(`the engine ${bin} has no JS model beside it (${f}): use an engine built in a Disentinel/rofl tree, or @grafema/rofl 1.8 or later`);
  }
  const { isColumns, fromColumns } = await import(pathToFileURL(path.join(root, `src/parser.${ext}`)).href) as { isColumns: (t: string) => boolean; fromColumns: (t: string) => string };
  const flags = ts ? ['--experimental-strip-types', '--no-warnings'] : [];
  return {
    root, model,
    async scan(args: string[]): Promise<string> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fkts-scan-'));
      try {
        const out = path.join(dir, 'facts.rofl');
        await run(process.execPath, [...flags, scanner, ...args, '--out', out], { timeout: 600_000, maxBuffer: 64 << 20 });
        const text = fs.readFileSync(out, 'utf8');
        return isColumns(text) ? fromColumns(text) : text;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

/** The files a scan read, by their path from the root. */
export function filesOf(text: string, root: string): string[] {
  const r = fs.realpathSync(root);
  return text.split('\n').filter((l) => l.startsWith('-- reads: ')).map((l) => l.slice(10).trim())
    .filter((p) => fs.existsSync(p)).map((p) => path.relative(r, fs.realpathSync(p))).filter((p) => !p.startsWith('..') && fs.statSync(path.join(r, p)).isFile()).sort();
}

/** A question: one positive literal, `rel(Args)`. */
export function questionOf(lit: string): { rel: string; arity: number } {
  const m = /^\s*([a-z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(lit);
  if (!m) throw new Error(`a question is one literal, rel(Args): ${lit}`);
  const arity = m[2]!.trim() === '' ? 0 : m[2]!.split(',').length;
  return { rel: m[1]!, arity };
}

export interface PodNode { name: string; engine: EngineNode; files: string[] }

export interface CodeOptions {
  /** The owner's rules beside the JS model: `.rofl` files. */
  rules?: string[];
  /** The questions kept answered, one literal each, of different relations. */
  asks: string[];
  /** How the answers are published, as the owner's facts. */
  publish: (facts: Fact[]) => Promise<void>;
  /** The owner's book, which the rule reading the answers back names. */
  book: string;
  /** Processes the corpus is split over (0: one engine). */
  pods?: number;
  budget?: number;
  source?: Source;
}

export class CodeWorld {
  readonly root: string;
  readonly source: Source;
  pods: PodNode[] = [];
  /** The engine that answers: the only one, or the root over the pods. */
  top!: EngineNode;
  /** The core's facts, each with how many files' shares hold it: a fact no file holds any more leaves. */
  private readonly core = new Map<string, number>();
  private readonly shareOf = new Map<string, Set<string>>();
  private readonly facts = new Map<string, Set<string>>();
  /** The files in the engine's order: a file's place is its index. */
  files: string[] = [];
  private readonly o: CodeOptions;
  private readonly program: string;
  private readonly answers: { lit: string; a: Answers }[];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(root: string, source: Source, o: CodeOptions, program: string) {
    this.root = root; this.source = source; this.o = o; this.program = program;
    this.answers = o.asks.map((lit) => ({ lit, a: new Answers(questionOf(lit).rel, o.publish) }));
  }

  /** The program: the JS model, the owner's rules, and the questions' cone (only the rules they need run). */
  private static program(source: Source, o: CodeOptions): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fkts-model-'));
    const rels = [...new Set(o.asks.map((q) => questionOf(q).rel))];
    if (rels.length !== o.asks.length) throw new Error('two questions of one relation: ask each relation once');
    fs.writeFileSync(path.join(dir, 'asks.rofl'), rels.map((r) => `asks(${r}).`).join('\n') + '\n');
    const model = fs.readFileSync(source.model, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('--')).map((x) => path.resolve(path.dirname(source.model), x));
    const list = path.join(dir, 'program.files');
    fs.writeFileSync(list, [...model, ...(o.rules ?? []).map((r) => path.resolve(r)), path.join(dir, 'asks.rofl')].join('\n') + '\n');
    return list;
  }

  /** Stand it up over the code at `root`, publish the rule that reads the answers back and the first answers. */
  static async start(root: string, o: CodeOptions): Promise<{ world: CodeWorld; published: Published[] }> {
    const t0 = performance.now();
    const source = o.source ?? await sourceOf();
    const w = new CodeWorld(root, source, o, CodeWorld.program(source, o));
    const text = await source.scan([root]);
    w.files = filesOf(text, root);
    const whole = splitFacts(text, w.files);
    // (each file's share of the core, which it takes with it when it goes; the files scanned alone must be the
    // corpus scanned whole)
    const alone = await pool(w.files, (f) => source.scan([root, f]));
    for (const [i, f] of w.files.entries()) {
      const one = splitFacts(alone[i]!, [f]);
      w.facts.set(f, one.byFile.get(f)!);
      w.shareOf.set(f, one.core);
      for (const l of one.core) w.core.set(l, (w.core.get(l) ?? 0) + 1);
      if (!same(one.byFile.get(f)!, whole.byFile.get(f)!)) throw new Error(`${f} scanned alone differs from ${f} scanned with the rest: the scanner keeps state across files`);
    }
    if (!same(new Set(w.core.keys()), whole.core)) throw new Error('the files\' shares of the core differ from the core of the whole scan');
    await o.publish(w.answers.map(({ lit }) => { const q = questionOf(lit); return { source: `answers:${q.rel}`, relation: 'fkts:rule', target: decodeRule(q.rel, q.arity, o.book), perspective: 'rules', confidence: 1 } satisfies Fact; }));
    await w.engines();
    return { world: w, published: await w.step(t0, performance.now(), 'anew') };
  }

  /** The engines over the corpus as it is now. */
  private async engines(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fkts-code-'));
    const corpus = path.join(dir, 'corpus.rofl');
    fs.writeFileSync(corpus, corpusText(this.core.keys(), this.files, this.facts));
    const n = this.o.pods ?? 0;
    const base = { program: this.program, ...(this.o.budget ? { budget: this.o.budget } : {}) };
    if (n === 0) {
      this.top = await EngineNode.start(base, 'root', corpus);
      this.pods = [];
      return;
    }
    const size = podSize(this.files.length, n);
    const k = Math.ceil(this.files.length / size);
    const o = { ...base, far: { dir, size } };
    // (every process stands up at once: a pod settles its layers with ids from the root, the root waits for the pods)
    const done = await Promise.allSettled([EngineNode.start(o, 'root', corpus), ...Array.from({ length: k }, (_, i) => EngineNode.start(o, i, corpus))]);
    // (one that refuses refuses them all; the refusal said is the cause, not a process that saw another go)
    const no = done.filter((d): d is PromiseRejectedResult => d.status === 'rejected').sort((a, b) => Number(/ went: /.test(String(a.reason))) - Number(/ went: /.test(String(b.reason))));
    if (no.length) {
      for (const d of done) if (d.status === 'fulfilled') await d.value.close().catch(() => {});
      throw no[0]!.reason;
    }
    const [top, ...engines] = done.map((d) => (d as PromiseFulfilledResult<EngineNode>).value);
    this.top = top!;
    this.pods = engines.map((engine, i) => ({ name: `pod-${i}`, engine, files: this.files.slice(i * size, (i + 1) * size) }));
  }

  private async step(t0: number, t1: number, by: Published['by']): Promise<Published[]> {
    const out: Published[] = [];
    for (const { lit, a } of this.answers) out.push(await a.step(await this.top.rows(lit), t0, t1, by));
    return out;
  }

  /** The file at `file` (a path from the root) as it is on disk now, or gone: scanned alone and settled again where it
   *  moved the world; then the answers that moved are published. Edits are taken one at a time, in order. */
  edit(file: string): Promise<{ t0: number; published: Published[]; core: { in: number; out: number } }> {
    const r = this.queue.then(() => this.take(file));
    this.queue = r.catch(() => {});
    return r;
  }

  private async take(file: string) {
    const t0 = performance.now();
    const gone = !fs.existsSync(path.join(this.root, file));
    const now = gone ? null : await (async () => { const one = splitFacts(await this.source.scan([this.root, file]), [file]); return { facts: one.byFile.get(file)!, core: one.core }; })();
    const was = this.shareOf.get(file) ?? new Set<string>();
    const coreIn: string[] = [], coreOut: string[] = [];
    for (const l of was) if (!now?.core.has(l)) { const n = this.core.get(l)! - 1; if (n === 0) { this.core.delete(l); coreOut.push(l); } else this.core.set(l, n); }
    for (const l of now?.core ?? []) if (!was.has(l)) { const n = (this.core.get(l) ?? 0) + 1; this.core.set(l, n); if (n === 1) coreIn.push(l); }
    const place = this.files.indexOf(file);
    if (now) { this.facts.set(file, now.facts); this.shareOf.set(file, now.core); } else { this.facts.delete(file); this.shareOf.delete(file); }
    let by: Published['by'];
    if (place >= 0 && coreIn.length === 0 && coreOut.length === 0) {
      await this.top.edit([{ at: place, rofl: now ? `${[...now.facts].join('\n')}\n` : '' }]);
      by = 'levels';
    } else {
      await this.stop();
      this.files = [...this.facts.keys()].sort();
      await this.engines();
      by = 'anew';
    }
    return { t0, published: await this.step(t0, performance.now(), by), core: { in: coreIn.length, out: coreOut.length } };
  }

  /** Follow the directory: a file written or removed under it is taken as an edit. */
  watch(say: (file: string, r: { published: Published[] } | Error) => void, ms = 300): fs.FSWatcher {
    const due = new Map<string, NodeJS.Timeout>();
    return fs.watch(this.root, { recursive: true }, (_e, name) => {
      if (!name || !/\.(m|c)?[jt]sx?$/.test(name) || name.split(path.sep).includes('node_modules')) return;
      const file = name.split(path.sep).join('/');
      clearTimeout(due.get(file));
      due.set(file, setTimeout(() => { due.delete(file); this.edit(file).then((r) => say(file, r), (e: Error) => say(file, e)); }, ms));
    });
  }

  private async stop(): Promise<void> {
    await this.top.close();
    for (const p of this.pods) await p.engine.close();
  }

  async close(): Promise<void> {
    await this.queue;
    await this.stop();
  }
}

function same(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

const run = promisify(execFile);

/** `f` over `xs`, as many at once as the machine has cores. */
async function pool<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(xs.length, os.availableParallelism()) }, async () => {
    while (next < xs.length) { const i = next++; out[i] = await f(xs[i]!); }
  }));
  return out;
}
