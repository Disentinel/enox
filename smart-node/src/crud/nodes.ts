import type { Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db.js';
import { CreateNodeSchema, UpdateNodeSchema } from './validators.js';
import { ENTITY_URI_PREFIX } from '../types.js';

const ENTITY_COLS = 'e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.created_at AS created_at, e.updated_at AS updated_at';

function makeEntityId(domain: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${ENTITY_URI_PREFIX}/${domain}/${slug}`;
}

export async function listNodes(req: Request, res: Response) {
  const { type, domain, q } = req.query;
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
