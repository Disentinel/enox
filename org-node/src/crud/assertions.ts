import type { Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { CreateAssertionSchema, UpdateAssertionSchema } from './validators.js';
import { computeFactId } from '../util.js';
import { searchSimilar } from '../embeddings.js';

const ASSERTION_RETURN =
  'RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.asserted_by AS asserted_by, r.confidence AS confidence, r.proof_depth AS proof_depth, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at';

export async function listAssertions(req: Request, res: Response) {
  const { source, target, relation, limit, offset } = req.query;
  let cypher = 'MATCH (a:Entity)-[r:Assertion]->(b:Entity) ';
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (source) {
    conditions.push('a.id = $source');
    params.source = source;
  }
  if (target) {
    conditions.push('b.id = $target');
    params.target = target;
  }
  if (relation) {
    conditions.push('r.relation = $relation');
    params.relation = relation;
  }

  if (conditions.length) {
    cypher += 'WHERE ' + conditions.join(' AND ') + ' ';
  }

  // Return node names for UI display
  cypher += 'RETURN r.fact_id AS fact_id, a.id AS source_id, a.name AS source_name, b.id AS target_id, b.name AS target_name, r.relation AS relation, r.asserted_by AS asserted_by, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at';
  cypher += ' ORDER BY r.updated_at DESC';

  const lim = Math.min(parseInt(limit as string) || 30, 500);
  const off = parseInt(offset as string) || 0;
  cypher += ` SKIP ${off} LIMIT ${lim}`;

  const rows = await queryAll(cypher, params);
  res.json(rows);
}

export async function getAssertion(req: Request, res: Response) {
  const { fact_id } = req.params;
  const row = await queryOne(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id ${ASSERTION_RETURN}`,
    { fact_id },
  );
  if (!row) {
    res.status(404).json({ error: 'Assertion not found' });
    return;
  }
  res.json(row);
}

export async function createAssertion(req: Request, res: Response) {
  const parsed = CreateAssertionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { source, target, relation, confidence, context } = parsed.data;
  const assertedBy = req.userId ?? 'system';

  // Verify both nodes exist
  const srcNode = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id: source });
  if (!srcNode) {
    res.status(400).json({ error: `Source node '${source}' not found` });
    return;
  }
  const tgtNode = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id: target });
  if (!tgtNode) {
    res.status(400).json({ error: `Target node '${target}' not found` });
    return;
  }

  const fact_id = computeFactId(source, relation, target);

  // Check for duplicate assertion
  const existing = await queryOne(
    'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
    { fact_id },
  );
  if (existing) {
    res.status(409).json({ error: 'Assertion already exists', fact_id });
    return;
  }

  const now = new Date().toISOString();

  await execute(
    `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
     CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $asserted_by, confidence: $confidence, proof_depth: $proof_depth, context: $context, created_at: $now, updated_at: $now}]->(b)`,
    {
      source,
      target,
      fact_id,
      relation,
      asserted_by: assertedBy,
      confidence,
      proof_depth: 0,
      context: context ?? '',
      now,
    },
  );

  res.status(201).json({
    fact_id,
    source,
    target,
    relation,
    asserted_by: assertedBy,
    confidence,
    proof_depth: 0,
    context: context ?? '',
    created_at: now,
    updated_at: now,
  });
}

export async function updateAssertion(req: Request, res: Response) {
  const { fact_id } = req.params;
  const parsed = UpdateAssertionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = await queryOne(
    'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
    { fact_id },
  );
  if (!existing) {
    res.status(404).json({ error: 'Assertion not found' });
    return;
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { fact_id };
  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      sets.push(`r.${key} = $${key}`);
      params[key] = value === null ? '' : value;
    }
  }
  sets.push('r.updated_at = $now');
  params.now = now;

  await execute(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id SET ${sets.join(', ')}`,
    params,
  );

  const updated = await queryOne(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id ${ASSERTION_RETURN}`,
    { fact_id },
  );
  res.json(updated);
}

export async function deleteAssertion(req: Request, res: Response) {
  const { fact_id } = req.params;
  const existing = await queryOne(
    'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
    { fact_id },
  );
  if (!existing) {
    res.status(404).json({ error: 'Assertion not found' });
    return;
  }

  await execute(
    'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id DELETE r',
    { fact_id },
  );
  res.status(204).end();
}

export async function traverseGraph(req: Request, res: Response) {
  const id = req.query.id as string;
  if (!id) { res.status(400).json({ error: 'id parameter required' }); return; }

  const maxDepth = Math.min(parseInt(req.query.max_depth as string) || 2, 3);
  const relation = req.query.relation as string | undefined;
  const direction = (req.query.direction as string) || 'both';
  const MAX_FRONTIER = 25;

  // Verify start node exists
  const startNode = await queryOne<{ id: string; name: string; type: string; domain: string }>(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain',
    { id },
  );
  if (!startNode) { res.status(404).json({ error: 'Node not found' }); return; }

  type EdgeRow = { src: string; src_name: string; tgt: string; tgt_name: string; tgt_type: string; relation: string; confidence: number; context: string };
  const visitedNodes = new Set<string>([id]);
  const allEdges: Array<EdgeRow & { depth: number }> = [];

  let frontier = [id];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;
    const nextFrontier: string[] = [];

    for (const nodeId of frontier.slice(0, MAX_FRONTIER)) {
      const relCond = relation ? ' AND r.relation = $relation' : '';
      const params: Record<string, unknown> = { id: nodeId };
      if (relation) params.relation = relation;

      if (direction === 'out' || direction === 'both') {
        const rows = await queryAll<EdgeRow>(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id${relCond}
           RETURN a.id AS src, a.name AS src_name, b.id AS tgt, b.name AS tgt_name, b.type AS tgt_type, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
          params,
        );
        for (const row of rows) {
          allEdges.push({ ...row, depth });
          if (!visitedNodes.has(row.tgt)) { visitedNodes.add(row.tgt); nextFrontier.push(row.tgt); }
        }
      }
      if (direction === 'in' || direction === 'both') {
        const rows = await queryAll<EdgeRow>(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id${relCond}
           RETURN a.id AS src, a.name AS src_name, b.id AS tgt, b.name AS tgt_name, b.type AS tgt_type, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
          params,
        );
        for (const row of rows) {
          allEdges.push({ ...row, depth });
          if (!visitedNodes.has(row.src)) { visitedNodes.add(row.src); nextFrontier.push(row.src); }
        }
      }
    }
    frontier = nextFrontier;
  }

  // Dedup edges
  const seen = new Set<string>();
  const edges = allEdges.filter(e => {
    const key = `${e.src}|${e.relation}|${e.tgt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json({ start: startNode, nodes_discovered: visitedNodes.size, edges_count: edges.length, edges });
}

export async function searchEdges(req: Request, res: Response) {
  const query = req.query.q as string;
  if (!query) { res.status(400).json({ error: 'q parameter required' }); return; }

  const topK = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const domain = req.query.domain as string | undefined;

  const similar = await searchSimilar(query, topK * 2);
  const results: Record<string, unknown>[] = [];

  for (const { id, score, match_type } of similar) {
    if (match_type !== 'assertion') continue;
    const factId = id.replace(/^assertion:/, '');
    const edge = await queryOne(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fid
       RETURN a.name AS source_name, a.id AS source_id, a.domain AS source_domain, b.name AS target_name, b.id AS target_id, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
      { fid: factId },
    );
    if (!edge) continue;
    const e = edge as Record<string, unknown>;
    if (domain && typeof e.source_domain === 'string' && !e.source_domain.startsWith(domain)) continue;
    results.push({ ...e, similarity: Math.round(score * 1000) / 1000 });
    if (results.length >= topK) break;
  }

  res.json(results);
}

export async function getNeighbors(req: Request, res: Response) {
  const id = (req.query.id as string) || req.params.id;
  const node = await queryOne(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.created_at AS created_at, e.updated_at AS updated_at',
    { id },
  );
  if (!node) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }

  const outgoing = await queryAll(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, b.name AS target_name, b.type AS target_type,
            r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
    { id },
  );

  const incoming = await queryAll(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, a.name AS source_name, a.type AS source_type, b.id AS target,
            r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
    { id },
  );

  res.json({ node, outgoing, incoming });
}
