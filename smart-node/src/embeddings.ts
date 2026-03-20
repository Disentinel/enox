import fs from 'node:fs';
import path from 'node:path';
import { queryAll, execute } from './db.js';

// Lazy-loaded pipeline
let embedPipeline: any = null;
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2
const EMBEDDINGS_FILE = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'embeddings.json');

// In-memory store: id → float[]
let store: Map<string, number[]> = new Map();
let workerRunning = false;
let workerInterval: ReturnType<typeof setInterval> | null = null;

// Load embeddings from disk
export function loadEmbeddings(): void {
  if (fs.existsSync(EMBEDDINGS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8'));
      store = new Map(Object.entries(raw));
      console.log(`[embed] Loaded ${store.size} embeddings from disk`);
    } catch {
      console.log('[embed] Failed to load embeddings file, starting fresh');
      store = new Map();
    }
  }
}

// Save embeddings to disk
function saveEmbeddings(): void {
  const dir = path.dirname(EMBEDDINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const obj: Record<string, number[]> = {};
  for (const [k, v] of store) obj[k] = v;
  fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(obj));
}

// Initialize the embedding model (lazy, first call downloads ~80MB)
async function getEmbedder() {
  if (!embedPipeline) {
    console.log('[embed] Loading model all-MiniLM-L6-v2 (first time may download ~80MB)...');
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

// Cosine similarity
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Search by embedding similarity
export async function searchSimilar(
  query: string,
  topK = 10,
): Promise<Array<{ id: string; score: number }>> {
  if (store.size === 0) return [];

  const qVec = await embed(query);
  const results: Array<{ id: string; score: number }> = [];

  for (const [id, vec] of store) {
    const score = cosineSim(qVec, vec);
    results.push({ id, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// Background worker: find unembedded nodes, process them one by one
async function processUnembedded(): Promise<number> {
  const allNodes = await queryAll<{ id: string; name: string; description: string }>(
    'MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.description AS description',
  );

  let processed = 0;
  for (const node of allNodes) {
    if (store.has(node.id)) continue;

    const text = `${node.name}. ${node.description || ''}`.trim();
    try {
      const vec = await embed(text);
      store.set(node.id, vec);
      processed++;

      // Save every 20 embeddings
      if (processed % 20 === 0) {
        saveEmbeddings();
        console.log(`[embed] Processed ${processed} nodes...`);
      }
    } catch (err) {
      console.error(`[embed] Failed to embed ${node.id}:`, err);
    }
  }

  if (processed > 0) {
    saveEmbeddings();
    console.log(`[embed] Done: ${processed} new embeddings (total: ${store.size})`);
  }

  return processed;
}

// Start the background embedding worker
export function startEmbeddingWorker(intervalMs = 30_000): void {
  loadEmbeddings();

  // Run immediately after startup (with delay to let server start)
  setTimeout(async () => {
    workerRunning = true;
    try {
      await processUnembedded();
    } catch (err) {
      console.error('[embed] Worker error:', err);
    }
    workerRunning = false;
  }, 5000);

  // Then periodically check for new unembedded nodes
  workerInterval = setInterval(async () => {
    if (workerRunning) return; // Skip if previous run still going
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

// Get embedding count
export function getEmbeddingStats(): { total: number; embedded: number } {
  return { total: -1, embedded: store.size }; // total needs a query
}
