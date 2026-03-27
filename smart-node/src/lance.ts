/**
 * LanceDB store for Enox Smart Node.
 *
 * Two tables:
 *   - embeddings: (id, vector, name, type, updated_at)
 *   - metrics:    (timestamp, tool, query_text, node_ids, result_count, response_ms, source)
 *
 * Replaces embeddings.json with persistent vector DB.
 * Adds query metrics tracking for node popularity / Librarian agent.
 */

import * as lancedb from '@lancedb/lancedb';
import path from 'node:path';
import fs from 'node:fs';

const LANCE_DIR = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'lance.db');
const EMBEDDING_DIM = 384;

let db: lancedb.Connection | null = null;
let embeddingsTable: lancedb.Table | null = null;
let metricsTable: lancedb.Table | null = null;
let nodeAccessTable: lancedb.Table | null = null;

// ─── Connection ───────────────────────────────────────────────

export async function openLanceDb(): Promise<lancedb.Connection> {
  if (db) return db;
  const dir = path.dirname(LANCE_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = await lancedb.connect(LANCE_DIR);
  console.log('[lance] Connected to', LANCE_DIR);
  return db;
}

export async function closeLanceDb(): Promise<void> {
  // LanceDB JS doesn't require explicit close, but reset refs
  db = null;
  embeddingsTable = null;
  metricsTable = null;
  nodeAccessTable = null;
}

// ─── Embeddings table ─────────────────────────────────────────

async function getEmbTable(): Promise<lancedb.Table> {
  if (embeddingsTable) return embeddingsTable;
  const conn = await openLanceDb();

  try {
    embeddingsTable = await conn.openTable('embeddings');
  } catch {
    // Create with seed record (LanceDB needs at least one row for schema)
    embeddingsTable = await conn.createTable('embeddings', [
      {
        id: '__seed__',
        vector: new Array(EMBEDDING_DIM).fill(0),
        name: '',
        type: '',
        updated_at: new Date().toISOString(),
      },
    ]);
    console.log('[lance] Created embeddings table');
  }

  return embeddingsTable;
}

export async function upsertEmbedding(
  id: string,
  vector: number[],
  name: string,
  type: string = 'concept',
): Promise<void> {
  const table = await getEmbTable();
  // LanceDB add is append — for upsert, delete first then add
  try {
    await table.delete(`id = '${id.replace(/'/g, "''")}'`);
  } catch {
    // May not exist yet — ignore
  }
  await table.add([
    { id, vector, name, type, updated_at: new Date().toISOString() },
  ]);
}

export async function upsertEmbeddingsBatch(
  records: Array<{ id: string; vector: number[]; name: string; type?: string }>,
): Promise<number> {
  if (records.length === 0) return 0;
  const table = await getEmbTable();

  // Delete existing IDs
  for (const r of records) {
    try {
      await table.delete(`id = '${r.id.replace(/'/g, "''")}'`);
    } catch { /* ignore */ }
  }

  // Add all
  const rows = records.map((r) => ({
    id: r.id,
    vector: r.vector,
    name: r.name,
    type: r.type ?? 'concept',
    updated_at: new Date().toISOString(),
  }));
  await table.add(rows);
  return rows.length;
}

export async function searchSimilarLance(
  queryVector: number[],
  topK: number = 10,
): Promise<Array<{ id: string; name: string; type: string; _distance: number }>> {
  const table = await getEmbTable();
  const results = await table
    .vectorSearch(queryVector)
    .limit(topK)
    .toArray();
  return results
    .filter((r: any) => r.id !== '__seed__')
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      _distance: r._distance,
    }));
}

export async function getEmbeddingCount(): Promise<number> {
  try {
    const table = await getEmbTable();
    return await table.countRows();
  } catch {
    return 0;
  }
}

