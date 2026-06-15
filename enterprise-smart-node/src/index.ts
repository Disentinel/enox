import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from './db/kuzu.js';
import { createCrudRouter } from './crud/router.js';
import { mountMcpTransports } from './mcp/transport.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './embeddings.js';
import { startBackupWorker, stopBackupWorker, materialize, listSnapshots, getSnapshotPath } from './backup.js';
import { loadConfig } from './config.js';
import { initFederation } from './federation.js';
import { loadFederationEdges, addFederationEdge, getFederationEdges, removeFederationEdge } from './federation-edges.js';
import { computeLayout } from './layout.js';
import fs from 'node:fs';
import { initSqlite, closeSqlite } from './db/sqlite.js';
import { requireAuth } from './auth/middleware.js';
import { createAdminRouter } from './auth/router.js';
import { ensureBootstrapAdmin } from './auth/users.js';
import { createQueueRouter } from './queue/router.js';
import { createWorkersRouter } from './workers/router.js';
import { createPerspectivesRouter } from './perspectives/router.js';
import { createMetricsRouter } from './metrics/router.js';
import { seedDefaults } from './perspectives/service.js';
import { reapStaleTasks } from './queue/service.js';
import { reapDeadWorkers } from './workers/service.js';
import { takeMetricSnapshot } from './metrics/service.js';
import { startDedupWorker, stopDedupWorker } from './workers/dedup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

