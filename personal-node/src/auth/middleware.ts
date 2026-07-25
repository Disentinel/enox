import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();

  // Skip auth if no token configured (dev mode)
  if (!config.authToken) {
    next();
    return;
  }

  // Accept token from Authorization header or query string (?token=...)
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  let token: string | null = null;

  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token) {
    res.status(401).json({ error: 'Authorization required (Bearer header or ?token= query param)' });
    return;
  }

  if (token !== config.authToken) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}
