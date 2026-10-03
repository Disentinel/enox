#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// roflenox-embedder — the executor that answers searches by meaning
// (r_semantic_search, r_derived_rebuildable). It is an ordinary identity with
// its own process, like every executor (src/executor.ts):
//
//   1. it pulls the intents addressed to it of kind "search" — each is a
//      roflenox:search fact in an asker's book, which names this embedder with
//      a roflenox:embedder fact and grants it the book;
//   2. it reads that book like any reader (its signed feed, paged by batch),
//      and embeds each entity (label and description) and each assertion
//      (source, relation, target and context) it has not embedded before;
//   3. it publishes what it embedded as roflenox:embedding facts in ITS OWN
//      book, and the answer as a roflenox:result citing the search's key.
//
// Its index is only a cache of its own book: a fresh process rebuilds it from
// the log, and a fresh identity rebuilds it from the primary facts. Losing
// either loses no knowledge. The node never embeds and never waits for it.
//
// A running embedder KEEPS what it read (r_search_latency): its index and each
// book it searches, at the book's head. A later search reads only the batches
// written since — the owner's book once took 113 s a search, rebuilt from the
// log every time. Every request is signed as it is sent, so no amount of work
// before it makes it stale.
//
//   ROFLENOX_URL=… ROFLENOX_DATA=<its identity dir> roflenox-embedder [--once]
//
// --once (or ROFLENOX_ONCE=1) answers what is pending and exits; otherwise it polls every
// ROFLENOX_POLL_MS (default 1000: a search is answered within ten seconds).
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalIdentity } from '../../src/identity.ts';
import { httpCaller, publishVia, RemoteRefusal, type OpCaller } from '../../src/client.ts';
import { RESULT } from '../../src/executor.ts';
import { EMBEDDING, factId, type Fact } from '../../src/facts.ts';
import { cosine, decode, embeddingKey, encode, modelFromEnv, type Model } from './embed.ts';

const TOP = 50;

// MEMORY (r_compat_parity, r_search_latency). A model pads every text of one
// call to the longest in it, and its attention grows with the square of that
// length: 1000 texts with one long one cost 1000 × the long one (29 GB
// measured on the owner's book). So a call holds texts of similar length —
// sorted by length, packed while count × longest stays within PAD_BUDGET
// characters, and never more than BATCH texts — and a text is cut at
// MAX_CHARS, past what the model reads anyway (512 tokens for e5). Measured
// with e5-small on 2048-character texts: a budget of 32 768 peaked at 1.46 GB
// resident, 8 192 at 0.85 GB, in the same time.
export const BATCH = 64;
export const PAD_BUDGET = 8_192;
export const MAX_CHARS = 2_048;
/** How often a running embedder looks for searches, by default. */
export const POLL_MS = 1_000;
/** Batches per feed read. */
export const FEED_PAGE = 20;

/** Texts in calls of bounded padded size: [start, end) ranges of `texts`,
 *  which must be sorted by length. */
