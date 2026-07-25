import { getSqlite } from '../db/sqlite.js';
import { queryAll } from '../db/kuzu.js';
import { getEmbeddingStats } from '../embeddings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrentMetrics {
  graph: { total_nodes: number; total_edges: number };
  nodes_by_type: Record<string, number>;
  edges_by_relation: Record<string, number>;
  embedded_count: number;
  queue: { pending: number; running: number; completed: number; failed: number; paused: number; dead_letter: number };
  workers: { active: number; inactive: number; dead: number };
}

interface ExtractionByPerspective {
  perspective: string;
  count: number;
  avg_nodes: number;
  avg_edges: number;
  avg_duration_ms: number;
}

interface ExtractionByWorker {
  worker_id: string;
  count: number;
  total_nodes: number;
  total_edges: number;
}

interface PipelineStatsRow {
  pipeline: string;
  total_runs: number;
  completed: number;
  failed: number;
  avg_duration_ms: number;
  last_run_at: string;
}

interface WorkerStatsRow {
  id: string;
  name: string;
  status: string;
  tasks_completed: number;
  tasks_failed: number;
  total_nodes_created: number;
  total_edges_created: number;
  last_heartbeat: string | null;
}

interface ActivityRow {
  id: number;
  timestamp: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail_json: string | null;
}

interface MetricSnapshotRow {
  id: number;
  timestamp: string;
  total_nodes: number;
  total_edges: number;
  nodes_by_type: string | null;
  nodes_by_domain: string | null;
  edges_by_relation: string | null;
  embedded_count: number | null;
  queue_pending: number | null;
  queue_running: number | null;
  queue_completed: number | null;
  queue_failed: number | null;
}

// ---------------------------------------------------------------------------
// getCurrentMetrics — async (KuzuDB queries)
// ---------------------------------------------------------------------------

export async function getCurrentMetrics(): Promise<CurrentMetrics> {
  // KuzuDB: nodes by type
  const nodeRows = await queryAll<{ type: string; cnt: number }>(
    'MATCH (e:Entity) RETURN e.type AS type, count(*) AS cnt',
  );
  const nodes_by_type: Record<string, number> = {};
  let total_nodes = 0;
  for (const r of nodeRows) {
    const key = r.type ?? 'unknown';
    nodes_by_type[key] = (nodes_by_type[key] ?? 0) + r.cnt;
    total_nodes += r.cnt;
  }

  // KuzuDB: edges by relation
  const edgeRows = await queryAll<{ relation: string; cnt: number }>(
    'MATCH ()-[a:Assertion]->() RETURN a.relation AS relation, count(*) AS cnt',
  );
  const edges_by_relation: Record<string, number> = {};
  let total_edges = 0;
  for (const r of edgeRows) {
    const key = r.relation ?? 'unknown';
    edges_by_relation[key] = (edges_by_relation[key] ?? 0) + r.cnt;
    total_edges += r.cnt;
  }

  // Embeddings
  const embeddingStats = getEmbeddingStats();
  const embedded_count = embeddingStats.embedded;

  // SQLite: queue stats
  const db = getSqlite();
  const taskRows = db.prepare(
    "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status",
  ).all() as Array<{ status: string; count: number }>;

  const queueMap: Record<string, number> = {};
  for (const r of taskRows) queueMap[r.status] = r.count;

  const queue = {
    pending: queueMap['pending'] ?? 0,
    running: queueMap['running'] ?? 0,
    completed: queueMap['completed'] ?? 0,
    failed: queueMap['failed'] ?? 0,
    paused: queueMap['paused'] ?? 0,
    dead_letter: queueMap['dead_letter'] ?? 0,
  };

  // SQLite: worker stats
  const workerRows = db.prepare(
    "SELECT status, COUNT(*) AS count FROM workers GROUP BY status",
  ).all() as Array<{ status: string; count: number }>;

  const workerMap: Record<string, number> = {};
  for (const r of workerRows) workerMap[r.status] = r.count;

  const workers = {
    active: workerMap['active'] ?? 0,
    inactive: workerMap['inactive'] ?? 0,
    dead: workerMap['dead'] ?? 0,
  };

  return {
    graph: { total_nodes, total_edges },
    nodes_by_type,
    edges_by_relation,
    embedded_count,
    queue,
    workers,
  };
}

