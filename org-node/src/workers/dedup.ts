/**
 * Entity deduplication background worker.
 *
 * Algorithm:
 * 1. Load embedding store, find near-duplicate pairs (cosine similarity > threshold)
 * 2. Apply heuristic filters: same type, same/compatible domain, not already linked
 * 3. Deterministic merge for high-confidence pairs (slug match, alias overlap, sim > 0.95)
 * 4. Log all merges to dedup_log and activity_log for audit trail
 * 5. Take a backup snapshot before each merge batch
 *
 * Safety: conservative thresholds, pre-merge backup, full audit log, dry-run mode.
 */

import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { getSqlite } from '../db/sqlite.js';
import { searchSimilar } from '../embeddings.js';
import { materialize } from '../backup.js';
import { computeFactId } from '../util.js';
import { isLlmEnabled, runLlm } from '../llm.js';

// ── Configuration ────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.85;       // Minimum cosine similarity for candidate pairs
const AUTO_MERGE_THRESHOLD = 0.95;       // Auto-merge without review above this
const MAX_MERGES_PER_RUN = 10;           // Safety: limit merges per cycle
const MAX_LINKS_PER_RUN = 20;            // Max LLM-judged links per cycle
const TOP_NODES_PER_RUN = 200;           // Check top-N most-queried nodes per run

// ── Types ────────────────────────────────────────────────────────────────────

interface CandidatePair {
  id_a: string;
  id_b: string;
  name_a: string;
  name_b: string;
  type_a: string;
  type_b: string;
  domain_a: string;
  domain_b: string;
  aliases_a: string[];
  aliases_b: string[];
  similarity: number;
  reason: string;
}

