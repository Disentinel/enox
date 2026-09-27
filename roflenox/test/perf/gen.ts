// A deterministic synthetic log for performance checks: N facts in batches of
// B, written straight into a data dir as signed batches (the same files and
// index admission writes), without going through admission. The facts are the
// same on every run; the key (and so the signatures) is fresh.
import { toJsonl, newSalt, type Fact } from '../../src/facts.ts';
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