export function buckets(lengths: number[], budget = PAD_BUDGET, most = BATCH): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < lengths.length) {
    let j = i + 1;
    while (j < lengths.length && j - i < most && (j + 1 - i) * Math.max(1, lengths[j]!) <= budget) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

export interface ReadOptions {
  /** Batches per feed read (default FEED_PAGE). */
  feedPage?: number;
  /** Called after each feed page that is not the last (a test lands a write here). */
  onPage?: (page: number) => Promise<void> | void;
  /** The clock every request and batch is signed with, as it is sent. */
  now?: () => number;
}

interface Doc { kind: 'node' | 'fact'; id: string; text: string }
type Held = { S: string; R: string; T: string };

/** What the embedder keeps of a book: the current assertions it searches
 *  over, in the order they were last asserted, as of the book's head. Only
 *  what a text is made of is kept — labels, descriptions, contexts and the
 *  assertions themselves — not bodies or anything else. */
class Book {
  head: string | null = null;
  readonly cur = new Map<string, Held>();
  /** The texts, with their keys; derived again only when the book moved. */
  docs: (Doc & { key: string })[] | null = null;

  apply(facts: Fact[]): void {
    for (const f of facts) {
      const attr = f.relation.startsWith('enox:');
      if (attr ? !TEXT_ATTRS.has(f.relation) : f.relation.startsWith('roflenox:')) continue;
      const F = factId(f);
      this.cur.delete(F);                        // re-asserted: now the latest
      if (f.confidence > 0) this.cur.set(F, { S: f.source, R: f.relation, T: f.target });
    }
    this.docs = null;
  }
}
const TEXT_ATTRS = new Set(['enox:label', 'enox:description', 'enox:context']);

/** What there is to search in a book: its entities and its assertions, as
 *  text. An attribute is its latest current assertion. */
function docsOf(cur: Map<string, Held>): Doc[] {
  const attr = new Map<string, Map<string, string>>();
  const assertions: { F: string; S: string; R: string; T: string }[] = [];
  for (const [F, { S, R, T }] of cur) {
    if (R.startsWith('enox:')) {
      const m = attr.get(S) ?? new Map<string, string>();
      m.set(R.slice(5), T);
      attr.set(S, m);
    } else {
      assertions.push({ F, S, R, T });
    }
  }
  const name = (id: string) => attr.get(id)?.get('label') ?? id;
  const docs: Doc[] = [];
  for (const [id, m] of attr) {
    if (!m.has('label')) continue;
    docs.push({ kind: 'node', id, text: [m.get('label'), m.get('description')].filter(Boolean).join('. ') });
  }
  for (const a of assertions) {
    const context = attr.get(a.F)?.get('context');
    docs.push({ kind: 'fact', id: a.F, text: [`${name(a.S)} ${a.R.replace(/_/g, ' ')} ${name(a.T)}`, context].filter(Boolean).join('. ') });
  }
  return docs;
}

/** The texts an embedder makes of a book's facts, in the order they are
 *  asserted (a test writes their embeddings ahead: test/perf/gen.ts). */
export function textsOf(facts: Fact[]): string[] {
  const b = new Book();
  b.apply(facts);
  return docsOf(b.cur).map((d) => d.text);
}

const lines = (jsonl: string) => jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Fact);

/** An embedder: one identity, one model, and what it keeps between searches. */
export class Embedder {
  private readonly node: OpCaller;
  private readonly now: () => number;
  /** Embedding key → vector: the embedder's own book, as of `own.head`. */
  private readonly index = new Map<string, Float32Array>();
  private readonly answered = new Set<string>();
  private readonly own = new Book();
  private readonly books = new Map<string, Book>();
  private rounds = 0;
  /** Batches read from the feeds this round (the log line says how many). */
  private read = 0;
  private readonly me: LocalIdentity;
  private readonly model: Model;
  private readonly log: (s: string) => void;
  private readonly o: ReadOptions;

  constructor(url: string, me: LocalIdentity, model: Model, log: (s: string) => void = () => {}, o: ReadOptions = {}) {
    this.me = me;
    this.model = model;
    this.log = log;
    this.o = o;
    this.now = o.now ?? Date.now;
    this.node = httpCaller(url, me, this.now);
  }

  /** The batches of `identity` after what `book` holds, page by page; each
   *  is handed to `take`. Writes landing meanwhile are only more batches. */
  private async follow(identity: string, book: Book, take: (facts: Fact[]) => void): Promise<void> {
    const limit = this.o.feedPage ?? FEED_PAGE;
    let pages = 0;
    for (;;) {
      let r: { batches: { manifest: { digest: string }; jsonl?: string }[] };
      try {
        r = await this.node('feed', { identity, ...(book.head ? { after: book.head } : {}), limit });
      } catch (e) {
        if (e instanceof RemoteRefusal && e.reason === 'unknown_identity') return;      // nothing published yet
        throw e;
      }
      for (const b of r.batches) {
        if (b.jsonl !== undefined) take(lines(b.jsonl));
        book.head = b.manifest.digest;
      }
      this.read += r.batches.length;
      if (r.batches.length < limit) return;
      await this.o.onPage?.(++pages);
    }
  }

  /** The search intents addressed to this embedder that it has not answered. */
  private async intents(): Promise<{ author: string; key: string; input: string }[]> {
    const q = await this.node('ask', { query: `intent(K, ${JSON.stringify(this.me.name)}, "search", In)` }) as { rows: { identity: string; cells: (string | number)[] }[] };
    return q.rows.filter((r) => !this.answered.has(String(r.cells[0]))).map((r) => ({ author: r.identity, key: String(r.cells[0]), input: String(r.cells[1]) }));
  }

