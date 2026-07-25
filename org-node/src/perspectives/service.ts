import { getSqlite } from '../db/sqlite.js';

export interface PerspectiveRow {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  node_types: string[];
  relation_types: string[];
  domains: string[] | null;
  chunk_size: number;
  chunk_overlap: number;
  llm_model: string;
  temperature: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface PerspectiveRawRow {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  node_types: string;
  relation_types: string;
  domains: string | null;
  chunk_size: number;
  chunk_overlap: number;
  llm_model: string;
  temperature: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function parseRow(raw: PerspectiveRawRow): PerspectiveRow {
  return {
    ...raw,
    node_types: JSON.parse(raw.node_types) as string[],
    relation_types: JSON.parse(raw.relation_types) as string[],
    domains: raw.domains ? (JSON.parse(raw.domains) as string[]) : null,
    enabled: raw.enabled === 1,
  };
}

export function listPerspectives(filters?: { enabled?: boolean }): PerspectiveRow[] {
  const db = getSqlite();

  let sql = 'SELECT * FROM perspectives';
  const params: unknown[] = [];

  if (filters?.enabled !== undefined) {
    sql += ' WHERE enabled = ?';
    params.push(filters.enabled ? 1 : 0);
  }

  sql += ' ORDER BY created_at ASC';

  const rows = db.prepare(sql).all(...params) as PerspectiveRawRow[];
  return rows.map(parseRow);
}

export function getPerspective(id: string): PerspectiveRow | null {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM perspectives WHERE id = ?').get(id) as PerspectiveRawRow | undefined;
  return row ? parseRow(row) : null;
}

export function createPerspective(input: {
  id: string;
  name: string;
  description?: string;
  system_prompt: string;
  node_types: string[];
  relation_types: string[];
  domains?: string[];
  chunk_size: number;
  chunk_overlap: number;
  llm_model: string;
  temperature: number;
  enabled: boolean;
}): PerspectiveRow {
  const db = getSqlite();

  try {
    db.prepare(`
      INSERT INTO perspectives (id, name, description, system_prompt, node_types, relation_types, domains, chunk_size, chunk_overlap, llm_model, temperature, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.name,
      input.description ?? null,
      input.system_prompt,
      JSON.stringify(input.node_types),
      JSON.stringify(input.relation_types),
      input.domains ? JSON.stringify(input.domains) : null,
      input.chunk_size,
      input.chunk_overlap,
      input.llm_model,
      input.temperature,
      input.enabled ? 1 : 0,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      const conflict = new Error(`Perspective "${input.id}" already exists`);
      (conflict as any).code = 'SQLITE_CONSTRAINT';
      throw conflict;
    }
    throw err;
  }

  return getPerspective(input.id)!;
}

export function updatePerspective(
  id: string,
  input: Partial<{
    name: string;
    description: string;
    system_prompt: string;
    node_types: string[];
    relation_types: string[];
    domains: string[];
    chunk_size: number;
    chunk_overlap: number;
    llm_model: string;
    temperature: number;
    enabled: boolean;
  }>,
): PerspectiveRow | null {
  const db = getSqlite();

  const existing = db.prepare('SELECT id FROM perspectives WHERE id = ?').get(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;

    if (key === 'node_types' || key === 'relation_types' || key === 'domains') {
      sets.push(`${key} = ?`);
      params.push(JSON.stringify(value));
    } else if (key === 'enabled') {
      sets.push(`${key} = ?`);
      params.push(value ? 1 : 0);
    } else {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (sets.length === 0) {
    return getPerspective(id);
  }

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE perspectives SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  return getPerspective(id);
}

export function deletePerspective(id: string): boolean {
  const db = getSqlite();
  const now = new Date().toISOString();
  const result = db.prepare(
    'UPDATE perspectives SET enabled = 0, updated_at = ? WHERE id = ?',
  ).run(now, id);
  return result.changes > 0;
}

const DEFAULT_PERSPECTIVES = [
  {
    id: 'knowledge',
    name: 'Knowledge Extraction',
    description: 'Extract concepts, decisions, patterns, and their relationships',
    system_prompt:
      'Extract knowledge entities and their relationships from the following text. Output JSON with entities and relations arrays.',
    node_types: ['concept', 'decision', 'component', 'pattern', 'rejected_alternative'],
    relation_types: [
      'depends_on',
      'supersedes',
      'implements',
      'contradicts',
      'part_of',
      'extends',
      'enables',
      'isomorphic_to',
    ],
  },
  {
    id: 'temporal',
    name: 'Temporal Events',
    description: 'Extract events, dates, and temporal relationships',
    system_prompt:
      'Extract temporal events and date relationships from the following text. Output JSON with entities and relations arrays.',
    node_types: ['date', 'event', 'decision'],
    relation_types: [
      'decided_on',
      'discussed_on',
      'changed_on',
      'created_on',
      'preceded_by',
      'triggered_by',
    ],
  },
  {
    id: 'opinions',
    name: 'Opinions & Preferences',
    description: 'Extract personal opinions, beliefs, and value judgments',
    system_prompt:
      'Extract opinions, preferences, and value judgments from the following text. Output JSON with entities and relations arrays.',
    node_types: ['opinion', 'preference', 'value', 'belief'],
    relation_types: [
      'prefers',
      'distrusts',
      'values',
      'rejects',
      'believes',
      'frustrated_by',
    ],
  },
  {
    id: 'open-loops',
    name: 'Intent & Task Extraction',
    description: 'Extract intents (goals, desires) and tasks (concrete actions) from conversations and messages',
    system_prompt: `Extract intents and tasks from the following text.

An INTENT is a high-level goal or desire ("improve test coverage", "migrate to new auth system").
A TASK is a concrete actionable step ("write unit tests for UserService", "fix login bug #42").

Output JSON with entities and relations arrays:
- entities: [{id, type: "intent"|"task", name, description, confidence}]
- relations: [{source_id, target_id, relation: "decomposes_into"|"blocks"|"depends_on"|"about"|"task_of", confidence}]

Rules:
1. Next actions must be SPECIFIC and ACTIONABLE — start with a verb
2. confidence >= 0.7 for explicit statements, 0.4-0.6 for implied
3. Link tasks to intents via decomposes_into when the relationship is clear
4. Link to existing concepts via about when relevant
5. Only extract clear intents/tasks, skip casual conversation`,
    node_types: ['intent', 'effort', 'task', 'session'],
    relation_types: [
      'task_of',
      'blocks',
      'depends_on',
      'produced_by',
      'references',
      'about',
      'decomposes_into',
    ],
  },
];

export function seedDefaults(): void {
  const db = getSqlite();

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM perspectives').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO perspectives (id, name, description, system_prompt, node_types, relation_types)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const p of DEFAULT_PERSPECTIVES) {
      insert.run(
        p.id,
        p.name,
        p.description,
        p.system_prompt,
        JSON.stringify(p.node_types),
        JSON.stringify(p.relation_types),
      );
    }
  });

  insertMany();
  console.log(`[perspectives] Seeded ${DEFAULT_PERSPECTIVES.length} default perspectives`);
}
