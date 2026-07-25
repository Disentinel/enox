import { Router } from 'express';
import * as h from './handlers.js';

export function createWorkersRouter(): Router {
  const router = Router();

  router.post('/register', h.register);
  router.get('/', h.list);
  router.get('/:id', h.get);
  router.post('/:id/heartbeat', h.heartbeat);
  router.delete('/:id', h.deregister);

  return router;
}
