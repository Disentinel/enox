import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, closeDb } from './db.js';
import { createCrudRouter } from './crud/router.js';
import { mountMcpTransports } from './mcp/transport.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './embeddings.js';
import { startBackupWorker, stopBackupWorker, materialize, listSnapshots, getSnapshotPath } from './backup.js';
import { loadConfig } from './config.js';
import { initFederation } from './federation.js';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

async function main() {
  initFederation(config);
  await initDb(config.dbPath);

  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Static UI
  app.use(express.static(path.join(__dirname, 'public')));

  // CRUD API
  app.use('/api', createCrudRouter());

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

  // MCP transports (SSE + StreamableHTTP)
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

  // Federation-wide graph: merge local + all peers
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

      res.json({ nodes: allNodes, edges: allEdges });
    } catch (err: unknown) {
      res.status(500).json({ error: 'Federation query failed' });
    }
  });

  const server = app.listen(config.port, () => {
    console.log(`[enox] Node "${config.name}" (${config.mode}) listening on http://localhost:${config.port}`);
    console.log(`[enox] URI prefix: ${config.uriPrefix}`);
    console.log(`[enox] Peers: ${config.peers.length ? config.peers.map(p => p.prefix).join(', ') : '(none)'}`);
    console.log(`[enox] CRUD: http://localhost:${config.port}/api/nodes`);
    console.log(`[enox] UI:   http://localhost:${config.port}`);
  });

  // Background workers
  startEmbeddingWorker(30_000);  // Check for unembedded nodes every 30s
  startBackupWorker(15 * 60_000); // Snapshot every 15 min

  const shutdown = async () => {
    console.log('\n[enox] Shutting down...');
    stopEmbeddingWorker();
    stopBackupWorker();
    // Final snapshot on shutdown
    try {
      const r = await materialize();
      console.log(`[enox] Final snapshot: ${r.file}`);
    } catch {}
    server.close();
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
