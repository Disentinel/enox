import { Router } from 'express';
import * as h from './handlers.js';

// Owner-facing share management — mounted at /api/shares behind the main requireAuth.
export function createSharesRouter(): Router {
  const router = Router();

  router.post('/', h.create);
  router.get('/', h.list);
  router.delete('/:id', h.remove);
  router.post('/:id/refresh', h.refresh);

  return router;
}
