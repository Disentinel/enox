import kuzu from 'kuzu';
import type { KuzuValue } from 'kuzu';
import path from 'node:path';
import fs from 'node:fs';

const { Database, Connection } = kuzu;

type Params = Record<string, KuzuValue>;

let db: InstanceType<typeof Database>;
let conn: InstanceType<typeof Connection>;

const SCHEMA = `
CREATE NODE TABLE IF NOT EXISTS Entity(
  id STRING PRIMARY KEY,
  type STRING,
  domain STRING,
  name STRING,
  description STRING,
  aliases STRING[],
  source_ref STRING,
  created_at STRING,
  updated_at STRING
);

CREATE REL TABLE IF NOT EXISTS Assertion(
  FROM Entity TO Entity,
  fact_id STRING,
  relation STRING,
  asserted_by STRING,
  confidence DOUBLE,
  proof_depth INT64,
  context STRING,
  created_at STRING,
  updated_at STRING
);
`;

export async function initDb(dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  conn = new Connection(db);

  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await conn.query(stmt);
  }

  console.log('[db] KuzuDB initialized at', dbPath);
}

export async function queryAll<T = Record<string, unknown>>(
  cypher: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  let result;
  if (params && Object.keys(params).length > 0) {
    const prepared = await conn.prepare(cypher);
    result = await conn.execute(prepared, params as Params);
  } else {
    result = await conn.query(cypher);
  }
  const qr = Array.isArray(result) ? result[0] : result;
  return (await qr.getAll()) as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  cypher: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  const rows = await queryAll<T>(cypher, params);
  return rows[0] ?? null;
}

export async function execute(
  cypher: string,
  params?: Record<string, unknown>,
): Promise<void> {
  if (params && Object.keys(params).length > 0) {
    const prepared = await conn.prepare(cypher);
    await conn.execute(prepared, params as Params);
  } else {
    await conn.query(cypher);
  }
}

export async function closeDb(): Promise<void> {
  if (conn) await conn.close();
  if (db) await db.close();
}
