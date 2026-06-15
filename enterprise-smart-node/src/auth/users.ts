import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { getSqlite } from '../db/sqlite.js';

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  role: 'admin' | 'member';
  disabled: number;
  created_at: string;
}

export interface ApiToken {
  id: string;
  user_id: string;
  username: string;
  label: string | null;
  revoked: number;
  created_at: string;
  last_used_at: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generate a high-entropy opaque bearer token. */
export function generateToken(): string {
  return 'enox_' + randomBytes(24).toString('base64url');
}

// ── Users ────────────────────────────────────────────────────────────────

export function createUser(username: string, opts: { displayName?: string; role?: 'admin' | 'member' } = {}): User {
  const db = getSqlite();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, opts.displayName ?? null, opts.role ?? 'member');
  return getUserById(id)!;
}

export function getUserById(id: string): User | null {
  const db = getSqlite();
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined) ?? null;
}

export function getUserByUsername(username: string): User | null {
  const db = getSqlite();
  return (db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined) ?? null;
}

export function listUsers(): User[] {
  const db = getSqlite();
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as User[];
}

export function setUserDisabled(id: string, disabled: boolean): void {
  const db = getSqlite();
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
}

// ── Tokens ───────────────────────────────────────────────────────────────

/**
 * Issue a new token for a user. Returns the RAW token exactly once —
 * only its hash is persisted, so it cannot be recovered later.
 */
export function issueToken(userId: string, label?: string): { id: string; token: string } {
  const db = getSqlite();
  const id = randomUUID();
  const token = generateToken();
  db.prepare(
    'INSERT INTO api_tokens (id, user_id, token_hash, label) VALUES (?, ?, ?, ?)',
  ).run(id, userId, hashToken(token), label ?? null);
  return { id, token };
}

export function revokeToken(tokenId: string): boolean {
  const db = getSqlite();
  const r = db.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?').run(tokenId);
  return r.changes > 0;
}

export function listTokens(userId?: string): ApiToken[] {
  const db = getSqlite();
  const sql =
    `SELECT t.id, t.user_id, u.username, t.label, t.revoked, t.created_at, t.last_used_at
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     ${userId ? 'WHERE t.user_id = ?' : ''}
     ORDER BY t.created_at DESC`;
  return (userId ? db.prepare(sql).all(userId) : db.prepare(sql).all()) as ApiToken[];
}

/**
 * Resolve a raw bearer token to its (non-disabled) owner.
 * Returns null if the token is unknown, revoked, or the user is disabled.
 * Updates last_used_at as a side effect.
 */
export function resolveToken(rawToken: string): User | null {
  const db = getSqlite();
  const row = db.prepare(
    `SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked = 0 AND u.disabled = 0`,
  ).get(hashToken(rawToken)) as User | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?").run(hashToken(rawToken));
  return row;
}

/**
 * Bootstrap: ensure an admin user exists. On a fresh DB with no users, create
 * `username` and issue it the provided token (or generate one). Idempotent.
 * Returns the generated token only when it created the user + token here.
 */
export function ensureBootstrapAdmin(username: string, presetToken?: string): { created: boolean; token?: string } {
  const db = getSqlite();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return { created: false };

  const user = createUser(username, { role: 'admin', displayName: 'Bootstrap admin' });
  if (presetToken) {
    db.prepare(
      'INSERT INTO api_tokens (id, user_id, token_hash, label) VALUES (?, ?, ?, ?)',
    ).run(randomUUID(), user.id, hashToken(presetToken), 'bootstrap');
    return { created: true };
  }
  const { token } = issueToken(user.id, 'bootstrap');
  return { created: true, token };
}
