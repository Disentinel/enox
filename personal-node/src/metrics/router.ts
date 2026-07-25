import { Router } from 'express';
import * as h from './handlers.js';

export function createMetricsRouter(): Router {
  const router = Router();

  router.get('/current', h.current);
  router.get('/history', h.history);
  router.get('/extractions', h.extractions);
  router.get('/pipelines', h.pipelines);
  router.get('/workers', h.workers);
  router.get('/activity', h.activity);

  return router;
}
