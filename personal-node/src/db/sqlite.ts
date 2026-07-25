import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  priority      INTEGER NOT NULL DEFAULT 0,
  source_url    TEXT,
  perspective   TEXT,
  config_json   TEXT,
  assigned_to   TEXT,
  assigned_at   TEXT,
  result_json   TEXT,
  error_message TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  completed_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);

CREATE TABLE IF NOT EXISTS extractions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id),
  perspective   TEXT NOT NULL,
  worker_id     TEXT,
  source_type   TEXT NOT NULL,
  source_ref    TEXT,
  nodes_created INTEGER NOT NULL DEFAULT 0,
  edges_created INTEGER NOT NULL DEFAULT 0,
  nodes_deduped INTEGER NOT NULL DEFAULT 0,
  chunks_total  INTEGER NOT NULL DEFAULT 0,
  chunks_processed INTEGER NOT NULL DEFAULT 0,
  llm_model     TEXT,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_extractions_perspective ON extractions(perspective);
CREATE INDEX IF NOT EXISTS idx_extractions_task ON extractions(task_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            TEXT PRIMARY KEY,
  pipeline      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  total_items   INTEGER,
  processed     INTEGER NOT NULL DEFAULT 0,
  result_json   TEXT,
  error_message TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at     TEXT,
  completed_at  TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

CREATE TABLE IF NOT EXISTS perspectives (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  node_types    TEXT NOT NULL,
  relation_types TEXT NOT NULL,
  domains       TEXT,
  chunk_size    INTEGER NOT NULL DEFAULT 4000,
  chunk_overlap INTEGER NOT NULL DEFAULT 500,
  llm_model     TEXT NOT NULL DEFAULT 'sonnet',
  temperature   REAL NOT NULL DEFAULT 0.0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  total_nodes   INTEGER NOT NULL,
  total_edges   INTEGER NOT NULL,
  nodes_by_type    TEXT,
  nodes_by_domain  TEXT,
  edges_by_relation TEXT,
  embedded_count   INTEGER,
  queue_pending    INTEGER,
  queue_running    INTEGER,
  queue_completed  INTEGER,
  queue_failed     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_ts ON metric_snapshots(timestamp DESC);

CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  capabilities  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  last_heartbeat TEXT,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed    INTEGER NOT NULL DEFAULT 0,
  total_nodes_created INTEGER NOT NULL DEFAULT 0,
  total_edges_created INTEGER NOT NULL DEFAULT 0,
  ip_address    TEXT,
  user_agent    TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  actor         TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  detail_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_log_ts ON activity_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);

CREATE TABLE IF NOT EXISTS schema_version (
  version       INTEGER PRIMARY KEY,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS node_usage (
  node_id       TEXT PRIMARY KEY,
  query_count   INTEGER NOT NULL DEFAULT 0,
  last_queried_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_node_usage_count ON node_usage(query_count DESC);

CREATE TABLE IF NOT EXISTS dedup_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  canonical_id  TEXT NOT NULL,
  merged_id     TEXT NOT NULL,
  similarity    REAL NOT NULL,
  merge_reason  TEXT NOT NULL,
  edges_moved   INTEGER NOT NULL DEFAULT 0,
  aliases_added TEXT,
  snapshot_file TEXT,
  status        TEXT NOT NULL DEFAULT 'completed'
);

CREATE INDEX IF NOT EXISTS idx_dedup_log_ts ON dedup_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_dedup_log_merged ON dedup_log(merged_id);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  domains       TEXT NOT NULL,
  node_count    INTEGER NOT NULL DEFAULT 0,
  edge_count    INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
`;

// snapshot_at: when the share's snapshot files were last (re)exported — distinct
// from created_at (when the share record itself was created) and updated_at
// (generic bump). Set at creation and re-set on every /refresh.
const SCHEMA_V4 = `
ALTER TABLE shares ADD COLUMN snapshot_at TEXT;
`;

// Metadata for artifacts (arbitrary content-type blobs linked into the graph —
// see src/artifacts/). The blob body itself lives on disk under
// data/artifacts/<id>.<ext> (see artifacts/blob.ts); this table holds only
// metadata + the pointer. entity_id is the artifact's own node in the main
// KuzuDB graph (type='artifact') — see artifacts/graph.ts.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  title         TEXT NOT NULL,
  domain        TEXT NOT NULL,
  filename      TEXT,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_domain ON artifacts(domain);
CREATE INDEX IF NOT EXISTS idx_artifacts_content_type ON artifacts(content_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(domain, sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_entity_id ON artifacts(entity_id);
`;

export function initSqlite(sqlitePath: string): void {
  const dir = path.dirname(sqlitePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA_V1);

  // Record schema version if not present
  const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!version) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
  }

  // Apply V2 migration (node_usage + dedup_log)
  const currentVersion = (db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number })?.version ?? 0;
  if (currentVersion < 2) {
    db.exec(SCHEMA_V2);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
    console.log('[db] Applied schema migration V2 (node_usage + dedup_log)');
  }

  // Apply V3 migration (shares)
  const versionAfterV2 = (db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number })?.version ?? 0;
  if (versionAfterV2 < 3) {
    db.exec(SCHEMA_V3);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
    console.log('[db] Applied schema migration V3 (shares)');
  }

  // Apply V4 migration (shares.snapshot_at)
  const versionAfterV3 = (db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number })?.version ?? 0;
  if (versionAfterV3 < 4) {
    db.exec(SCHEMA_V4);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
    console.log('[db] Applied schema migration V4 (shares.snapshot_at)');
  }

  // Apply V5 migration (artifacts)
  const versionAfterV4 = (db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number })?.version ?? 0;
  if (versionAfterV4 < 5) {
    db.exec(SCHEMA_V5);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
    console.log('[db] Applied schema migration V5 (artifacts)');
  }

  console.log('[db] SQLite initialized at', sqlitePath);
}

export function getSqlite(): Database.Database {
  if (!db) throw new Error('SQLite not initialized. Call initSqlite() first.');
  return db;
}

export function closeSqlite(): void {
  if (db) db.close();
}
