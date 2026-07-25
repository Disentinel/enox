// SQLite-backed persistence for share metadata (owner-visible records: id, token,
// name, domains, counts, revoked/expiry state). Snapshot data itself lives on disk
// under data/shares/<id>/ — see snapshot.ts.
import { getSqlite } from '../db/sqlite.js';
import { randomSlug, randomToken } from '../util.js';
import type { ShareRecord, ShareRawRow } from './types.js';

function parseRow(raw: ShareRawRow): ShareRecord {
  return {
    ...raw,
    domains: JSON.parse(raw.domains) as string[],
    revoked: raw.revoked === 1,
  };
}

export function listShares(): ShareRecord[] {
  const db = getSqlite();
  const rows = db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all() as ShareRawRow[];
  return rows.map(parseRow);
}

export function getShare(id: string): ShareRecord | null {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as ShareRawRow | undefined;
  return row ? parseRow(row) : null;
}

// Creates the share metadata row. Generates a fresh id/token, retrying on the
// astronomically unlikely id collision. Snapshot export happens separately
// (service.ts) and calls setCounts() once it knows node/edge counts.
export function createShareRecord(input: { name: string; description?: string; domains: string[]; ttlDays?: number }): ShareRecord {
  const db = getSqlite();

  let id = randomSlug(10);
  for (let attempt = 0; attempt < 5 && getShare(id); attempt++) {
    id = randomSlug(10);
  }
  const token = randomToken(32);
  const expiresAt = input.ttlDays ? new Date(Date.now() + input.ttlDays * 86400_000).toISOString() : null;

  db.prepare(`
    INSERT INTO shares (id, token, name, description, domains, node_count, edge_count, revoked, expires_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
  `).run(id, token, input.name, input.description ?? null, JSON.stringify(input.domains), expiresAt);

  return getShare(id)!;
}

// Called right after a (re)export of the snapshot succeeds — bumps node/edge
// counts and snapshot_at together, since they always change at the same moment
// (both share creation and /refresh call this immediately after exportShareSnapshot).
export function setShareCounts(id: string, nodeCount: number, edgeCount: number): void {
  const db = getSqlite();
  db.prepare(
    `UPDATE shares SET node_count = ?, edge_count = ?, snapshot_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  ).run(nodeCount, edgeCount, id);
}

export function revokeShare(id: string): boolean {
  const db = getSqlite();
  const result = db.prepare(
    `UPDATE shares SET revoked = 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
  return result.changes > 0;
}

// True delete of the metadata row — used only to roll back a creation whose
// snapshot export failed (the share never became usable, so nothing should
// resolve it, unlike revoke() which intentionally keeps the row so /share/:id
// can still respond 410 instead of 404).
export function hardDeleteShare(id: string): void {
  const db = getSqlite();
  db.prepare('DELETE FROM shares WHERE id = ?').run(id);
}