interface MergeResult {
  canonical_id: string;
  merged_id: string;
  edges_moved: number;
  aliases_added: string[];
  reason: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function logActivity(actor: string, action: string, entityType: string, entityId: string, detail: unknown): void {
  const db = getSqlite();
  db.prepare(
    'INSERT INTO activity_log (actor, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)',
  ).run(actor, action, entityType, entityId, JSON.stringify(detail));
}

function logDedup(canonical: string, merged: string, similarity: number, reason: string, edgesMoved: number, aliasesAdded: string[], snapshotFile: string | null): void {
  const db = getSqlite();
  db.prepare(
    'INSERT INTO dedup_log (canonical_id, merged_id, similarity, merge_reason, edges_moved, aliases_added, snapshot_file) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(canonical, merged, similarity, reason, edgesMoved, JSON.stringify(aliasesAdded), snapshotFile);
}

// ── Step 1: Find candidate pairs ─────────────────────────────────────────────

async function findCandidatePairs(): Promise<CandidatePair[]> {
  const db = getSqlite();

  // Get nodes to check — prioritize by query_count, fall back to all
  const usageRows = db.prepare(
    'SELECT node_id FROM node_usage ORDER BY query_count DESC LIMIT ?',
  ).all(TOP_NODES_PER_RUN) as Array<{ node_id: string }>;

  // If no usage data yet, sample recent nodes
  let nodeIds: string[];
  if (usageRows.length > 0) {
    nodeIds = usageRows.map(r => r.node_id);
  } else {
    const recentNodes = await queryAll<{ id: string }>(
      'MATCH (e:Entity) RETURN e.id AS id ORDER BY e.updated_at DESC LIMIT 200',
    );
    nodeIds = recentNodes.map(n => n.id);
  }

  const candidates: CandidatePair[] = [];
  const seenPairs = new Set<string>();

  for (const nodeId of nodeIds) {
    // Find nearest neighbors via embedding
    const neighbors = await searchSimilar(nodeId, 5);

    // We need to search by the node's NAME, not its ID (embeddings are keyed by ID but encoded from name)
    // Actually, searchSimilar takes a text query — let's get the node name first
    const node = await queryOne<{ id: string; name: string; type: string; domain: string; aliases: string[] }>(
      'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.aliases AS aliases',
      { id: nodeId },
    );
    if (!node) continue;

    const similar = await searchSimilar(node.name, 6); // +1 because self will match

    for (const { id: neighborId, score, match_type } of similar) {
      if (match_type !== 'node') continue;
      if (neighborId === nodeId) continue;
      if (score < SIMILARITY_THRESHOLD) continue;

      // Deduplicate pair (order-independent)
      const pairKey = [nodeId, neighborId].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const neighbor = await queryOne<{ id: string; name: string; type: string; domain: string; aliases: string[] }>(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.aliases AS aliases',
        { id: neighborId },
      );
      if (!neighbor) continue;

      candidates.push({
        id_a: nodeId,
        id_b: neighborId,
        name_a: node.name,
        name_b: neighbor.name,
        type_a: node.type,
        type_b: neighbor.type,
        domain_a: node.domain,
        domain_b: neighbor.domain,
        aliases_a: node.aliases || [],
        aliases_b: neighbor.aliases || [],
        similarity: score,
        reason: '',
      });
    }
  }

  return candidates;
}

// ── Step 2: Apply heuristic filters ──────────────────────────────────────────

interface FilterResult {
  mergeable: CandidatePair[];
  linkable: CandidatePair[];   // Similar but not duplicates — candidates for LLM-judged linking
}

async function filterCandidates(candidates: CandidatePair[]): Promise<FilterResult> {
  const mergeable: CandidatePair[] = [];
  const linkable: CandidatePair[] = [];

  for (const pair of candidates) {
    // Must be same type
    if (pair.type_a !== pair.type_b) continue;

    // Must be same domain or one is generic
    const GENERIC_DOMAINS = new Set(['memory', 'general', 'cs', '']);
    if (pair.domain_a !== pair.domain_b && !GENERIC_DOMAINS.has(pair.domain_a) && !GENERIC_DOMAINS.has(pair.domain_b)) continue;

    // Must NOT already be linked by an assertion (if they are, they're intentionally distinct)
    const existingEdge = await queryOne(
      `MATCH (a:Entity)-[r:Assertion]-(b:Entity) WHERE a.id = $a AND b.id = $b RETURN r.fact_id AS fid LIMIT 1`,
      { a: pair.id_a, b: pair.id_b },
    );
    if (existingEdge) continue;

    // Determine merge reason
    const slug_a = slugify(pair.name_a);
    const slug_b = slugify(pair.name_b);

    if (slug_a === slug_b) {
      pair.reason = `slug_match: "${slug_a}"`;
      mergeable.push(pair);
    } else if (pair.aliases_a.some(a => a.toLowerCase() === pair.name_b.toLowerCase()) ||
               pair.aliases_b.some(a => a.toLowerCase() === pair.name_a.toLowerCase())) {
      pair.reason = 'alias_match';
      mergeable.push(pair);
    } else if (pair.similarity >= AUTO_MERGE_THRESHOLD) {
      pair.reason = `high_similarity: ${pair.similarity.toFixed(3)}`;
      mergeable.push(pair);
    } else {
      // Not a duplicate, but semantically similar and unlinked — candidate for LLM judge
      pair.reason = `similar: ${pair.similarity.toFixed(3)}`;
      linkable.push(pair);
    }
  }

  return { mergeable, linkable };
}

// ── Step 2b: LLM Judge for link suggestions ──────────────────────────────────

// Schemaless: any non-empty relation string is accepted.
const isValidRelation = (rel: unknown): rel is string => typeof rel === 'string' && rel.trim().length > 0;

interface LinkJudgement {
  source: string;       // node ID
  target: string;       // node ID
  relation: string;     // relation type
  confidence: number;
  context: string;      // LLM's reasoning
}

async function judgeLinkCandidates(pairs: CandidatePair[]): Promise<LinkJudgement[]> {
  if (pairs.length === 0) return [];

  // Build batch prompt — send all pairs at once for efficiency
  const pairDescriptions = pairs.map((p, i) =>
    `${i + 1}. "${p.name_a}" (${p.type_a}, ${p.domain_a}) ↔ "${p.name_b}" (${p.type_b}, ${p.domain_b})`
  ).join('\n');

  const relationList = [
    'part_of', 'subclass_of', 'instance_of', 'extends', 'supersedes',
    'depends_on', 'enables', 'alternative_to', 'related_to', 'builds_on',
    'equivalent_to', 'generalizes', 'technique_for', 'application_of',
  ].join(', ');

  const prompt = `You are a knowledge graph curator. For each pair of semantically similar entities below, decide:
1. Should they be linked? Only if the link helps navigate the graph (skip trivially obvious or unhelpful links).
2. If yes, what relation type and direction?

Available relation types: ${relationList}

Pairs:
${pairDescriptions}

Respond with ONLY a JSON array. Each element: {"pair": <1-based index>, "relation": "<type>", "direction": "a→b" or "b→a", "confidence": 0.0-1.0, "reason": "<brief>"}
For pairs that should NOT be linked, omit them from the array.
Return [] if none should be linked.`;

  try {
    // LLM-judged linking is opt-in. When no LLM is configured the dedup worker
    // still does its deterministic embedding-based merges; it just skips the
    // generative link-suggestion step. Never spawns `claude` implicitly.
    const raw = runLlm(prompt, { feature: 'LLM-judged dedup linking', model: 'haiku' }).trim();

    // Extract JSON array from response
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const judgements = JSON.parse(jsonMatch[0]) as Array<{
      pair: number;
      relation: string;
      direction: string;
      confidence: number;
      reason: string;
    }>;

    const results: LinkJudgement[] = [];
    for (const j of judgements) {
      const idx = j.pair - 1;
      if (idx < 0 || idx >= pairs.length) continue;
      if (!isValidRelation(j.relation)) continue;
      if (j.confidence < 0.5) continue;

      const pair = pairs[idx];
      const isAtoB = j.direction !== 'b→a';

      results.push({
        source: isAtoB ? pair.id_a : pair.id_b,
        target: isAtoB ? pair.id_b : pair.id_a,
        relation: j.relation,
        confidence: Math.min(j.confidence, 1.0),
        context: `auto-linked by dedup worker (LLM judge): ${j.reason}`,
      });
    }

    return results;
  } catch (err) {
    console.error('[dedup] LLM judge failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function createLinks(links: LinkJudgement[]): Promise<number> {
  let created = 0;
  for (const link of links) {
    try {
      const factId = computeFactId(link.source, link.relation, link.target);

      // Check not already exists
      const existing = await queryOne(
        'MATCH ()-[r:Assertion]->() WHERE r.fact_id = $fid RETURN r.fact_id AS fid',
        { fid: factId },
      );
      if (existing) continue;

      const now = new Date().toISOString();
      await execute(
        `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
         CREATE (a)-[:Assertion {fact_id: $fid, relation: $rel, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $now, updated_at: $now}]->(b)`,
        { source: link.source, target: link.target, fid: factId, rel: link.relation, by: 'dedup_worker', conf: link.confidence, pd: 0, ctx: link.context, now },
      );

      logActivity('dedup_worker', 'auto_link', 'assertion', factId, {
        source: link.source,
        target: link.target,
        relation: link.relation,
        confidence: link.confidence,
        context: link.context,
      });

      created++;
    } catch (err) {
      console.error(`[dedup] Failed to create link ${link.source} → ${link.target}:`, err);
    }
  }
  return created;
}

// ── Step 3: Execute merge ────────────────────────────────────────────────────

async function executeMerge(pair: CandidatePair): Promise<MergeResult> {
  // Decide canonical node: the one with more connections wins
  const countA = await queryOne<{ cnt: number }>(
    'MATCH (e:Entity)-[r:Assertion]-() WHERE e.id = $id RETURN count(r) AS cnt',
    { id: pair.id_a },
  );
  const countB = await queryOne<{ cnt: number }>(
    'MATCH (e:Entity)-[r:Assertion]-() WHERE e.id = $id RETURN count(r) AS cnt',
    { id: pair.id_b },
  );

  const edgesA = countA?.cnt ?? 0;
  const edgesB = countB?.cnt ?? 0;

  const [canonicalId, mergedId, canonicalName, mergedName, mergedAliases] =
    edgesA >= edgesB
      ? [pair.id_a, pair.id_b, pair.name_a, pair.name_b, pair.aliases_b]
      : [pair.id_b, pair.id_a, pair.name_b, pair.name_a, pair.aliases_a];

  // Move outgoing edges from merged → canonical
  const outgoing = await queryAll<{ fact_id: string; target: string; relation: string; confidence: number; context: string; created_at: string; updated_at: string; asserted_by: string; proof_depth: number }>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $mid
     RETURN r.fact_id AS fact_id, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at, r.asserted_by AS asserted_by, r.proof_depth AS proof_depth`,
    { mid: mergedId },
  );

  let edgesMoved = 0;
  for (const edge of outgoing) {
    if (edge.target === canonicalId) continue; // Don't create self-edge

    // Check if canonical already has this edge
    const exists = await queryOne(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $cid AND b.id = $tid AND r.relation = $rel RETURN r.fact_id AS fid`,
      { cid: canonicalId, tid: edge.target, rel: edge.relation },
    );
    if (!exists) {
      await execute(
        `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
         CREATE (a)-[:Assertion {fact_id: $fid, relation: $rel, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $cat, updated_at: $uat}]->(b)`,
        { source: canonicalId, target: edge.target, fid: edge.fact_id + '_moved', rel: edge.relation, by: edge.asserted_by, conf: edge.confidence, pd: edge.proof_depth, ctx: edge.context, cat: edge.created_at, uat: edge.updated_at },
      );
      edgesMoved++;
    }
  }

  // Move incoming edges
  const incoming = await queryAll<{ fact_id: string; source: string; relation: string; confidence: number; context: string; created_at: string; updated_at: string; asserted_by: string; proof_depth: number }>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $mid
     RETURN r.fact_id AS fact_id, a.id AS source, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at, r.asserted_by AS asserted_by, r.proof_depth AS proof_depth`,
    { mid: mergedId },
  );

  for (const edge of incoming) {
    if (edge.source === canonicalId) continue;

    const exists = await queryOne(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $sid AND b.id = $cid AND r.relation = $rel RETURN r.fact_id AS fid`,
      { sid: edge.source, cid: canonicalId, rel: edge.relation },
    );
    if (!exists) {
      await execute(
        `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
         CREATE (a)-[:Assertion {fact_id: $fid, relation: $rel, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $cat, updated_at: $uat}]->(b)`,
        { source: edge.source, target: canonicalId, fid: edge.fact_id + '_moved', rel: edge.relation, by: edge.asserted_by, conf: edge.confidence, pd: edge.proof_depth, ctx: edge.context, cat: edge.created_at, uat: edge.updated_at },
      );
      edgesMoved++;
    }
  }

