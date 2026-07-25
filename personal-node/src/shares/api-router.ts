// Plain-HTTP read API over a share's snapshot — for agents that can only do a
// browsing/fetch GET (e.g. a web chat agent with no MCP client). Every handler
// here is a thin wrapper: the actual query/formatting logic lives once in
// SnapshotGraphStore / src/mcp/read-tools.ts's run*() functions, exactly the
// same code the MCP tools call. Mounted at /share/:id/api behind shareAuth
// (see public.ts) — never behind the main requireAuth.
import fs from 'node:fs';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getSnapshotStore } from './cache.js';
import { buildShareSummary } from './summary.js';
import { buildShareManifest } from './manifest.js';
import { loadShareArtifactsIndex, getShareArtifactMeta, shareArtifactBlobPath } from './artifacts.js';
import { runExplore, runTraverse, runSemanticSearch } from '../mcp/read-tools.js';
import type { SnapshotGraphStore } from './snapshot-store.js';

declare global {
  namespace Express {
    interface Locals {
      snapshotStore?: SnapshotGraphStore;
    }
  }
}

// Real limits enforced by the handlers below — exported so manifest.ts's
// `limits` field can report the actual values instead of a second guess that
// could drift from these.
export const NODES_DEFAULT_LIMIT = 20;
export const NODES_MAX_LIMIT = 200;
export const TRAVERSE_DEFAULT_DEPTH = 2;
export const TRAVERSE_MIN_DEPTH = 1;
export const TRAVERSE_MAX_DEPTH = 3;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

function loadStore(req: Request, res: Response, next: NextFunction): void {
  const share = res.locals.share!;
  const shareId = res.locals.shareId!;
  const store = getSnapshotStore(shareId, share.name);
  if (!store) {
    res.status(404).json({ error: 'Share snapshot not found — try POST /api/shares/:id/refresh' });
    return;
  }
  res.locals.snapshotStore = store;
  next();
}

export function createShareApiRouter(): Router {
  const router = Router();
  router.use(loadStore);

  // Full machine manifest at the stable API base — the canonical contract an
  // agent parses to know what it can do here (see manifest.ts). Also reachable
  // via Accept: application/json on the share root, and the /manifest.json
  // alias (see public.ts) — all three build the exact same object.
  router.get('/', async (_req, res) => {
    const share = res.locals.share!;
    const shareId = res.locals.shareId!;
    const store = res.locals.snapshotStore!;
    const summary = await buildShareSummary(share, store);
    const manifest = await buildShareManifest(shareId, share, summary, store);
    res.json(manifest);
  });

  router.get('/summary', async (_req, res) => {
    const share = res.locals.share!;
    const store = res.locals.snapshotStore!;
    res.json(await buildShareSummary(share, store));
  });

  router.get('/nodes', async (req, res) => {
    const store = res.locals.snapshotStore!;
    const q = req.query.q as string | undefined;
    const type = req.query.type as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || NODES_DEFAULT_LIMIT, NODES_MAX_LIMIT);

    const nodes = await store.findNodes({ query: q, type, limit });
    res.json(nodes);
  });

  // nodeId is typically a full enox:// URI (contains slashes). A single Express
  // :param does capture slashes correctly as long as the client URL-encodes them
  // (encodeURIComponent turns "/" into "%2F", which path-to-regexp matches as part
  // of the segment and Express then decodes back into req.params) — verified this
  // empirically. ?id= is also accepted as a fallback for clients that don't bother
  // encoding, matching the same dual convention the main CRUD API uses (see
  // src/crud/router.ts's /node?id=... vs /nodes/:id).
  router.get('/nodes/:nodeId', async (req, res) => {
    const store = res.locals.snapshotStore!;
    const id = (req.query.id as string) || (req.params.nodeId as string);

    const node = await store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node "${id}" not found in this share` });
      return;
    }
    const outgoing = await store.outgoing(id);
    const incoming = await store.incoming(id);
    res.json({ node, outgoing, incoming });
  });

  router.get('/explore', async (req, res) => {
    const store = res.locals.snapshotStore!;
    const name = req.query.name as string | undefined;
    if (!name) {
      res.status(400).json({ error: 'name query param required' });
      return;
    }
    const result = await runExplore(store, name);
    if (!result) {
      res.status(404).json({ error: `Entity "${name}" not found in this share` });
      return;
    }
    res.json({ node: result.node, outgoing: result.outgoing, incoming: result.incoming, text: result.text });
  });

  router.get('/traverse', async (req, res) => {
    const store = res.locals.snapshotStore!;
    const from = req.query.from as string | undefined;
    if (!from) {
      res.status(400).json({ error: 'from query param required' });
      return;
    }
    const maxDepth = Math.min(Math.max(parseInt(req.query.depth as string, 10) || TRAVERSE_DEFAULT_DEPTH, TRAVERSE_MIN_DEPTH), TRAVERSE_MAX_DEPTH);
    const relation = req.query.relation as string | undefined;
    const direction = (req.query.direction as 'out' | 'in' | 'both') || 'both';

    const result = await runTraverse(store, { entity: from, maxDepth, relation, direction });
    if (!result) {
      res.status(404).json({ error: `Entity "${from}" not found in this share` });
      return;
    }
    res.json({
      start: result.startNode,
      nodes_discovered: result.nodesDiscovered,
      edges_count: result.edges.length,
      edges: result.edges,
      text: result.text,
    });
  });

  router.get('/search', async (req, res) => {
    const store = res.locals.snapshotStore!;
    if (!store.supportsSemanticSearch) {
      res.status(404).json({ error: 'Semantic search not available for this share — its snapshot carries no embeddings.' });
      return;
    }
    const q = req.query.q as string | undefined;
    if (!q) {
      res.status(400).json({ error: 'q query param required' });
      return;
    }
    const topK = Math.min(parseInt(req.query.limit as string, 10) || SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const result = await runSemanticSearch(store, { query: q, topK });
    res.json(result);
  });

  // Artifact bodies (skill-pack files, not graph nodes) that were in scope at
  // export/refresh time — see artifacts.ts. Metadata comes from the share's
  // own artifacts-index.json, never a live query against the main artifacts
  // store, so a guest can only ever see what was copied into this share.
  router.get('/artifacts', (_req: Request, res: Response) => {
    const shareId = res.locals.shareId!;
    res.json(loadShareArtifactsIndex(shareId));
  });

  router.get('/artifacts/:artifactId/raw', (req: Request, res: Response) => {
    const shareId = res.locals.shareId!;
    const meta = getShareArtifactMeta(shareId, req.params.artifactId as string);
    if (!meta) {
      res.status(404).json({ error: `Artifact "${req.params.artifactId}" not found in this share` });
      return;
    }
    const filePath = shareArtifactBlobPath(shareId, meta);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Artifact blob missing in this share' });
      return;
    }
    res.setHeader('Content-Type', meta.content_type);
    res.send(fs.readFileSync(filePath));
  });

  return router;
}
