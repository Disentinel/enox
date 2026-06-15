import type { Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { CreateNodeSchema, UpdateNodeSchema } from './validators.js';
import { ENTITY_URI_PREFIX } from '../types.js';
import { searchSimilar } from '../embeddings.js';

const ENTITY_COLS = 'e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.created_at AS created_at, e.updated_at AS updated_at';

function makeEntityId(domain: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${ENTITY_URI_PREFIX}/${domain}/${slug}`;
}

export async function listNodes(req: Request, res: Response) {
  const { type, domain, q, limit, offset } = req.query;
  let cypher = 'MATCH (e:Entity) ';
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (type) {
    conditions.push('e.type = $type');
    params.type = type;
  }
  if (domain) {
    conditions.push('e.domain = $domain');
    params.domain = domain;
  }
  if (q) {
    conditions.push('lower(e.name) CONTAINS lower($q)');
    params.q = q;
  }

  if (conditions.length) {
    cypher += 'WHERE ' + conditions.join(' AND ') + ' ';
  }

  cypher += `RETURN ${ENTITY_COLS}`;
  cypher += ' ORDER BY e.updated_at DESC';

  const lim = Math.min(parseInt(limit as string) || 500, 5000);
  const off = parseInt(offset as string) || 0;
  cypher += ` SKIP ${off} LIMIT ${lim}`;

  const rows = await queryAll(cypher, params);
  res.json(rows);
}

export async function getNode(req: Request, res: Response) {
  const id = (req.query.id as string) || req.params.id;
  const row = await queryOne(
    `MATCH (e:Entity) WHERE e.id = $id RETURN ${ENTITY_COLS}`,
    { id },
  );
  if (!row) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }
  res.json(row);
}

export async function createNode(req: Request, res: Response) {
  const parsed = CreateNodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { type, domain, name, description, aliases } = parsed.data;
  const id = makeEntityId(domain, name);
  const now = new Date().toISOString();

  // Check for existing entity with same URI
  const existing = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id });
  if (existing) {
    res.status(409).json({ error: 'Entity already exists', id });
    return;
  }

  await execute(
    'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
    { id, type, domain, name, description: description ?? '', aliases, now },
  );

  res.status(201).json({ id, type, domain, name, description: description ?? '', aliases, created_at: now, updated_at: now });
}

export async function updateNode(req: Request, res: Response) {
  const id = (req.query.id as string) || req.params.id;
  const parsed = UpdateNodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = await queryOne(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
    { id },
  );
  if (!existing) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }

  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      sets.push(`e.${key} = $${key}`);
      params[key] = value === null ? '' : value;
    }
  }
  sets.push('e.updated_at = $now');
  params.now = now;

  await execute(
    `MATCH (e:Entity) WHERE e.id = $id SET ${sets.join(', ')}`,
    params,
  );

  const updated = await queryOne(
    `MATCH (e:Entity) WHERE e.id = $id RETURN ${ENTITY_COLS}`,
    { id },
  );
  res.json(updated);
}

export async function deleteNode(req: Request, res: Response) {
  const id = (req.query.id as string) || req.params.id;
  const existing = await queryOne(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
    { id },
  );
  if (!existing) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }

  await execute('MATCH (e:Entity) WHERE e.id = $id DETACH DELETE e', { id });
  res.status(204).end();
}

// GET /api/nodes/similar?query=<text>&limit=10&type=task&domain=kami&threshold=0.5
// Returns [{score, id, type, domain, name, description, ...}] sorted by score desc.
// Only returns node results (not assertion embeddings).
export async function similarNodes(req: Request, res: Response) {
  const { query, type, domain, limit, threshold } = req.query;
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'query param required' });
    return;
  }

  const topK = Math.min(parseInt(limit as string) || 20, 100);
  const minScore = parseFloat(threshold as string) || 0.0;

  const similar = await searchSimilar(query, topK * 5); // over-fetch to allow filtering
  const nodeResults = similar.filter(r => r.match_type === 'node' && r.score >= minScore);

  if (nodeResults.length === 0) {
    res.json([]);
    return;
  }

  // Fetch node data for matched IDs
  const ids = nodeResults.slice(0, topK).map(r => r.id);
  // Build IN-style query with individual params
  const paramEntries = ids.map((id, i) => [`id${i}`, id] as [string, string]);
  const params: Record<string, string> = Object.fromEntries(paramEntries);
  const idList = paramEntries.map(([k]) => `$${k}`).join(', ');
  const cypher = `MATCH (e:Entity) WHERE e.id IN [${idList}]${type ? ' AND e.type = $type' : ''}${domain ? ' AND e.domain = $domain' : ''} RETURN ${ENTITY_COLS}`;
  if (type) params['type'] = type as string;
  if (domain) params['domain'] = domain as string;

  const rows = await queryAll<Record<string, unknown>>(cypher, params);

  // Join scores back to rows
  const scoreMap = new Map(nodeResults.map(r => [r.id, r.score]));
  const withScores = rows
    .map(row => ({ score: scoreMap.get(row.id as string) ?? 0, ...row }))
    .filter(row => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  res.json(withScores);
}
