// A deterministic synthetic log for performance checks: N facts in batches of
// B, written straight into a data dir as signed batches (the same files and
// index admission writes), without going through admission. The facts are the
// same on every run; the key (and so the signatures) is fresh.
import { createHash } from 'node:crypto';
import { factId, toJsonl, newSalt, type Fact } from '../../src/facts.ts';
import { LocalIdentity } from '../../src/identity.ts';
import { Log } from '../../src/log.ts';

export function generateLog(dir: string, o: { facts: number; batch: number; name?: string; t0: number; labels?: boolean }): LocalIdentity {
  const me = LocalIdentity.create(dir, o.name ?? 'perf', new Date(o.t0 - 86_400_000));
  const log = new Log(dir);
  log.open();
  let prev: string | null = null;
  for (let b = 0; b * o.batch < o.facts; b++) {
    const facts: Fact[] = [];
    for (let i = b * o.batch; i < Math.min(o.facts, (b + 1) * o.batch); i++) {
      // With labels, every 4th fact names an entity, and the other facts
      // relate named entities, so an Enox view has entities and edges to hold.
      const ent = (k: number) => `enox://example.org/graph/main/d${k % 111}/e${k}`;
      const named = (k: number) => k - (k % 4);
      if (o.labels && i % 4 === 0) {
        facts.push({ source: ent(i), relation: 'enox:label', target: `Entity ${i}`, perspective: 'perf', confidence: 1 });
        continue;
      }
      facts.push(o.labels
        ? { source: ent(named(i)), relation: `rel${i % 85}`, target: ent(named((i * 7919) % o.facts)), perspective: 'perf', confidence: ((i % 10) + 1) / 10 }
        : { source: ent(i), relation: `rel${i % 85}`, target: `enox://example.org/graph/main/d${(i * 7) % 111}/e${(i * 7919) % o.facts}`,
          perspective: 'perf', confidence: ((i % 10) + 1) / 10 });
    }
    const jsonl = toJsonl(facts);
    const salt = newSalt();
    const at = new Date(o.t0 + b * 1000).toISOString();
    const manifest = me.signBatch(jsonl, prev, at, salt);
    log.append(manifest, jsonl, at, b === 0 ? me.identityDoc() : null, { salt });
    prev = manifest.digest;
  }
  return me;
}

/** A synthetic Enox book shaped like the owner's (r_search_latency,
 *  r_stats_bounded): `entities` entities, each with type, domain, label,
 *  description and times, and `assertions` assertions between them, each with
 *  its claim, Enox id, context and times — as an import writes them. The
 *  owner names `embedder` as its embedder and grants it the book. With
 *  `embed`, the embedder's own book is written too: an embedding for every
 *  text in `embed.texts(facts)`, by `embed.model`, as the embedder publishes
 *  them. Written straight into the log, as generateLog does. */
export function generateEnoxBook(dir: string, embedderDir: string, o: { entities: number; assertions: number; t0: number; batch?: number;
  embed?: { texts: (facts: Fact[]) => string[]; key: (text: string) => string; vector: (text: string) => string; perspective: string } }): { owner: LocalIdentity; embedder: LocalIdentity } {
  const owner = LocalIdentity.create(dir, 'owner', new Date(o.t0 - 86_400_000));
  const embedder = LocalIdentity.create(embedderDir, 'embedder', new Date(o.t0 - 86_400_000));
  const E = (k: number) => `enox://example.org/graph/main/d${k % 150}/entity_${k}`;
  const TYPES = ['concept', 'person', 'project', 'decision', 'artifact', 'event'];
  const RELS = ['about', 'supersedes', 'depends_on', 'enables', 'contradicts', 'references', 'triggered_by', 'implements', 'part_of', 'uses'];
  const W = ['graph', 'signed', 'log', 'memory', 'search', 'engine', 'owner', 'batch', 'review', 'deploy', 'node', 'index', 'policy', 'grant', 'rule', 'query'];
  const words = (k: number, n: number) => Array.from({ length: n }, (_, i) => W[(k * 7 + i * 13 + (k >> 3)) % W.length]).join(' ');
  const at = (k: number) => new Date(o.t0 - 30 * 86_400_000 + k * 60_000).toISOString();
  const facts: Fact[] = [];
  const f = (source: string, relation: string, target: string, confidence = 1) => facts.push({ source, relation, target, perspective: 'enox', confidence });
  for (let k = 0; k < o.entities; k++) {
    f(E(k), 'enox:type', TYPES[(k * 5 + (k % 150)) % TYPES.length]!);
    f(E(k), 'enox:domain', `d${k % 150}`);
    f(E(k), 'enox:label', `Entity ${k} ${words(k, 2)}`);
    f(E(k), 'enox:description', `${words(k, 12)} — the ${k}th thing the owner keeps about ${words(k + 1, 6)}.`);
    f(E(k), 'enox:created_at', at(k));
    f(E(k), 'enox:updated_at', at(k));
  }
  for (let i = 0; i < o.assertions; i++) {
    const s = E((i * 7919) % o.entities), t = E((i * 104729 + 1) % o.entities), r = RELS[i % RELS.length]!;
    if (s === t) continue;
    f(s, r, t, ((i % 10) + 1) / 10);
    const F = factId({ source: s, relation: r, target: t });
    f(F, 'enox:asserted_by', `agent:session-${i % 40}`);
    f(F, 'enox:fact_id', createHash('sha256').update(`${s}|${r}|${t}`).digest('hex'));
    f(F, 'enox:context', `${words(i, 20)}; observed while ${words(i + 3, 10)}.`);
    f(F, 'enox:created_at', at(i));
    f(F, 'enox:updated_at', at(i));
    f(F, 'enox:proof_depth', String(i % 3));
  }
  f('embedder', 'roflenox:embedder', 'search');
  f('embedder', 'roflenox:grant', new Date(o.t0 + 365 * 86_400_000).toISOString());
  const log = new Log(dir);
  log.open();
  const write = (me: LocalIdentity, all: Fact[], start: number) => {
    let prev: string | null = null;
    const size = o.batch ?? 2000;
    for (let b = 0; b * size < all.length; b++) {
      const jsonl = toJsonl(all.slice(b * size, (b + 1) * size));
      const salt = newSalt();
      const claimed = new Date(start + b * 1000).toISOString();
      const manifest = me.signBatch(jsonl, prev, claimed, salt);
      log.append(manifest, jsonl, claimed, b === 0 ? me.identityDoc() : null, { salt });
      prev = manifest.digest;
    }
  };
  write(owner, facts, o.t0);
  if (o.embed) {
    const e = o.embed;
    const seen = new Set<string>();
    const vectors: Fact[] = [];
    for (const text of e.texts(facts)) {
      const k = e.key(text);
      if (seen.has(k)) continue;
      seen.add(k);
      vectors.push({ source: k, relation: 'roflenox:embedding', target: e.vector(text), perspective: e.perspective, confidence: 1 });
    }
    write(embedder, vectors, o.t0 + 3_600_000);
  }
  return { owner, embedder };
}
