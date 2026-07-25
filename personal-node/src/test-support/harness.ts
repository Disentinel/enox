// Test harness for the share-links feature. Each *.test.ts file that uses this
// runs in its own process (via scripts/test.sh, one `tsx --test` invocation per
// file) with KUZU_DB_PATH/SQLITE_PATH pointed at a fresh temp directory supplied
// through the environment — never the real data/ directory. This module builds
// a minimal Express app that mirrors index.ts's route wiring (CRUD, shares,
// main MCP) without the periodic background workers (embeddings/backup/dedup),
// which would otherwise try to download an ML model or touch real data.
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { initDb, execute } from '../db/kuzu.js';
import { initSqlite } from '../db/sqlite.js';
import { loadConfig } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import { createCrudRouter } from '../crud/router.js';
import { createSharesRouter } from '../shares/router.js';
import { mountShareRoutes } from '../shares/public.js';
import { mountMcpTransports } from '../mcp/transport.js';
import { createArtifactsRouter } from '../artifacts/router.js';

export interface TestHarness {
  app: Express;
  server: Server;
  baseUrl: string;
  authToken: string;
  stop: () => Promise<void>;
}

export async function startTestServer(): Promise<TestHarness> {
  const config = loadConfig();
  await initDb(config.dbPath);
  initSqlite(config.sqlitePath);

  const app = express();
  app.use(express.json());

  app.use('/api', requireAuth, createCrudRouter());
  app.use('/api/shares', requireAuth, createSharesRouter());
  app.use('/api/artifacts', requireAuth, createArtifactsRouter());

  mountShareRoutes(app);

  app.use(['/mcp', '/sse', '/sse/messages'], requireAuth);
  mountMcpTransports(app);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    authToken: config.authToken ?? '',
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      // Deliberately NOT calling closeDb()/closeSqlite() here. Reproduced independently
      // of this feature: the installed `kuzu` package (0.11.3) segfaults in native code
      // when Database.close() is called in a process that has executed ANY write query
      // (a plain CREATE is enough, no prepared statement needed) — read-only sessions
      // close fine. Each test file already runs in its own throwaway process against a
      // throwaway temp directory (see scripts/test.sh), so skipping the close here is
      // safe for tests; simply exiting leaves no dangling handles. This is flagged
      // separately as a production concern (src/index.ts's graceful-shutdown handler
      // calls closeDb() and likely hits the same crash) — not something to silently
      // paper over in application code.
    },
  };
}

export interface SeedEntity {
  id: string;
  type: string;
  domain: string;
  name: string;
  description?: string;
  /** URL/DOI/arxiv/doc-ref this entity was sourced from — provenance fixture for read-side tests. */
  source_ref?: string;
}

export interface SeedEdge {
  source: string;
  target: string;
  relation: string;
  fact_id: string;
  confidence?: number;
  context?: string;
  /** Who/what asserted this fact. Defaults to 'test' — override for provenance fixtures. */
  asserted_by?: string;
}

// Directly writes nodes/edges into KuzuDB, bypassing the HTTP API, for fast
// deterministic test fixtures.
export async function seedGraph(entities: SeedEntity[], edges: SeedEdge[]): Promise<void> {
  const now = new Date().toISOString();
  for (const e of entities) {
    await execute(
      'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, source_ref: $source_ref, created_at: $now, updated_at: $now})',
      { id: e.id, type: e.type, domain: e.domain, name: e.name, description: e.description ?? '', aliases: [], source_ref: e.source_ref ?? '', now },
    );
  }
  for (const e of edges) {
    await execute(
      `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
       CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $by, confidence: $confidence, proof_depth: $pd, context: $context, created_at: $now, updated_at: $now}]->(b)`,
      {
        source: e.source, target: e.target, fact_id: e.fact_id, relation: e.relation,
        by: e.asserted_by ?? 'test', confidence: e.confidence ?? 1.0, pd: 0, context: e.context ?? '', now,
      },
    );
  }
}
