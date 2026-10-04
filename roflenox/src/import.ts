// Import an Enox node's graph (r_import): the snapshot JSONL an Enox node
// writes (records with _type "node" | "edge") becomes signed batches of the
// IMPORTING identity — the only identity whose key is here. What Enox knew is
// kept as facts, the original authors included:
//
//   entity  {id, node_type, domain, label, description, aliases, source_ref}
//     → [id, enox:type, node_type], [id, enox:domain, …], [id, enox:label, …],
//       [id, enox:description, …], [id, enox:alias, a] per alias, [id, enox:source_ref, …]
//   edge    {from, rel, to, confidence, asserted_by, context, fact_id, created_at, proof_depth}
//     → [from, rel, to] with its confidence, and facts ABOUT that fact (F is
//       its roflenox fact_id): [F, enox:asserted_by, who], [F, enox:context, …],
//       [F, enox:created_at, …], [F, enox:fact_id, <the Enox id>], [F, enox:proof_depth, n]
//
// Perspective: the snapshot carries none, so every imported fact is asserted
// under "enox".
//
// REPEATABLE: the same input gives the same batches, byte for byte, and so the
// same digests. Records are sorted (entities by id, edges by from/rel/to/Enox
// fact id), facts are cut into batches of a fixed size, and each batch's salt
// is derived from the importing key and the batch content — an Ed25519
// signature is deterministic, and without the key the salt is as unguessable
// as a random one. A batch the node already holds is recognised by its digest
// and skipped, so importing twice leaves the log exactly as it was.
import { createHash } from 'node:crypto';
import { batchDigest, factId, toJsonl, type Fact } from './facts.ts';
import type { LocalIdentity } from './identity.ts';
import type { OpCaller } from './client.ts';

export const IMPORT_PERSPECTIVE = 'enox';
export const DEFAULT_IMPORT_BATCH = 2000;

interface EnoxNode { _type: 'node'; id: string; node_type?: string; domain?: string; label?: string; description?: string; aliases?: string[]; source_ref?: string }
interface EnoxEdge { _type: 'edge'; from: string; to: string; rel: string; confidence: number; asserted_by?: string; context?: string; fact_id?: string; created_at?: string; proof_depth?: number }

export interface ImportResult { entities: number; assertions: number; facts: number; collapsed: number; batches: number; admitted: number; skipped: number }

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The facts a snapshot stands for, in a fixed order, each triple once. */
export function snapshotFacts(text: string): { facts: Fact[]; entities: number; assertions: number; collapsed: number } {
  const recs = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as EnoxNode | EnoxEdge);
  const nodes = recs.filter((r): r is EnoxNode => r._type === 'node').sort((a, b) => cmp(a.id, b.id));
  const edges = recs.filter((r): r is EnoxEdge => r._type === 'edge')
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.rel, b.rel) || cmp(a.to, b.to) || cmp(a.fact_id ?? '', b.fact_id ?? ''));
  const out: Fact[] = [];
  const seen = new Set<string>();
  let collapsed = 0;
  const add = (source: string, relation: string, target: unknown, confidence = 1) => {
    if (typeof target === 'number') target = String(target);
    if (typeof target !== 'string' || target === '' || source === '' || relation === '') return false;
    const f: Fact = { source, relation, target, perspective: IMPORT_PERSPECTIVE, confidence: Math.min(1, Math.max(0, confidence)) };
    const id = factId(f);
    if (seen.has(id)) { collapsed++; return false; }
    seen.add(id);
    out.push(f);
    return true;
  };
  for (const n of nodes) {
    add(n.id, 'enox:type', n.node_type);
    add(n.id, 'enox:domain', n.domain);
    add(n.id, 'enox:label', n.label);
    add(n.id, 'enox:description', n.description);
    for (const a of [...(n.aliases ?? [])].sort(cmp)) add(n.id, 'enox:alias', a);
    add(n.id, 'enox:source_ref', n.source_ref);
    add(n.id, 'enox:created_at', (n as { created_at?: string }).created_at);
    add(n.id, 'enox:updated_at', (n as { updated_at?: string }).updated_at);
  }
  for (const e of edges) {
    add(e.from, e.rel, e.to, e.confidence);
    const F = factId({ source: e.from, relation: e.rel, target: e.to });
    // Facts about the fact: even when the triple was asserted twice, each
    // author and each Enox id is its own fact.
    add(F, 'enox:asserted_by', e.asserted_by);
    add(F, 'enox:fact_id', e.fact_id);
    add(F, 'enox:context', e.context);
    add(F, 'enox:created_at', e.created_at);
    add(F, 'enox:updated_at', (e as { updated_at?: string }).updated_at);
    add(F, 'enox:proof_depth', e.proof_depth);
  }
  return { facts: out, entities: nodes.length, assertions: edges.length, collapsed };
}

/** A batch's salt, derived from the importing key and the batch content. */
export function importSalt(me: LocalIdentity, jsonl: string): string {
  const sig = me.signBytes(Buffer.from(`roflenox-import-salt-v1\n${createHash('sha256').update(jsonl).digest('hex')}`));
  return createHash('sha256').update(sig).digest().toString('base64url');
}

/** Import a snapshot as `me` through the node's normal admission. */
export async function importEnox(node: OpCaller, me: LocalIdentity, text: string,
  o: { batchSize?: number; now?: () => number; handOff?: boolean } = {}): Promise<ImportResult> {
  const now = o.now ?? Date.now;
  const size = o.batchSize ?? DEFAULT_IMPORT_BATCH;
  const { facts, entities, assertions, collapsed } = snapshotFacts(text);
  if (o.handOff) {
    // The node is this identity's own and signs (r_single_writer): each batch
    // is handed to it, and it derives the same salt, so a re-import is known.
    let admitted = 0, skipped = 0, batches = 0;
    for (let i = 0; i < facts.length; i += size) {
      batches++;
      const r = await node('assert', { facts: facts.slice(i, i + size), import: true }) as { held?: boolean };
      if (r.held) skipped++; else admitted++;
    }
    return { entities, assertions, facts: facts.length, collapsed, batches, admitted, skipped };
  }
  // Every page of the chain (r_bounded_reads pages it).
  const held = new Set<string>();
  for (let cursor: string | undefined; ;) {
    const c = (await node('chain', { identity: me.name, ...(cursor !== undefined ? { cursor, limit: 10_000 } : { limit: 10_000 }) })) as { digests: string[]; cut?: boolean; cursor?: string };
    for (const d of c.digests) held.add(d);
    if (!c.cut) break;
    cursor = c.cursor;
  }
  let head = ((await node('health', {})) as { heads: Record<string, string> }).heads[me.name] ?? null;
  let admitted = 0, skipped = 0, batches = 0;
  for (let i = 0; i < facts.length; i += size) {
    batches++;
    const jsonl = toJsonl(facts.slice(i, i + size));
    const salt = importSalt(me, jsonl);
    if (held.has(batchDigest(salt, jsonl))) { skipped++; continue; }
    const manifest = me.signBatch(jsonl, head, new Date(now()).toISOString(), salt);
    await node('admit', { manifest, jsonl, salt, identity: me.identityChain() });
    head = manifest.digest;
    admitted++;
  }
  return { entities, assertions, facts: facts.length, collapsed, batches, admitted, skipped };
}
