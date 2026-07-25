import { Router } from 'express';
import * as h from './handlers.js';

export function createPerspectivesRouter(): Router {
  const router = Router();

  router.get('/', h.list);
  router.post('/', h.create);
  router.get('/:id', h.get);
  router.put('/:id', h.update);
  router.delete('/:id', h.remove);

  return router;
}
