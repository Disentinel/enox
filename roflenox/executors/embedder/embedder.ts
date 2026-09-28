#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// roflenox-embedder — the executor that answers searches by meaning
// (r_semantic_search, r_derived_rebuildable). It is an ordinary identity with
// its own process, like every executor (src/executor.ts):
//
//   1. it pulls the intents addressed to it of kind "search" — each is a
//      roflenox:search fact in an asker's book, which names this embedder with
//      a roflenox:embedder fact and grants it the book;
//   2. it reads that book like any reader (signed asks, paged), and embeds
//      each entity (label and description) and each assertion (source,
//      relation, target and context) it has not embedded before;
//   3. it publishes what it embedded as roflenox:embedding facts in ITS OWN
//      book, and the answer as a roflenox:result citing the search's key.
//
// Its index is only a cache of its own book: a fresh process rebuilds it from
// the log, and a fresh identity rebuilds it from the primary facts. Losing
// either loses no knowledge. The node never embeds and never waits for it.
//
//   ROFLENOX_URL=… ROFLENOX_DATA=<its identity dir> roflenox-embedder [--once]
//
// --once (or ROFLENOX_ONCE=1) answers what is pending and exits; otherwise it polls every
// ROFLENOX_POLL_MS (default 5000).
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookOf, LocalIdentity } from '../../src/identity.ts';
import { httpCaller, publishVia, RemoteRefusal, type OpCaller } from '../../src/client.ts';
import { pullIntents, RESULT } from '../../src/executor.ts';
import { EMBEDDING, type Fact } from '../../src/facts.ts';
import { cosine, decode, embeddingKey, encode, modelFromEnv, type Model } from './embed.ts';

const TOP = 50;

// MEMORY (r_compat_parity). A model pads every text of one call to the
// longest in it: 1000 texts with one long one cost 1000 × the long one (29 GB
// measured on the owner's book). So a call holds texts of similar length —
// sorted by length, packed while count × longest stays within PAD_BUDGET
// characters, and never more than BATCH texts — and a text is cut at
// MAX_CHARS, past what the model reads anyway (512 tokens for e5).
export const BATCH = 64;
export const PAD_BUDGET = 32_768;
export const MAX_CHARS = 2_048;

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

type Row = { identity: string; cells: (string | number)[] };

export interface ReadOptions {
  /** Rows per page (default the node's most, 10 000). */
  pageSize?: number;
  /** Called after each page is read (a test lands a write here). */
  onPage?: (page: number) => Promise<void> | void;
}

/** Every row of one question, page by page. A write that lands between two
 *  pages would make the next page refuse (cursor_stale); the read RESUMES
 *  instead, after the last row it had, in the answer of the log as it is now.
 *  A row written behind its position is left for the next read. */
async function askAll(node: OpCaller, query: string, o: ReadOptions = {}): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await node('ask', { query, limit: o.pageSize ?? 10_000, ...(cursor ? { cursor, resume: true } : {}) }) as { rows: Row[]; cut?: boolean; cursor?: string };
    out.push(...r.rows);
    cursor = r.cut ? r.cursor : undefined;
    if (cursor) await o.onPage?.(++pages);
  } while (cursor);
  return out;
}

/** What there is to search in a book: its entities and its assertions, as text. */
function docsOf(rows: Row[]): Doc[] {
  const attr = new Map<string, Map<string, string>>();
  const assertions: { F: string; S: string; R: string; T: string }[] = [];
  for (const { cells } of rows) {
    const [F, S, R, T] = cells.map(String) as [string, string, string, string];
    if (R.startsWith('enox:')) {
      const m = attr.get(S) ?? new Map<string, string>();
      m.set(R.slice(5), T);
      attr.set(S, m);
    } else if (!R.startsWith('roflenox:')) {
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

/** Answer the search intents addressed to `me`. Returns how many were answered. */
export async function answerSearches(url: string, me: LocalIdentity, model: Model, log: (s: string) => void = () => {}, o: ReadOptions = {}): Promise<number> {
  const node = httpCaller(url, me);
  const intents = (await pullIntents(url, me)).filter((i) => i.kind === 'search');
  if (intents.length === 0) return 0;

  // The index, rebuilt from this embedder's own book in the log.
  const index = new Map<string, Float32Array>();
  const own = await askAll(node, `edge[${bookOf(me.name)}](F, K, ${JSON.stringify(EMBEDDING)}, V)`, o).catch((e: unknown) => {
    if (e instanceof RemoteRefusal && e.reason === 'unknown_book') return [];    // nothing published yet
    throw e;
  });
  for (const { cells } of own) {
    index.set(String(cells[1]), decode(String(cells[2])));
  }
  const fromLog = index.size;
  let embedded = 0;

  const byAuthor = new Map<string, typeof intents>();
  for (const i of intents) byAuthor.set(i.author, [...(byAuthor.get(i.author) ?? []), i]);
  const results: Fact[] = [];
  for (const [author, asked] of byAuthor) {
    const docs = docsOf(await askAll(node, `edge[${bookOf(author)}](F, S, R, T)`, o));
    const missing = [...new Map(docs.map((d) => [embeddingKey(model.id, d.text), d.text.slice(0, MAX_CHARS)])).entries()]
      .filter(([k]) => !index.has(k)).sort((x, y) => x[1].length - y[1].length);
    for (const [i, j] of buckets(missing.map(([, t]) => t.length))) {
      const chunk = missing.slice(i, j);
      const vs = await model.embed(chunk.map(([, t]) => t), 'passage');
      const facts = chunk.map(([k], j) => {
        // Quantised as it will be read back, so this run ranks as a rebuild would.
        const v = encode(vs[j]!);
        index.set(k, decode(v));
        return { source: k, relation: EMBEDDING, target: v, perspective: model.id, confidence: 1 };
      });
      await publishVia(node, me, facts);
      embedded += facts.length;
    }
    for (const i of asked) {
      const q = (await model.embed([String(i.input)], 'query'))[0]!;
      const hits = docs.map((d) => ({ kind: d.kind, id: d.id, score: Math.round(cosine(q, index.get(embeddingKey(model.id, d.text))!) * 1000) / 1000 }))
        .filter((h) => h.score > 0)
        .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
        .slice(0, TOP);
      results.push({ source: i.key, relation: RESULT, target: JSON.stringify({ model: model.id, hits }), perspective: 'search', confidence: 1 });
    }
  }
  await publishVia(node, me, results);
  log(`answered ${results.length} searches; index: ${fromLog} from the log, ${embedded} embedded now`);
  return results.length;
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
    const every = Number(process.env.ROFLENOX_POLL_MS ?? 5000);
    const model = await modelFromEnv();
    for (;;) {
      try { await answerSearches(url, me, model, say); } catch (e) { process.stderr.write(`roflenox-embedder: ${(e as Error).message}\n`); }
      await new Promise((r) => setTimeout(r, every));
    }
  }
}
