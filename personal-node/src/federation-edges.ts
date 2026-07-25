import fs from 'node:fs';
import path from 'node:path';
import { computeFactId } from './util.js';

export interface CrossEdge {
  from: string;
  to: string;
  rel: string;
  confidence: number;
  context: string;
  fact_id: string;
  created_at: string;
}

const EDGES_FILE = path.resolve(
  process.env.FEDERATION_EDGES_PATH ?? './data/federation-edges.jsonl',
);

let edges: CrossEdge[] = [];

export function loadFederationEdges(): void {
  if (!fs.existsSync(EDGES_FILE)) {
    edges = [];
    return;
  }
  edges = [];
  for (const line of fs.readFileSync(EDGES_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      edges.push(JSON.parse(trimmed));
    } catch {}
  }
  console.log(`[federation] Loaded ${edges.length} cross-node edges`);
}

function save(): void {
  const dir = path.dirname(EDGES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = edges.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(EDGES_FILE, lines);
}

export function addFederationEdge(
  from: string,
  to: string,
  rel: string,
  confidence: number,
  context: string,
): CrossEdge | null {
  const fact_id = computeFactId(from, rel, to);

  // Dedup
  if (edges.some((e) => e.fact_id === fact_id)) {
    return null;
  }

  const edge: CrossEdge = {
    from,
    to,
    rel,
    confidence,
    context,
    fact_id,
    created_at: new Date().toISOString(),
  };
  edges.push(edge);
  save();
  return edge;
}

export function removeFederationEdge(fact_id: string): boolean {
  const idx = edges.findIndex((e) => e.fact_id === fact_id);
  if (idx === -1) return false;
  edges.splice(idx, 1);
  save();
  return true;
}

export function getFederationEdges(): CrossEdge[] {
  return edges;
}

/** Get edges involving a specific entity URI */
export function getEdgesForEntity(uri: string): CrossEdge[] {
  return edges.filter((e) => e.from === uri || e.to === uri);
}
