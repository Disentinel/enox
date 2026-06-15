import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config.js';
import { resolveToken, getUserByUsername, type User } from './users.js';

// Augment Express Request with the authenticated user (set by requireAuth).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      /** Convenience: authenticated username, used as asserted_by on writes. */
      userId?: string;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const queryToken = req.query.token as string | undefined;
  if (queryToken) return queryToken;
  return null;
}

/**
 * Resolve the caller's identity from a bearer token (or the legacy shared
 * AUTH_TOKEN) and attach it to req.user / req.userId. Returns null without
 * setting anything if no valid credential is present.
 *
 * Resolution order:
 *   1. Per-user token in the api_tokens store  → that user.
 *   2. Legacy shared AUTH_TOKEN env            → the configured ADMIN_USER.
 */
export function authenticate(req: Request): User | null {
  const token = extractToken(req);
  if (!token) return null;

  const user = resolveToken(token);
  if (user) {
    req.user = user;
    req.userId = user.username;
    return user;
  }

  // Legacy single shared token → built-in admin user.
  const config = loadConfig();
  if (config.authToken && token === config.authToken) {
    const adminName = process.env.ADMIN_USER ?? 'admin';
    const adminUser = getUserByUsername(adminName);
    if (adminUser && !adminUser.disabled) {
      req.user = adminUser;
      req.userId = adminUser.username;
      return adminUser;
    }
  }
  return null;
}

/** Express middleware: reject unauthenticated requests with 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();

  // Public read-only node: skip auth entirely.
  if (config.mode === 'public') {
    next();
    return;
  }

  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Authorization required: Bearer <token>' });
    return;
  }
  next();
}

/** Express middleware: require an authenticated user with the admin role. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = authenticate(req);
  if (!user) {
    res.status(401).json({ error: 'Authorization required: Bearer <token>' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }
  next();
}
