import { Router } from 'express';
import * as h from './handlers.js';

// Owner-writing artifact CRUD — mounted at /api/artifacts behind requireAuth
// (see index.ts), same pattern as queue/workers/perspectives/shares.
export function createArtifactsRouter(): Router {
  const router = Router();

  router.post('/', h.create);
  router.get('/', h.list);
  router.get('/:id/raw', h.getRaw); // must be before /:id
  router.get('/:id', h.get);
  router.put('/:id', h.update);
  router.delete('/:id', h.remove);

  return router;
}
