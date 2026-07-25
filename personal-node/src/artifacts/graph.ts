// Graph-side operations for artifacts: the artifact's own Entity node (type
// 'artifact') and the Assertion edges it carries into the graph. Two
// independent edge sets are tracked by distinct `asserted_by` provenance
// tags so re-materializing one never clobbers the other:
//   - OKF-materialized edges (parsed out of a markdown body's Relations
//     section) -> asserted_by = `artifact:<id>:okf`
//   - explicit `links` the caller passed in the request              -> asserted_by = `artifact:<id>:link`
// Both are idempotent: re-running delete-then-recreate against the current
// desired set is safe and is how PUT stays consistent (see handlers.ts).
import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { ENTITY_URI_PREFIX, RELATION_TYPES } from '../types.js';
import { computeFactId } from '../util.js';
import type { ParsedOkfEdge } from './okf.js';
import type { ArtifactLinkInput } from './validators.js';

const VALID_RELATIONS = new Set<string>(RELATION_TYPES);

export function okfProvenance(id: string): string {
  return `artifact:${id}:okf`;
}

export function linkProvenance(id: string): string {
  return `artifact:${id}:link`;
}

export function artifactEntityId(domain: string, id: string): string {
  return `${ENTITY_URI_PREFIX}/${domain}/artifact-${id}`;
}

export interface ArtifactNode {
  id: string;
  type: string;
  domain: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

const NODE_COLS =
  'e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.created_at AS created_at, e.updated_at AS updated_at';

export async function createArtifactEntity(entityId: string, domain: string, title: string, description: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
    { id: entityId, type: 'artifact', domain, name: title, description, aliases: [], now },
  );
}

export async function updateArtifactEntity(entityId: string, updates: { title?: string; domain?: string; description?: string }): Promise<void> {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: entityId };
  if (updates.title !== undefined) { sets.push('e.name = $name'); params.name = updates.title; }
  if (updates.domain !== undefined) { sets.push('e.domain = $domain'); params.domain = updates.domain; }
  if (updates.description !== undefined) { sets.push('e.description = $description'); params.description = updates.description; }
  if (sets.length === 0) return;
  sets.push('e.updated_at = $now');
  params.now = new Date().toISOString();
  await execute(`MATCH (e:Entity) WHERE e.id = $id SET ${sets.join(', ')}`, params);
}

export async function getArtifactEntity(entityId: string): Promise<ArtifactNode | null> {
  return queryOne<ArtifactNode>(`MATCH (e:Entity) WHERE e.id = $id RETURN ${NODE_COLS}`, { id: entityId });
}

export async function deleteArtifactEntity(entityId: string): Promise<void> {
  // DETACH DELETE removes the node and every edge touching it (both the
  // provenance-tagged edges below and any incoming edge another entity might
  // have created toward this artifact via the generic assertions API) — the
  // graph stays clean with a single call.
  await execute('MATCH (e:Entity) WHERE e.id = $id DETACH DELETE e', { id: entityId });
}

export async function deleteEdgesByProvenance(sourceId: string, provenance: string): Promise<void> {
  await execute(
    'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $source AND r.asserted_by = $prov DELETE r',
    { source: sourceId, prov: provenance },
  );
}

export interface EdgeCreationResult {
  created: number;
  skipped: Array<{ relation: string; target: string; reason: string }>;
}

async function entityExists(id: string): Promise<boolean> {
  const row = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id });
  return !!row;
}

// Shared by both edge sets: for each candidate edge, verify the relation is
// known and the target node exists, then create if not already present
// (idempotent — matters because callers delete-then-recreate the full
// provenance-tagged set, but a target might already be linked to via a
// different unrelated assertion sharing the same fact_id triple).
async function createEdges(
  sourceId: string,
  provenance: string,
  candidates: Array<{ relation: string; target: string; confidence: number; context: string }>,
): Promise<EdgeCreationResult> {
  const result: EdgeCreationResult = { created: 0, skipped: [] };
  const now = new Date().toISOString();

  for (const c of candidates) {
    if (!VALID_RELATIONS.has(c.relation)) {
      result.skipped.push({ relation: c.relation, target: c.target, reason: 'unknown_relation' });
      continue;
    }
    if (!(await entityExists(c.target))) {
      result.skipped.push({ relation: c.relation, target: c.target, reason: 'target_not_found' });
      continue;
    }

    const fact_id = computeFactId(sourceId, c.relation, c.target);
    const existing = await queryOne(
      'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
      { fact_id },
    );
    if (existing) continue; // already linked (possibly by a prior identical materialization) — not a failure

    await execute(
      `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
       CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $prov, confidence: $confidence, proof_depth: $pd, context: $context, created_at: $now, updated_at: $now}]->(b)`,
      { source: sourceId, target: c.target, fact_id, relation: c.relation, prov: provenance, confidence: c.confidence, pd: 0, context: c.context, now },
    );
    result.created++;
  }

  return result;
}

export async function materializeOkfEdges(sourceId: string, id: string, edges: ParsedOkfEdge[]): Promise<EdgeCreationResult> {
  const provenance = okfProvenance(id);
  await deleteEdgesByProvenance(sourceId, provenance);
  return createEdges(sourceId, provenance, edges.map(e => ({
    relation: e.relation, target: e.target, confidence: e.confidence, context: e.context,
  })));
}

export async function materializeExplicitLinks(sourceId: string, id: string, links: ArtifactLinkInput[]): Promise<EdgeCreationResult> {
  const provenance = linkProvenance(id);
  await deleteEdgesByProvenance(sourceId, provenance);
  return createEdges(sourceId, provenance, links.map(l => ({
    relation: l.relation, target: l.entity_id, confidence: 1.0, context: '',
  })));
}

export interface ArtifactEdgeRow {
  fact_id: string;
  source: string;
  target: string;
  target_name?: string;
  source_name?: string;
  relation: string;
  confidence: number;
  context: string;
  asserted_by: string;
}

export async function getArtifactEdges(entityId: string): Promise<{ outgoing: ArtifactEdgeRow[]; incoming: ArtifactEdgeRow[] }> {
  const outgoing = await queryAll<ArtifactEdgeRow>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, b.name AS target_name,
            r.relation AS relation, r.confidence AS confidence, r.context AS context, r.asserted_by AS asserted_by`,
    { id: entityId },
  );
  const incoming = await queryAll<ArtifactEdgeRow>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, a.name AS source_name, b.id AS target,
            r.relation AS relation, r.confidence AS confidence, r.context AS context, r.asserted_by AS asserted_by`,
    { id: entityId },
  );
  return { outgoing, incoming };
}
