/**
 * Embeddings module — now backed by LanceDB instead of JSON.
 *
 * Keeps the same public API (startEmbeddingWorker, searchSimilar, etc.)
 * but stores vectors in LanceDB for persistence and scalability.
 */

import path from 'node:path';
import { queryAll } from './db.js';
import {
  openLanceDb,
  upsertEmbeddingsBatch,
  searchSimilarLance,
  getEmbeddingCount,
  hasEmbedding,
  migrateFromJson,
} from './lance.js';

// Lazy-loaded pipeline
let embedPipeline: any = null;
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2
const EMBEDDINGS_JSON = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'embeddings.json');

let workerRunning = false;
let workerInterval: ReturnType<typeof setInterval> | null = null;

// Initialize the embedding model (lazy, first call downloads ~80MB)
async function getEmbedder() {
  if (!embedPipeline) {
    console.log('[embed] Loading model all-MiniLM-L6-v2...');
    const { pipeline } = await import('@huggingface/transformers');
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    });
    console.log('[embed] Model loaded');
  }
  return embedPipeline;
}

// Embed a single text
async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data as Float32Array).slice(0, EMBEDDING_DIM);
}

/**
 * Search by embedding similarity — now via LanceDB vector search.
 */
export async function searchSimilar(
  query: string,
  topK = 10,
): Promise<Array<{ id: string; score: number }>> {
  const count = await getEmbeddingCount();
  if (count <= 1) return []; // only seed row

  const qVec = await embed(query);
  const results = await searchSimilarLance(qVec, topK);

  // Convert LanceDB distance to similarity score (L2 distance → 1/(1+d))
  return results.map((r) => ({
    id: r.id,
    score: 1 / (1 + (r._distance ?? 0)),
  }));
}

/**
 * Background worker: find unembedded nodes, process them in batches.
 */
async function processUnembedded(): Promise<number> {
  const allNodes = await queryAll<{ id: string; name: string; description: string; type: string }>(
    'MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.description AS description, e.type AS type',
  );

  // Filter to those not yet in LanceDB
  const toEmbed: typeof allNodes = [];
  for (const node of allNodes) {
    if (!(await hasEmbedding(node.id))) {
      toEmbed.push(node);
    }
  }

  if (toEmbed.length === 0) return 0;

  console.log(`[embed] ${toEmbed.length} unembedded nodes found`);

  const BATCH_SIZE = 20;
  let processed = 0;

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const records: Array<{ id: string; vector: number[]; name: string; type: string }> = [];

    for (const node of batch) {
      const text = `${node.name}. ${node.description || ''}`.trim();
      try {
        const vec = await embed(text);
        records.push({ id: node.id, vector: vec, name: node.name, type: node.type ?? 'concept' });
      } catch (err) {
        console.error(`[embed] Failed to embed ${node.id}:`, err);
      }
    }

    if (records.length > 0) {
      await upsertEmbeddingsBatch(records);
      processed += records.length;
      console.log(`[embed] Processed ${processed}/${toEmbed.length}...`);
    }
  }

  if (processed > 0) {
    console.log(`[embed] Done: ${processed} new embeddings`);
  }

  return processed;
}

/**
 * Load embeddings — migrate from JSON if needed, then open LanceDB.
 */
export async function loadEmbeddings(): Promise<void> {
  await openLanceDb();
  // Migrate old JSON store if it exists
  await migrateFromJson(EMBEDDINGS_JSON);
}

/**
 * Start the background embedding worker.
 */
export function startEmbeddingWorker(intervalMs = 30_000): void {
  // Load/migrate on startup (async)
  setTimeout(async () => {
    try {
      await loadEmbeddings();
    } catch (err) {
      console.error('[embed] Failed to load/migrate:', err);
    }

    // First run
    workerRunning = true;
    try {
      await processUnembedded();
    } catch (err) {
      console.error('[embed] Worker error:', err);
    }
    workerRunning = false;
  }, 5000);

  // Periodic
  workerInterval = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await processUnembedded();
    } catch (err) {
      console.error('[embed] Worker error:', err);
    }
    workerRunning = false;
  }, intervalMs);
}

export function stopEmbeddingWorker(): void {
  if (workerInterval) clearInterval(workerInterval);
}

export function getEmbeddingStats(): { total: number; embedded: number } {
  // Synchronous — return cached or -1
  return { total: -1, embedded: -1 }; // Use getEmbeddingCount() for async
}