  // Add merged node's name as alias on canonical (if not already there)
  const canonical = await queryOne<{ aliases: string[] }>(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.aliases AS aliases',
    { id: canonicalId },
  );
  const existingAliases = canonical?.aliases || [];
  const newAliases: string[] = [];

  if (mergedName !== canonicalName && !existingAliases.includes(mergedName)) {
    newAliases.push(mergedName);
  }
  for (const a of mergedAliases) {
    if (!existingAliases.includes(a) && a !== canonicalName) {
      newAliases.push(a);
    }
  }

  if (newAliases.length > 0) {
    const allAliases = [...existingAliases, ...newAliases];
    await execute(
      'MATCH (e:Entity) WHERE e.id = $id SET e.aliases = $aliases, e.updated_at = $now',
      { id: canonicalId, aliases: allAliases, now: new Date().toISOString() },
    );
  }

  // Delete merged node (DETACH DELETE removes all remaining edges)
  await execute(
    'MATCH (e:Entity) WHERE e.id = $id DETACH DELETE e',
    { id: mergedId },
  );

  return {
    canonical_id: canonicalId,
    merged_id: mergedId,
    edges_moved: edgesMoved,
    aliases_added: newAliases,
    reason: pair.reason,
  };
}

// ── Main worker entry point ──────────────────────────────────────────────────

