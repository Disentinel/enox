// Auth for the public share-facing routes (GET /share/:id, /share/:id/mcp).
// Independent of the main requireAuth (src/auth/middleware.ts) and of the main
// AUTH_TOKEN — each share carries its own token, generated at creation time.
import type { Request, Response, NextFunction } from 'express';
import { getShare } from './store.js';
import type { ShareRecord } from './types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      share?: ShareRecord;
      shareId?: string;
      wantsMarkdownSuffix?: boolean;
    }
  }
}

export function shareAuth(req: Request, res: Response, next: NextFunction): void {
  let id = req.params.id as string;
  let wantsMarkdownSuffix = false;
  if (id.endsWith('.md')) {
    id = id.slice(0, -3);
    wantsMarkdownSuffix = true;
  }

  const share = getShare(id);
  if (!share) {
    res.status(404).json({ error: 'Share not found' });
    return;
  }

  // Check the token before revealing anything about revoked/expired state —
  // a token-less request shouldn't learn whether a given share id ever existed
  // beyond "not found" for a truly unknown id.
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  let token: string | null = null;
  if (header?.startsWith('Bearer ')) token = header.slice(7);
  else if (queryToken) token = queryToken;

  if (!token || token !== share.token) {
    res.status(401).json({ error: 'Invalid or missing share token. Pass it as ?token=... or an Authorization: Bearer header.' });
    return;
  }

  if (share.revoked) {
    res.status(410).json({ error: 'This share has been revoked by its owner.' });
    return;
  }
  if (share.expires_at && Date.now() > Date.parse(share.expires_at)) {
    res.status(410).json({ error: 'This share has expired.' });
    return;
  }

  res.locals.share = share;
  res.locals.shareId = id;
  res.locals.wantsMarkdownSuffix = wantsMarkdownSuffix;
  next();
}
