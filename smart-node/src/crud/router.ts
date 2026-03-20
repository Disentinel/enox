import { Router } from 'express';
import { listNodes, getNode, createNode, updateNode, deleteNode } from './nodes.js';
import {
  listAssertions,
  getAssertion,
  createAssertion,
  updateAssertion,
  deleteAssertion,
  getNeighbors,
} from './assertions.js';
import { ingest } from './ingest.js';
import { getContext } from './context.js';

export function createCrudRouter(): Router {
  const router = Router();

  // Nodes — URI-safe routes use /node?id=<encoded_uri>
  router.get('/nodes', listNodes);
  router.post('/nodes', createNode);
  router.get('/node', getNode);       // ?id=enox://...
  router.put('/node', updateNode);    // ?id=enox://...
  router.delete('/node', deleteNode); // ?id=enox://...
  // Legacy :id routes for simple IDs
  router.get('/nodes/:id', getNode);
  router.put('/nodes/:id', updateNode);
  router.delete('/nodes/:id', deleteNode);

  // Assertions
  router.get('/assertions', listAssertions);
  router.post('/assertions', createAssertion);
  router.get('/assertions/:fact_id', getAssertion);
  router.put('/assertions/:fact_id', updateAssertion);
  router.delete('/assertions/:fact_id', deleteAssertion);

  // Graph traversal — URI-safe route
  router.get('/graph/neighbors', getNeighbors); // ?id=enox://...
  router.get('/graph/neighbors/:id', getNeighbors);

  // Free-text ingestion
  router.post('/ingest', ingest);

  // Graph context for RAG (ambient hook)
  router.post('/context', getContext);

  return router;
}