// ---------------------------------------------------------------------------
// getMetricHistory — sync (SQLite only)
// ---------------------------------------------------------------------------

export function getMetricHistory(
  from?: string,
  to?: string,
  limit?: number,
): MetricSnapshotRow[] {
  const db = getSqlite();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (from) {
    conditions.push('timestamp >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('timestamp <= ?');
    params.push(to);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit ?? 100);

  return db.prepare(
    `SELECT * FROM metric_snapshots ${where} ORDER BY timestamp DESC LIMIT ?`,
  ).all(...params) as MetricSnapshotRow[];
}

// ---------------------------------------------------------------------------
// getExtractionStats — sync (SQLite only)
// ---------------------------------------------------------------------------

export function getExtractionStats(): {
  total: number;
  by_perspective: ExtractionByPerspective[];
  by_worker: ExtractionByWorker[];
} {
  const db = getSqlite();

  const totalRow = db.prepare(
    'SELECT COUNT(*) AS total FROM extractions',
  ).get() as { total: number };

  const byPerspective = db.prepare(`
    SELECT
      perspective,
      COUNT(*)            AS count,
      AVG(nodes_created)  AS avg_nodes,
      AVG(edges_created)  AS avg_edges,
      AVG(duration_ms)    AS avg_duration_ms
    FROM extractions
    GROUP BY perspective
    ORDER BY count DESC
  `).all() as ExtractionByPerspective[];

  const byWorker = db.prepare(`
    SELECT
      worker_id,
      COUNT(*)            AS count,
      SUM(nodes_created)  AS total_nodes,
      SUM(edges_created)  AS total_edges
    FROM extractions
    GROUP BY worker_id
    ORDER BY count DESC
  `).all() as ExtractionByWorker[];

  return {
    total: totalRow.total,
    by_perspective: byPerspective,
    by_worker: byWorker,
  };
}

// ---------------------------------------------------------------------------
// getPipelineStats — sync (SQLite only)
// ---------------------------------------------------------------------------

export function getPipelineStats(): PipelineStatsRow[] {
  const db = getSqlite();

  return db.prepare(`
    SELECT
      pipeline,
      COUNT(*)                                        AS total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
      AVG(duration_ms)                                AS avg_duration_ms,
      MAX(started_at)                                 AS last_run_at
    FROM pipeline_runs
    GROUP BY pipeline
    ORDER BY last_run_at DESC
  `).all() as PipelineStatsRow[];
}

// ---------------------------------------------------------------------------
// getWorkerStats — sync (SQLite only)
// ---------------------------------------------------------------------------

export function getWorkerStats(): WorkerStatsRow[] {
  const db = getSqlite();

  return db.prepare(`
    SELECT
      id,
      name,
      status,
      tasks_completed,
      tasks_failed,
      total_nodes_created,
      total_edges_created,
      last_heartbeat
    FROM workers
    ORDER BY registered_at DESC
  `).all() as WorkerStatsRow[];
}

// ---------------------------------------------------------------------------
// getActivityLog — sync (SQLite only)
// ---------------------------------------------------------------------------

export function getActivityLog(
  limit: number = 50,
  offset: number = 0,
): Array<Omit<ActivityRow, 'detail_json'> & { detail: unknown }> {
  const db = getSqlite();

  const rows = db.prepare(
    'SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ? OFFSET ?',
  ).all(limit, offset) as ActivityRow[];

  return rows.map((row) => {
    const { detail_json, ...rest } = row;
    return {
      ...rest,
      detail: detail_json ? JSON.parse(detail_json) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// takeMetricSnapshot — async (calls getCurrentMetrics)
// ---------------------------------------------------------------------------

export async function takeMetricSnapshot(): Promise<void> {
  const metrics = await getCurrentMetrics();
  const db = getSqlite();

  db.prepare(`
    INSERT INTO metric_snapshots (
      total_nodes, total_edges,
      nodes_by_type, nodes_by_domain, edges_by_relation,
      embedded_count,
      queue_pending, queue_running, queue_completed, queue_failed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    metrics.graph.total_nodes,
    metrics.graph.total_edges,
    JSON.stringify(metrics.nodes_by_type),
    null, // nodes_by_domain — not tracked at this level
    JSON.stringify(metrics.edges_by_relation),
    metrics.embedded_count,
    metrics.queue.pending,
    metrics.queue.running,
    metrics.queue.completed,
    metrics.queue.failed,
  );
}