  /** Answer the search intents addressed to this embedder. Returns how many were answered. */
  async round(): Promise<number> {
    const first = this.rounds++ === 0;
    this.read = 0;
    // The index, from this embedder's own book in the log: all of it the
    // first time, and what was written since afterwards.
    const had = this.index.size;
    await this.follow(this.me.name, this.own, (facts) => {
      for (const f of facts) {
        if (f.relation === EMBEDDING) this.index.set(f.source, decode(f.target));
        else if (f.relation === RESULT) this.answered.add(f.source);
      }
    });
    const intents = await this.intents();
    if (intents.length === 0) return 0;
    const ownRead = this.read;
    const fromLog = this.index.size - (first ? 0 : had);
    let embedded = 0;

    const byAuthor = new Map<string, typeof intents>();
    for (const i of intents) byAuthor.set(i.author, [...(byAuthor.get(i.author) ?? []), i]);
    const results: Fact[] = [];
    for (const [author, asked] of byAuthor) {
      const book = this.books.get(author) ?? new Book();
      this.books.set(author, book);
      await this.follow(author, book, (facts) => book.apply(facts));
      book.docs ??= docsOf(book.cur).map((d) => ({ ...d, key: embeddingKey(this.model.id, d.text) }));
      const docs = book.docs;
      const missing = [...new Map(docs.map((d) => [d.key, d.text.slice(0, MAX_CHARS)])).entries()]
        .filter(([k]) => !this.index.has(k)).sort((x, y) => x[1].length - y[1].length);
      for (const [i, j] of buckets(missing.map(([, t]) => t.length))) {
        const chunk = missing.slice(i, j);
        const vs = await this.model.embed(chunk.map(([, t]) => t), 'passage');
        const facts = chunk.map(([k], j) => {
          // Quantised as it will be read back, so this run ranks as a rebuild would.
          const v = encode(vs[j]!);
          this.index.set(k, decode(v));
          return { source: k, relation: EMBEDDING, target: v, perspective: this.model.id, confidence: 1 };
        });
        await publishVia(this.node, this.me, facts, this.now);
        embedded += facts.length;
      }
      for (const i of asked) {
        const q = (await this.model.embed([i.input], 'query'))[0]!;
        const hits = docs.map((d) => ({ kind: d.kind, id: d.id, score: Math.round(cosine(q, this.index.get(d.key)!) * 1000) / 1000 }))
          .filter((h) => h.score > 0)
          .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
          .slice(0, TOP);
        results.push({ source: i.key, relation: RESULT, target: JSON.stringify({ model: this.model.id, hits }), perspective: 'search', confidence: 1 });
        this.answered.add(i.key);
      }
    }
    await publishVia(this.node, this.me, results, this.now);
    this.log(`answered ${results.length} searches; index: ${first ? `${fromLog} from the log` : `${had} in memory, ${fromLog} from the log`}, ${embedded} embedded now; `
      + `${ownRead} batches of its own and ${this.read - ownRead} of the books searched read`);
    return results.length;
  }
}

/** Answer the search intents addressed to `me` once, as a fresh process would. */
export function answerSearches(url: string, me: LocalIdentity, model: Model, log: (s: string) => void = () => {}, o: ReadOptions = {}): Promise<number> {
  return new Embedder(url, me, model, log, o).round();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.ROFLENOX_URL ?? 'http://127.0.0.1:7380';
  const data = process.env.ROFLENOX_DATA;
  const me = data ? LocalIdentity.load(data) : null;
  if (!me) {
    process.stderr.write('roflenox-embedder: ROFLENOX_DATA must hold this executor\'s identity (roflenox init --data DIR --name embedder)\n');
    process.exit(2);
  }
  const say = (s: string) => process.stdout.write(`${s}\n`);
  if (process.argv.includes('--once') || process.env.ROFLENOX_ONCE === '1') {
    say(`answered ${await answerSearches(url, me, await modelFromEnv(), say)}`);
  } else {
    const every = Number(process.env.ROFLENOX_POLL_MS ?? POLL_MS);
    const embedder = new Embedder(url, me, await modelFromEnv(), say);
    for (;;) {
      try { await embedder.round(); } catch (e) { process.stderr.write(`roflenox-embedder: ${(e as Error).message}\n`); }
      await new Promise((r) => setTimeout(r, every));
    }
  }
}
