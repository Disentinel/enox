import { Router } from 'express';
import { requireAdmin } from './middleware.js';
import {
  createUser,
  listUsers,
  getUserById,
  getUserByUsername,
  setUserDisabled,
  issueToken,
  revokeToken,
  listTokens,
} from './users.js';

/**
 * Admin API: manage users and remote-MCP bearer tokens.
 * All routes require an authenticated admin (requireAdmin).
 *
 * Mounted at /api/admin. The admin GUI in src/public talks to these endpoints.
 */
export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  // ── Users ──
  router.get('/users', (_req, res) => {
    res.json(listUsers());
  });

  router.post('/users', (req, res) => {
    const { username, display_name, role } = req.body ?? {};
    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'username is required' });
      return;
    }
    if (getUserByUsername(username)) {
      res.status(409).json({ error: 'username already exists' });
      return;
    }
    const user = createUser(username, {
      displayName: display_name,
      role: role === 'admin' ? 'admin' : 'member',
    });
    res.status(201).json(user);
  });

  router.post('/users/:id/disabled', (req, res) => {
    const user = getUserById(req.params.id);
    if (!user) { res.status(404).json({ error: 'user not found' }); return; }
    setUserDisabled(req.params.id, Boolean(req.body?.disabled));
    res.json(getUserById(req.params.id));
  });

  // ── Tokens ──
  router.get('/tokens', (req, res) => {
    const userId = req.query.user_id as string | undefined;
    res.json(listTokens(userId));
  });

  // Issue a token. Returns the RAW token exactly once — it is never recoverable.
  router.post('/tokens', (req, res) => {
    const { user_id, label } = req.body ?? {};
    if (!user_id || !getUserById(user_id)) {
      res.status(400).json({ error: 'valid user_id is required' });
      return;
    }
    const { id, token } = issueToken(user_id, label);
    res.status(201).json({ id, token, note: 'Store this token now — it cannot be retrieved again.' });
  });

  router.delete('/tokens/:id', (req, res) => {
    if (revokeToken(req.params.id)) {
      res.status(204).end();
    } else {
      res.status(404).json({ error: 'token not found' });
    }
  });

  return router;
}
