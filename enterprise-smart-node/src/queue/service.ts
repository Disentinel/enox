import { getSqlite } from '../db/sqlite.js';
import { nanoid } from '../util.js';
import type { z } from 'zod';
import type { CreateTaskSchema, ListTasksQuery, UpdateTaskSchema } from './validators.js';

type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type ListTasksInput = z.infer<typeof ListTasksQuery>;
type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

interface TaskRow {
  id: string;
  type: string;
  status: string;
  priority: number;
  source_url: string | null;
  perspective: string | null;
  config_json: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  result_json: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function parseTask(row: TaskRow) {
  return {
    ...row,
    config_json: row.config_json ? JSON.parse(row.config_json) : null,
    result_json: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function logActivity(actor: string | null, action: string, entityType: string, entityId: string, detail?: Record<string, unknown>) {
  const db = getSqlite();
  db.prepare(
    'INSERT INTO activity_log (actor, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)',
  ).run(actor, action, entityType, entityId, detail ? JSON.stringify(detail) : null);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createTask(input: CreateTaskInput) {
  const db = getSqlite();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (id, type, status, priority, source_url, perspective, config_json, max_retries, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.priority,
    input.source_url ?? null,
    input.perspective ?? null,
    input.config_json ? JSON.stringify(input.config_json) : null,
    input.max_retries,
    now,
    now,
  );

  logActivity(null, 'task.created', 'task', id, { type: input.type });
  return getTask(id)!;
}

export function listTasks(filters: ListTasksInput) {
  const db = getSqlite();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters.assigned_to) {
    conditions.push('assigned_to = ?');
    params.push(filters.assigned_to);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(filters.limit, filters.offset);

  const rows = db.prepare(`
    SELECT * FROM tasks ${where}
    ORDER BY priority DESC, created_at ASC
    LIMIT ? OFFSET ?
  `).all(...params) as TaskRow[];

  return rows.map(parseTask);
}

export function getTask(id: string) {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? parseTask(row) : null;
}

export function getQueueStats() {
  const db = getSqlite();
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all() as Array<{ status: string; count: number }>;
  const stats: Record<string, number> = {};
  for (const r of rows) {
    stats[r.status] = r.count;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Worker operations
// ---------------------------------------------------------------------------

export function getNextTask(workerId: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  // Atomic claim: find + update in a transaction
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM tasks
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get() as { id: string } | undefined;

    if (!row) return null;

    db.prepare(`
      UPDATE tasks
      SET status = 'running', assigned_to = ?, assigned_at = ?, started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(workerId, now, now, now, row.id);

    logActivity(workerId, 'task.claimed', 'task', row.id);

    return row.id;
  });

  const taskId = claim();
  return taskId ? getTask(taskId) : null;
}

export function completeTask(id: string, workerId: string, result: Record<string, unknown>) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const info = db.prepare(`
    UPDATE tasks
    SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND assigned_to = ?
  `).run(JSON.stringify(result), now, now, id, workerId);

  if (info.changes === 0) return null;

  logActivity(workerId, 'task.completed', 'task', id);
  return getTask(id);
}

export function failTask(id: string, workerId: string, error: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const task = getTask(id);
  if (!task) return null;

  const newRetryCount = task.retry_count + 1;
  const newStatus = newRetryCount >= task.max_retries ? 'dead_letter' : 'pending';

  // If retrying, reset assigned_to so it can be picked up again
  const assignedTo = newStatus === 'pending' ? null : task.assigned_to;

  db.prepare(`
    UPDATE tasks
    SET status = ?, error_message = ?, retry_count = ?, assigned_to = ?, updated_at = ?
    WHERE id = ? AND assigned_to = ?
  `).run(newStatus, error, newRetryCount, assignedTo, now, id, workerId);

  logActivity(workerId, newStatus === 'dead_letter' ? 'task.dead_letter' : 'task.failed', 'task', id, { error, retry_count: newRetryCount });
  return getTask(id);
}

export function heartbeat(id: string, workerId: string, progress?: Record<string, unknown>) {
  const db = getSqlite();
  const now = new Date().toISOString();

  if (progress) {
    // Merge progress into config_json
    const task = getTask(id);
    if (!task) return null;
    const config = (task.config_json as Record<string, unknown>) ?? {};
    config.progress = progress;

    const info = db.prepare(`
      UPDATE tasks SET config_json = ?, updated_at = ?
      WHERE id = ? AND assigned_to = ?
    `).run(JSON.stringify(config), now, id, workerId);

    return info.changes > 0;
  }

  const info = db.prepare(`
    UPDATE tasks SET updated_at = ?
    WHERE id = ? AND assigned_to = ?
  `).run(now, id, workerId);

  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function pauseTask(id: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const info = db.prepare(`
    UPDATE tasks SET status = 'paused', updated_at = ?
    WHERE id = ? AND status IN ('pending', 'running')
  `).run(now, id);

  if (info.changes === 0) return null;

  logActivity(null, 'task.paused', 'task', id);
  return getTask(id);
}

export function resumeTask(id: string) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const info = db.prepare(`
    UPDATE tasks SET status = 'pending', assigned_to = NULL, updated_at = ?
    WHERE id = ? AND status = 'paused'
  `).run(now, id);

  if (info.changes === 0) return null;

  logActivity(null, 'task.resumed', 'task', id);
  return getTask(id);
}

export function updateTask(id: string, input: UpdateTaskInput) {
  const db = getSqlite();
  const now = new Date().toISOString();

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?');
    params.push(input.priority);
  }
  if (input.config_json !== undefined) {
    sets.push('config_json = ?');
    params.push(JSON.stringify(input.config_json));
  }

  params.push(id);

  const info = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return null;

  logActivity(null, 'task.updated', 'task', id);
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getSqlite();

  const info = db.prepare(`
    DELETE FROM tasks WHERE id = ? AND status IN ('pending', 'failed', 'dead_letter')
  `).run(id);

  if (info.changes === 0) return false;

  logActivity(null, 'task.deleted', 'task', id);
  return true;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export function bulkCreateTasks(tasks: CreateTaskInput[]) {
  const db = getSqlite();

  const insert = db.prepare(`
    INSERT INTO tasks (id, type, status, priority, source_url, perspective, config_json, max_retries, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `);

  const logInsert = db.prepare(
    'INSERT INTO activity_log (actor, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)',
  );

  const created: string[] = [];

  const batch = db.transaction(() => {
    const now = new Date().toISOString();
    for (const t of tasks) {
      const id = nanoid(12);
      insert.run(
        id,
        t.type,
        t.priority,
        t.source_url ?? null,
        t.perspective ?? null,
        t.config_json ? JSON.stringify(t.config_json) : null,
        t.max_retries,
        now,
        now,
      );
      logInsert.run(null, 'task.created', 'task', id, JSON.stringify({ type: t.type }));
      created.push(id);
    }
  });

  batch();
  return created.map(id => getTask(id)!);
}

export function clearTasks(status: string): number {
  const db = getSqlite();
  const info = db.prepare('DELETE FROM tasks WHERE status = ?').run(status);
  if (info.changes > 0) {
    logActivity(null, 'tasks.cleared', 'task', '*', { status, count: info.changes });
  }
  return info.changes;
}

export function reapStaleTasks(timeoutMs: number): number {
  const db = getSqlite();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const stale = db.prepare(`
    SELECT id, assigned_to, retry_count, max_retries FROM tasks
    WHERE status = 'running' AND updated_at < ?
  `).all(cutoff) as Array<{ id: string; assigned_to: string; retry_count: number; max_retries: number }>;

  if (stale.length === 0) return 0;

  const update = db.prepare(`
    UPDATE tasks
    SET status = ?, error_message = 'Worker timeout', retry_count = ?, assigned_to = ?, updated_at = ?
    WHERE id = ?
  `);

  const logStmt = db.prepare(
    'INSERT INTO activity_log (actor, action, entity_type, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)',
  );

  const reap = db.transaction(() => {
    for (const t of stale) {
      const newRetryCount = t.retry_count + 1;
      const newStatus = newRetryCount >= t.max_retries ? 'dead_letter' : 'pending';
      const assignedTo = newStatus === 'pending' ? null : t.assigned_to;
      update.run(newStatus, newRetryCount, assignedTo, now, t.id);
      logStmt.run('system', 'task.reaped', 'task', t.id, JSON.stringify({ timeout_ms: timeoutMs, new_status: newStatus }));
    }
  });

  reap();
  return stale.length;
}
