import { Router } from 'express';
import * as h from './handlers.js';

export function createQueueRouter(): Router {
  const router = Router();

  router.get('/', h.listTasks);
  router.post('/', h.createTask);
  router.get('/stats', h.getQueueStats);
  router.get('/next', h.getNextTask);
  router.post('/bulk', h.bulkCreate);
  router.post('/clear', h.clearTasks);

  router.get('/:id', h.getTask);
  router.put('/:id', h.updateTask);
  router.delete('/:id', h.deleteTask);
  router.post('/:id/heartbeat', h.heartbeat);
  router.post('/:id/complete', h.completeTask);
  router.post('/:id/fail', h.failTask);
  router.post('/:id/pause', h.pauseTask);
  router.post('/:id/resume', h.resumeTask);

  return router;
}
