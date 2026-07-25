// SQLite-backed metadata for artifacts (id, entity_id, content_type, title,
// domain, filename, size, sha256). The blob body lives on disk — see blob.ts.
import { getSqlite } from '../db/sqlite.js';

export interface ArtifactRecord {
  id: string;
  entity_id: string;
  content_type: string;
  title: string;
  domain: string;
  filename: string | null;
  size: number;
  sha256: string;
  created_at: string;
  updated_at: string;
}

export function getArtifactRecord(id: string): ArtifactRecord | null {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRecord | undefined;
  return row ?? null;
}

// Dedup lookup: same body (sha256) uploaded to the same domain is treated as
// the same artifact — see handlers.ts create() for how this is used.
export function findArtifactBySha(domain: string, sha256: string): ArtifactRecord | null {
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM artifacts WHERE domain = ? AND sha256 = ?').get(domain, sha256) as ArtifactRecord | undefined;
  return row ?? null;
}

export function listArtifactRecords(filters: { domain?: string; content_type?: string; limit: number; offset: number }): ArtifactRecord[] {
  const db = getSqlite();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.domain) { conditions.push('domain = ?'); params.push(filters.domain); }
  if (filters.content_type) { conditions.push('content_type = ?'); params.push(filters.content_type); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(filters.limit, filters.offset);

  return db.prepare(`
    SELECT * FROM artifacts ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as ArtifactRecord[];
}

export function createArtifactRecord(input: {
  id: string; entity_id: string; content_type: string; title: string; domain: string;
  filename: string | null; size: number; sha256: string;
}): ArtifactRecord {
  const db = getSqlite();
  db.prepare(`
    INSERT INTO artifacts (id, entity_id, content_type, title, domain, filename, size, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.entity_id, input.content_type, input.title, input.domain, input.filename, input.size, input.sha256);
  return getArtifactRecord(input.id)!;
}

export function updateArtifactRecord(id: string, updates: Partial<{
  content_type: string; title: string; domain: string; filename: string | null; size: number; sha256: string;
}>): ArtifactRecord | null {
  const db = getSqlite();
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (sets.length === 0) return getArtifactRecord(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  const info = db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return null;
  return getArtifactRecord(id);
}

export function deleteArtifactRecord(id: string): boolean {
  const db = getSqlite();
  const info = db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  return info.changes > 0;
}
