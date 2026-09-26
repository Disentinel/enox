// A deterministic synthetic log for performance checks: N facts in batches of
// B, written straight into a data dir as signed batches (the same files and
// index admission writes), without going through admission. The facts are the
// same on every run; the key (and so the signatures) is fresh.
import { toJsonl, newSalt, type Fact } from '../../src/facts.ts';
import { LocalIdentity } from '../../src/identity.ts';
import { Log } from '../../src/log.ts';

export function generateLog(dir: string, o: { facts: number; batch: number; name?: string; t0: number }): LocalIdentity {
  const me = LocalIdentity.create(dir, o.name ?? 'perf', new Date(o.t0 - 86_400_000));
  const log = new Log(dir);
  log.open();
  let prev: string | null = null;
  for (let b = 0; b * o.batch < o.facts; b++) {
    const facts: Fact[] = [];
    for (let i = b * o.batch; i < Math.min(o.facts, (b + 1) * o.batch); i++) {
      facts.push({ source: `enox://example.org/graph/main/d${i % 111}/e${i}`, relation: `rel${i % 85}`, target: `enox://example.org/graph/main/d${(i * 7) % 111}/e${(i * 7919) % o.facts}`,
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
