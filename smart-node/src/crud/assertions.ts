import type { Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db.js';
import { CreateAssertionSchema, UpdateAssertionSchema } from './validators.js';
import { computeFactId } from '../util.js';

const ASSERTION_RETURN =
  'RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.asserted_by AS asserted_by, r.confidence AS confidence, r.proof_depth AS proof_depth, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at';

export async function listAssertions(req: Request, res: Response) {
  const { source, target, relation } = req.query;
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

  cypher += ASSERTION_RETURN;

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
      asserted_by: 'vadim',
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
    asserted_by: 'vadim',
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

export async function getNeighbors(req: Request, res: Response) {
  const id = (req.query.id as string) || req.params.id;
  const existing = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id });
  if (!existing) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }

  const outgoing = await queryAll(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context, 'outgoing' AS direction`,
    { id },
  );

  const incoming = await queryAll(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id
     RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context, 'incoming' AS direction`,
    { id },
  );

  res.json([...outgoing, ...incoming]);
}
