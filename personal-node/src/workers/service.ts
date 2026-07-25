import { getSqlite } from '../db/sqlite.js';
import { nanoid } from '../util.js';

export interface WorkerRow {
  id: string;
  name: string;
  capabilities: string[];
  status: string;
  last_heartbeat: string | null;
  tasks_completed: number;
  tasks_failed: number;
  total_nodes_created: number;
  total_edges_created: number;
  ip_address: string | null;
  user_agent: string | null;
  registered_at: string;
  updated_at: string;
}

interface WorkerRawRow {
  id: string;
  name: string;
  capabilities: string;
  status: string;
  last_heartbeat: string | null;
  tasks_completed: number;
  tasks_failed: number;
  total_nodes_created: number;
  total_edges_created: number;
  ip_address: string | null;
  user_agent: string | null;
  registered_at: string;
  updated_at: string;
}

function parseRow(raw: WorkerRawRow): WorkerRow {
  return {
    ...raw,
    capabilities: JSON.parse(raw.capabilities) as string[],
  };
}

export function registerWorker(input: {
  name: string;
  capabilities: string[];
  ip_address?: string;
  user_agent?: string;
}): { worker_id: string; poll_interval_ms: number; heartbeat_interval_ms: number } {
  const db = getSqlite();
  const id = 'w_' + nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO workers (id, name, capabilities, status, last_heartbeat, ip_address, user_agent, registered_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(id, input.name, JSON.stringify(input.capabilities), now, input.ip_address ?? null, input.user_agent ?? null, now, now);

  db.prepare(`
    INSERT INTO activity_log (actor, action, entity_type, entity_id, detail_json)
    VALUES (?, 'worker.register', 'worker', ?, ?)
  `).run(input.name, id, JSON.stringify({ capabilities: input.capabilities }));

  return { worker_id: id, poll_interval_ms: 5000, heartbeat_interval_ms: 30000 };
}

export function listWorkers(): WorkerRow[] {
  const db = getSqlite();
  const rows = db.prepare('SELECT * FROM workers ORDER BY registered_at DESC').all() as WorkerRawRow[];
  return rows.map(parseRow);
}

export function getWorker(id: string): WorkerRow | undefined {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRawRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function heartbeat(id: string): boolean {
  const db = getSqlite();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE workers SET last_heartbeat = ?, status = 'active', updated_at = ? WHERE id = ?
  `).run(now, now, id);
  return result.changes > 0;
}

export function deregisterWorker(id: string): boolean {
  const db = getSqlite();
  const worker = db.prepare('SELECT name FROM workers WHERE id = ?').get(id) as { name: string } | undefined;
  if (!worker) return false;

  db.prepare('DELETE FROM workers WHERE id = ?').run(id);

  db.prepare(`
    INSERT INTO activity_log (actor, action, entity_type, entity_id)
    VALUES (?, 'worker.deregister', 'worker', ?)
  `).run(worker.name, id);

  return true;
}

export function updateWorkerStats(
  id: string,
  stats: {
    tasks_completed?: number;
    tasks_failed?: number;
    nodes_created?: number;
    edges_created?: number;
  },
): boolean {
  const db = getSqlite();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (stats.tasks_completed) {
    sets.push('tasks_completed = tasks_completed + ?');
    params.push(stats.tasks_completed);
  }
  if (stats.tasks_failed) {
    sets.push('tasks_failed = tasks_failed + ?');
    params.push(stats.tasks_failed);
  }
  if (stats.nodes_created) {
    sets.push('total_nodes_created = total_nodes_created + ?');
    params.push(stats.nodes_created);
  }
  if (stats.edges_created) {
    sets.push('total_edges_created = total_edges_created + ?');
    params.push(stats.edges_created);
  }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  const result = db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function reapDeadWorkers(timeoutMs: number): number {
  const db = getSqlite();
  const now = Date.now();

  const workers = db.prepare(`
    SELECT id, last_heartbeat FROM workers WHERE status = 'active'
  `).all() as { id: string; last_heartbeat: string | null }[];

  let updated = 0;
  const twoMinMs = 2 * 60 * 1000;
  const tenMinMs = 10 * 60 * 1000;

  for (const w of workers) {
    if (!w.last_heartbeat) continue;
    const elapsed = now - new Date(w.last_heartbeat).getTime();
    if (elapsed < timeoutMs) continue;

    const newStatus = elapsed >= tenMinMs ? 'dead' : elapsed >= twoMinMs ? 'inactive' : null;
    if (!newStatus) continue;

    db.prepare("UPDATE workers SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, w.id);
    updated++;
  }

  return updated;
}
