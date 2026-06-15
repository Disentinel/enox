import fs from 'node:fs';
import path from 'node:path';
import { queryAll } from './db/kuzu.js';

const SNAPSHOTS_DIR = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'snapshots');
let backupInterval: ReturnType<typeof setInterval> | null = null;

// Materialize entire graph to JSONL
export async function materialize(): Promise<{ file: string; nodes: number; edges: number }> {
  if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `snapshot-${timestamp}.jsonl`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);

  // Export nodes
  const nodes = await queryAll<Record<string, unknown>>(
    'MATCH (e:Entity) RETURN e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.source_ref AS source_ref, e.created_at AS created_at, e.updated_at AS updated_at',
  );

  // Export edges
  const edges = await queryAll<Record<string, unknown>>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity)
     RETURN a.id AS source, b.id AS target, r.fact_id AS fact_id, r.relation AS relation,
            r.asserted_by AS asserted_by, r.confidence AS confidence, r.proof_depth AS proof_depth,
            r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
  );

  const lines: string[] = [];

  for (const n of nodes) {
    lines.push(JSON.stringify({
      _type: 'node',
      id: n.id,
      node_type: n.type,
      domain: n.domain || 'cs',
      label: n.name,
      description: n.description || '',
      aliases: n.aliases || [],
      source_ref: n.source_ref || '',
      created_at: n.created_at,
      updated_at: n.updated_at,
    }));
  }

  for (const e of edges) {
    lines.push(JSON.stringify({
      _type: 'edge',
      from: e.source,
      to: e.target,
      fact_id: e.fact_id,
      rel: e.relation,
      asserted_by: e.asserted_by || 'system',
      confidence: e.confidence ?? 1.0,
      proof_depth: e.proof_depth ?? 0,
      context: e.context || '',
      created_at: e.created_at,
      updated_at: e.updated_at,
    }));
  }

  fs.writeFileSync(filepath, lines.join('\n') + '\n');

  // Keep last 20 snapshots, delete older
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.jsonl'))
    .sort();
  while (files.length > 20) {
    const old = files.shift()!;
    fs.unlinkSync(path.join(SNAPSHOTS_DIR, old));
  }

  // Also write a latest.jsonl symlink/copy for easy access
  const latestPath = path.join(SNAPSHOTS_DIR, 'latest.jsonl');
  try { fs.unlinkSync(latestPath); } catch {}
  fs.copyFileSync(filepath, latestPath);

  return { file: filename, nodes: nodes.length, edges: edges.length };
}

// Start periodic backup
export function startBackupWorker(intervalMs = 15 * 60 * 1000): void {
  // First backup after 30s
  setTimeout(async () => {
    try {
      const r = await materialize();
      console.log(`[backup] Snapshot: ${r.file} (${r.nodes} nodes, ${r.edges} edges)`);
    } catch (err) {
      console.error('[backup] Error:', err);
    }
  }, 30_000);

  backupInterval = setInterval(async () => {
    try {
      const r = await materialize();
      console.log(`[backup] Snapshot: ${r.file} (${r.nodes} nodes, ${r.edges} edges)`);
    } catch (err) {
      console.error('[backup] Error:', err);
    }
  }, intervalMs);
}

export function stopBackupWorker(): void {
  if (backupInterval) clearInterval(backupInterval);
}

// List available snapshots
export function listSnapshots(): string[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.jsonl'))
    .sort()
    .reverse();
}

// Get snapshot path
export function getSnapshotPath(filename: string): string | null {
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  return fs.existsSync(filepath) ? filepath : null;
}