export async function hasEmbedding(id: string): Promise<boolean> {
  try {
    const table = await getEmbTable();
    const rows = await table.query().where(`id = '${id.replace(/'/g, "''")}'`).limit(1).toArray();
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ─── Metrics: query log ───────────────────────────────────────

async function getMetricsTable(): Promise<lancedb.Table> {
  if (metricsTable) return metricsTable;
  const conn = await openLanceDb();

  try {
    metricsTable = await conn.openTable('query_log');
  } catch {
    metricsTable = await conn.createTable('query_log', [
      {
        timestamp: new Date().toISOString(),
        tool: '__init__',
        query_text: '',
        node_ids: '[]',
        result_count: 0,
        response_ms: 0,
        source: 'system',
      },
    ]);
    console.log('[lance] Created query_log table');
  }

  return metricsTable;
}

export async function logQuery(opts: {
  tool: string;
  queryText: string;
  nodeIds?: string[];
  resultCount?: number;
  responseMs?: number;
  source?: string;
}): Promise<void> {
  try {
    const table = await getMetricsTable();
    await table.add([
      {
        timestamp: new Date().toISOString(),
        tool: opts.tool,
        query_text: opts.queryText,
        node_ids: JSON.stringify(opts.nodeIds ?? []),
        result_count: opts.resultCount ?? 0,
        response_ms: opts.responseMs ?? 0,
        source: opts.source ?? '',
      },
    ]);

    // Update node access counts
    if (opts.nodeIds && opts.nodeIds.length > 0) {
      await incrementNodeAccess(opts.nodeIds);
    }
  } catch (err) {
    console.error('[lance] logQuery error:', err);
  }
}

// ─── Metrics: node access counts ──────────────────────────────

async function getNodeAccessTable(): Promise<lancedb.Table> {
  if (nodeAccessTable) return nodeAccessTable;
  const conn = await openLanceDb();

  try {
    nodeAccessTable = await conn.openTable('node_access');
  } catch {
    nodeAccessTable = await conn.createTable('node_access', [
      {
        node_id: '__init__',
        access_count: 0,
        last_accessed: new Date().toISOString(),
      },
    ]);
    console.log('[lance] Created node_access table');
  }

  return nodeAccessTable;
}

async function incrementNodeAccess(nodeIds: string[]): Promise<void> {
  const table = await getNodeAccessTable();

  for (const nodeId of nodeIds) {
    try {
      // Check if exists
      const existing = await table
        .query()
        .where(`node_id = '${nodeId.replace(/'/g, "''")}'`)
        .limit(1)
        .toArray();

      if (existing.length > 0) {
        const current = existing[0] as any;
        await table.delete(`node_id = '${nodeId.replace(/'/g, "''")}'`);
        await table.add([
          {
            node_id: nodeId,
            access_count: (current.access_count ?? 0) + 1,
            last_accessed: new Date().toISOString(),
          },
        ]);
      } else {
        await table.add([
          {
            node_id: nodeId,
            access_count: 1,
            last_accessed: new Date().toISOString(),
          },
        ]);
      }
    } catch (err) {
      console.error(`[lance] incrementNodeAccess error for ${nodeId}:`, err);
    }
  }
}

export async function getPopularNodes(
  limit: number = 20,
): Promise<Array<{ node_id: string; access_count: number; last_accessed: string }>> {
  try {
    const table = await getNodeAccessTable();
    // LanceDB doesn't support ORDER BY in search — fetch all and sort in JS
    const all = await table.query().limit(10000).toArray();
    return (all as any[])
      .filter((r) => r.node_id !== '__init__')
      .sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0))
      .slice(0, limit)
      .map((r) => ({
        node_id: r.node_id,
        access_count: r.access_count ?? 0,
        last_accessed: r.last_accessed ?? '',
      }));
  } catch {
    return [];
  }
}

export async function getQueryStats(hours: number = 24): Promise<{
  total_queries: number;
  by_tool: Record<string, number>;
}> {
  try {
    const table = await getMetricsTable();
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = await table
      .query()
      .where(`timestamp > '${cutoff}'`)
      .limit(100000)
      .toArray();

    const byTool: Record<string, number> = {};
    for (const r of rows as any[]) {
      if (r.tool === '__init__') continue;
      byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    }

    return {
      total_queries: rows.length,
      by_tool: byTool,
    };
  } catch {
    return { total_queries: 0, by_tool: {} };
  }
}

// ─── Migration: embeddings.json → LanceDB ─────────────────────

export async function migrateFromJson(jsonPath: string): Promise<number> {
  if (!fs.existsSync(jsonPath)) {
    console.log('[lance] No embeddings.json to migrate');
    return 0;
  }

  const count = await getEmbeddingCount();
  if (count > 10) {
    console.log(`[lance] Embeddings table already has ${count} rows, skipping migration`);
    return 0;
  }

  console.log('[lance] Migrating embeddings.json → LanceDB...');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const entries = Object.entries(raw) as [string, number[]][];

  const BATCH_SIZE = 100;
  let migrated = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const records = batch.map(([id, vector]) => ({
      id,
      vector,
      name: id.split('/').pop() ?? id,
      type: 'concept',
      updated_at: new Date().toISOString(),
    }));

    const table = await getEmbTable();
    await table.add(records);
    migrated += records.length;

    if (migrated % 500 === 0) {
      console.log(`[lance] Migrated ${migrated}/${entries.length}...`);
    }
  }

  console.log(`[lance] Migration complete: ${migrated} embeddings`);
  // Keep JSON as backup, rename
  fs.renameSync(jsonPath, jsonPath + '.bak');
  console.log('[lance] Renamed embeddings.json → embeddings.json.bak');
  return migrated;
}