async function main() {
  initFederation(config);
  loadFederationEdges();
  await initDb(config.dbPath);
  initSqlite(config.sqlitePath);
  seedDefaults(); // Seed default perspectives if empty

  // Bootstrap a first admin user + token so the admin GUI is reachable on a
  // fresh deployment. Only runs when there are zero users.
  const adminUser = process.env.ADMIN_USER ?? 'admin';
  const boot = ensureBootstrapAdmin(adminUser, process.env.ADMIN_TOKEN || undefined);
  if (boot.created) {
    console.log(`[auth] Bootstrapped admin user "${adminUser}".`);
    if (boot.token) {
      console.log(`[auth] Admin bearer token (store it now — shown once): ${boot.token}`);
    } else {
      console.log('[auth] Admin token = ADMIN_TOKEN from env.');
    }
  }

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Static UI — serve React SPA build if available, else legacy
  const spaDir = path.resolve(__dirname, '..', 'dist', 'client');
  if (fs.existsSync(spaDir)) {
    app.use(express.static(spaDir));
  }
  // Legacy UI fallback at /legacy
  app.use('/legacy', express.static(path.join(__dirname, 'public')));

  // Admin console (user + token management). Static HTML; the page calls the
  // /api/admin endpoints with an admin bearer token entered in the UI.
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // Admin API: user + token management (admin role required, enforced inside)
  app.use('/api/admin', createAdminRouter());

  // CRUD API (auth required)
  app.use('/api', requireAuth, createCrudRouter());

  // New API modules (auth required for writes)
  app.use('/api/queue', requireAuth, createQueueRouter());
  app.use('/api/workers', requireAuth, createWorkersRouter());
  app.use('/api/perspectives', requireAuth, createPerspectivesRouter());
  app.use('/api/metrics', createMetricsRouter()); // metrics are read-only, no auth needed

  // Export: materialize graph to JSONL snapshot
  app.post('/api/export', async (_req, res) => {
    try {
      const result = await materialize();
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  // List snapshots
  app.get('/api/snapshots', (_req, res) => {
    res.json(listSnapshots());
  });

  // Download snapshot
  app.get('/api/snapshots/:name', (req, res) => {
    const filepath = getSnapshotPath(req.params.name);
    if (!filepath) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    fs.createReadStream(filepath).pipe(res);
  });

  // Server-side layout computation (ForceAtlas2)
  app.post('/api/layout', async (req, res) => {
    try {
      const { nodes, edges, iterations = 100 } = req.body;
      const result = computeLayout(nodes, edges, iterations);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Layout failed' });
    }
  });

  // MCP transports (SSE + StreamableHTTP) — auth required for writes
  app.use(['/mcp', '/sse', '/sse/messages'], requireAuth);
  mountMcpTransports(app);

  // Federation info endpoint
  app.get('/api/node-info', (_req, res) => {
    res.json({
      name: config.name,
      uriPrefix: config.uriPrefix,
      mode: config.mode,
      peers: config.peers.map(p => ({ prefix: p.prefix, url: p.url })),
    });
  });

  // Cross-node edge CRUD
  app.get('/api/federation/edges', (_req, res) => {
    res.json(getFederationEdges());
  });

  app.post('/api/federation/edges', (req, res) => {
    const { from, to, rel, confidence = 1.0, context = '' } = req.body;
    if (!from || !to || !rel) {
      res.status(400).json({ error: 'from, to, rel required' });
      return;
    }
    const edge = addFederationEdge(from, to, rel, confidence, context);
    if (!edge) {
      res.status(409).json({ error: 'Edge already exists' });
      return;
    }
    res.status(201).json(edge);
  });

  app.delete('/api/federation/edges/:fact_id', (req, res) => {
    if (removeFederationEdge(req.params.fact_id)) {
      res.status(204).end();
    } else {
      res.status(404).json({ error: 'Edge not found' });
    }
  });

  // Federation-wide graph: merge local + all peers + cross-edges
  app.get('/api/federation/graph', async (_req, res) => {
    try {
      // Local data
      const localNodes = await (await fetch(`http://localhost:${config.port}/api/nodes`)).json() as any[];
      const localEdges = await (await fetch(`http://localhost:${config.port}/api/assertions`)).json() as any[];

      const allNodes = localNodes.map((n: any) => ({ ...n, _node: config.name }));
      const allEdges = [...localEdges];
      const seenNodeIds = new Set(localNodes.map((n: any) => n.id));

      // Fetch from each peer
      for (const peer of config.peers) {
        try {
          const peerInfo = await (await fetch(`${peer.url}/api/node-info`)).json() as any;
          const peerNodes = await (await fetch(`${peer.url}/api/nodes`)).json() as any[];
          const peerEdges = await (await fetch(`${peer.url}/api/assertions`)).json() as any[];

          for (const n of peerNodes) {
            if (!seenNodeIds.has(n.id)) {
              allNodes.push({ ...n, _node: peerInfo.name || peer.prefix });
              seenNodeIds.add(n.id);
            }
          }
          allEdges.push(...peerEdges);
        } catch {
          // Peer unreachable, skip
        }
      }

      // Inject cross-node edges
      const crossEdges = getFederationEdges();
      for (const ce of crossEdges) {
        allEdges.push({
          source: ce.from,
          target: ce.to,
          relation: ce.rel,
          confidence: ce.confidence,
          context: ce.context,
          fact_id: ce.fact_id,
          _cross: true,
        });
      }

      res.json({ nodes: allNodes, edges: allEdges });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Federation query failed' });
    }
  });

  // SPA catch-all: serve index.html for client-side routing (Express 5 syntax)
  const spaIndex = path.join(spaDir, 'index.html');
  if (fs.existsSync(spaIndex)) {
    app.get('{*path}', (_req, res) => {
      res.sendFile(spaIndex);
    });
  }

  const server = app.listen(config.port, () => {
    console.log(`[enox] Node "${config.name}" (${config.mode}) listening on http://localhost:${config.port}`);
    console.log(`[enox] URI prefix: ${config.uriPrefix}`);
    console.log(`[enox] Peers: ${config.peers.length ? config.peers.map(p => p.prefix).join(', ') : '(none)'}`);
    console.log(`[enox] CRUD: http://localhost:${config.port}/api/nodes`);
    console.log(`[enox] UI:   http://localhost:${config.port}`);
    console.log(`[enox] Queue API: http://localhost:${config.port}/api/queue`);
    console.log(`[enox] Auth: ${config.mode === 'public' ? 'disabled (public read-only node)' : 'bearer-token required (per-user tokens)'}`);
    console.log(`[enox] Admin console: http://localhost:${config.port}/admin`);
  });

  // Background workers
  startEmbeddingWorker(30_000);  // Check for unembedded nodes every 30s
  startBackupWorker(15 * 60_000); // Snapshot every 15 min
  startDedupWorker(60 * 60_000);  // Entity dedup every 1 hour (first run after 2 min)

  // Stale task reaper: check every 60s for tasks with no heartbeat for 5 min
  const staleTaskInterval = setInterval(() => {
    try {
      const count = reapStaleTasks(5 * 60_000);
      if (count > 0) console.log(`[queue] Reaped ${count} stale tasks`);
    } catch (err) {
      console.error('[queue] Stale task reaper error:', err);
    }
  }, 60_000);

  // Worker health checker: every 60s
  const workerHealthInterval = setInterval(() => {
    try {
      const count = reapDeadWorkers(10 * 60_000);
      if (count > 0) console.log(`[workers] Marked ${count} workers as dead`);
    } catch (err) {
      console.error('[workers] Health checker error:', err);
    }
  }, 60_000);

  // Metric snapshotter: every 5 min
  const metricInterval = setInterval(async () => {
    try {
      await takeMetricSnapshot();
    } catch (err) {
      console.error('[metrics] Snapshot error:', err);
    }
  }, 5 * 60_000);

  const shutdown = async () => {
    console.log('\n[enox] Shutting down...');
    clearInterval(staleTaskInterval);
    clearInterval(workerHealthInterval);
    clearInterval(metricInterval);
    stopEmbeddingWorker();
    stopBackupWorker();
    stopDedupWorker();
    // Final snapshot on shutdown
    try {
      const r = await materialize();
      console.log(`[enox] Final snapshot: ${r.file}`);
    } catch {}
    server.close();
    closeSqlite();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[enox] Fatal error:', err);
  process.exit(1);
});