let dedupRunning = false;
let dedupInterval: ReturnType<typeof setInterval> | null = null;

export async function runDedupCycle(): Promise<{ candidates: number; merged: number; linked: number; results: MergeResult[] }> {
  if (dedupRunning) return { candidates: 0, merged: 0, linked: 0, results: [] };
  dedupRunning = true;

  try {
    // Step 1: Find candidates
    const allCandidates = await findCandidatePairs();
    console.log(`[dedup] Found ${allCandidates.length} candidate pairs`);

    if (allCandidates.length === 0) {
      return { candidates: 0, merged: 0, linked: 0, results: [] };
    }

    // Step 2: Filter into mergeable vs linkable
    const { mergeable, linkable } = await filterCandidates(allCandidates);
    console.log(`[dedup] ${mergeable.length} mergeable, ${linkable.length} linkable`);

    // Step 3: Take pre-change backup (if any work to do)
    let snapshotFile: string | null = null;
    if (mergeable.length > 0 || linkable.length > 0) {
      try {
        const snapshot = await materialize();
        snapshotFile = snapshot.file;
        console.log(`[dedup] Pre-change backup: ${snapshot.file} (${snapshot.nodes} nodes, ${snapshot.edges} edges)`);
      } catch (err) {
        console.error('[dedup] Failed to take backup, aborting cycle:', err);
        return { candidates: allCandidates.length, merged: 0, linked: 0, results: [] };
      }
    }

    // Step 4: Execute merges (limited per run)
    const toMerge = mergeable.slice(0, MAX_MERGES_PER_RUN);
    const results: MergeResult[] = [];

    for (const pair of toMerge) {
      try {
        console.log(`[dedup] Merging: "${pair.name_b}" → "${pair.name_a}" (${pair.reason})`);

        const result = await executeMerge(pair);
        results.push(result);

        logDedup(result.canonical_id, result.merged_id, pair.similarity, result.reason, result.edges_moved, result.aliases_added, snapshotFile);
        logActivity('dedup_worker', 'merge_entity', 'entity', result.merged_id, {
          canonical_id: result.canonical_id,
          similarity: pair.similarity,
          reason: result.reason,
          edges_moved: result.edges_moved,
          aliases_added: result.aliases_added,
          pre_merge_snapshot: snapshotFile,
        });

        console.log(`[dedup] Merged: ${result.merged_id} → ${result.canonical_id} (${result.edges_moved} edges moved, ${result.aliases_added.length} aliases added)`);
      } catch (err) {
        console.error(`[dedup] Failed to merge ${pair.id_b} → ${pair.id_a}:`, err);
        logActivity('dedup_worker', 'merge_failed', 'entity', pair.id_b, {
          target: pair.id_a,
          error: String(err),
        });
      }
    }

    // Step 5: LLM Judge for linkable pairs — OPT-IN. The deterministic merges
    // above (slug / alias / high-similarity) ran with no LLM. The generative
    // link-suggestion step only runs when an LLM is explicitly configured.
    let linked = 0;
    const toLinkJudge = linkable.slice(0, MAX_LINKS_PER_RUN);
    if (toLinkJudge.length > 0) {
      if (!isLlmEnabled()) {
        console.log(
          `[dedup] ${toLinkJudge.length} link candidate(s) skipped — LLM-judged linking is opt-in ` +
            `(set LLM_INGEST_ENABLED=1 and LLM_CMD to enable). Deterministic merges still applied.`,
        );
      } else {
        console.log(`[dedup] Running LLM judge on ${toLinkJudge.length} link candidates...`);
        const judgements = await judgeLinkCandidates(toLinkJudge);
        console.log(`[dedup] LLM judge suggested ${judgements.length} links`);

        if (judgements.length > 0) {
          linked = await createLinks(judgements);
          console.log(`[dedup] Created ${linked} new links`);
        }
      }
    }

    // Summary audit log
    if (results.length > 0 || linked > 0) {
      logActivity('dedup_worker', 'dedup_cycle_complete', 'system', 'dedup', {
        candidates: allCandidates.length,
        mergeable: mergeable.length,
        merged: results.length,
        link_candidates: linkable.length,
        links_created: linked,
        snapshot: snapshotFile,
      });
    }

    return { candidates: allCandidates.length, merged: results.length, linked, results };
  } finally {
    dedupRunning = false;
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function startDedupWorker(intervalMs = 60 * 60 * 1000): void {
  // First run after 2 minutes (let embeddings load first)
  setTimeout(async () => {
    try {
      const result = await runDedupCycle();
      if (result.merged > 0 || result.linked > 0) {
        console.log(`[dedup] Cycle done: ${result.merged} merges, ${result.linked} links from ${result.candidates} candidates`);
      }
    } catch (err) {
      console.error('[dedup] Worker error:', err);
    }
  }, 2 * 60_000);

  dedupInterval = setInterval(async () => {
    try {
      const result = await runDedupCycle();
      if (result.merged > 0 || result.linked > 0) {
        console.log(`[dedup] Cycle done: ${result.merged} merges, ${result.linked} links from ${result.candidates} candidates`);
      }
    } catch (err) {
      console.error('[dedup] Worker error:', err);
    }
  }, intervalMs);
}

export function stopDedupWorker(): void {
  if (dedupInterval) clearInterval(dedupInterval);
}
