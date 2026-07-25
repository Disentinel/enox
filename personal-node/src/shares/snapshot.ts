// Exports a filtered snapshot of the main graph for a share: all nodes whose domain
// is in scope, plus edges where BOTH endpoints are in scope (cross-domain edges are
// dropped by construction — they're simply never selected by the query below).
//
// Storage choice: flat JSONL (one JSON object per line) for nodes and edges, loaded
// fully into memory per share on first access (see snapshot-store.ts). A personal
// knowledge-graph domain slice is expected to be hundreds to low-thousands of nodes —
// small enough that JSONL-in-memory is trivially fast and needs no query engine. A
// per-share embedded KuzuDB was considered and rejected: spinning up N embedded
// database processes (one per share) is heavier to start, harder to keep consistent
// on refresh, and gives nothing a plain index over an array doesn't already provide
// at this scale.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { queryAll } from '../db/kuzu.js';
import { getEmbeddingsSubset } from '../embeddings.js';
import { computeLayout } from '../layout.js';
import { exportShareArtifacts } from './artifacts.js';
import type { NodeRecord, EdgeRow } from '../mcp/graph-store.js';

const SHARES_DIR = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'shares');

export function shareDir(id: string): string {
  return path.join(SHARES_DIR, id);
}

interface RawNodeRow {
  id: string; type: string; domain: string; name: string; description: string | null;
  aliases: string[] | null; source_ref: string | null; created_at: string; updated_at: string;
}

interface RawEdgeRow {
  fact_id: string; source: string; source_name: string; source_type: string;
  target: string; target_name: string; target_type: string; relation: string;
  asserted_by: string | null; confidence: number; context: string | null; created_at: string; updated_at: string;
}

// Content-addressed id for a snapshot's data (manifest.ts's snapshot.id) — a
// SHA256 of the canonicalized nodes+edges, so it changes if and only if the
// actual shared content changes, independent of *when* export ran. Computed
// here (once, at export/refresh time) and persisted to a sidecar file rather
// than recomputed per manifest request: hashing every node+edge on every GET
// would mean rehashing the whole snapshot just to answer "did anything
// change", the same cost as a re-export. Storing it next to nodes.jsonl/
// edges.jsonl/layout.json (rather than as a SQLite column on the shares
// table) keeps every artifact of "what got exported and how it's described"
// colocated in one directory, and needs no schema migration.
// Single source of truth for HOW canonicalizeSnapshot/computeSnapshotId turn a
// snapshot's nodes+edges into the exact bytes that get hashed. Surfaced verbatim
// in the share manifest (manifest.ts snapshot block) so a third party can
// recompute and verify snapshot.id without access to this code. INVARIANT: if you
// change canonicalizeSnapshot below you MUST update this object AND bump `scheme`
// — a description that has drifted from the code is worse than none. The field
// lists here are the authoritative order/inclusion used by canonicalizeSnapshot.
export const CANONICALIZATION = {
  scheme: 'enox-canon-v1',
  digest_algorithm: 'sha256',
  digest_encoding: 'hex',
  input_encoding: 'utf-8',
  // A single 0x01 (U+0001) control character joins the fields of one row. Chosen
  // because it cannot occur in real node/edge text, so no value can be mistaken
  // for a field boundary.
  field_delimiter: 'U+0001',
  // '\n' (U+000A) joins rows within a section.
  row_delimiter: 'U+000A',
  // The literal 3-byte separator between the node section and the edge section.
  section_separator: '\\n--\\n',
  // Rows are sorted AFTER being delimited, on the full row string, ascending, by
  // UTF-16 code unit (the JavaScript Array.prototype.sort default).
  row_sort: 'lexicographic ascending by UTF-16 code unit, applied to the fully-delimited row string',
  // Fields of each node row, in this exact order.
  node_fields: ['id', 'type', 'domain', 'name', 'description', 'aliases', 'source_ref'],
  // Fields of each edge row, in this exact order.
  edge_fields: ['fact_id', 'source', 'target', 'relation', 'asserted_by', 'confidence', 'context'],
  // A null/absent field is encoded as the empty string.
  null_field: 'empty string',
  // The node's alias list is joined by ',' (comma) into the single `aliases` field.
  aliases_encoding: "alias list joined by ',' (comma) into one field",
  // confidence (a number) is encoded via JavaScript String(number) — shortest
  // round-trip decimal (e.g. 1 -> "1", 0.9 -> "0.9").
  confidence_encoding: 'decimal string, JavaScript String(number)',
  description:
    'content_digest = SHA256 (hex) over the UTF-8 bytes of: ' +
    'for every in-scope node, a row = its fields [id, type, domain, name, description, ' +
    'aliases, source_ref] joined by the 0x01 delimiter (a null field -> empty string; ' +
    'aliases = the alias list joined by ","); all node rows sorted lexicographically and ' +
    'joined by "\\n"; then the literal separator "\\n--\\n"; then for every in-scope edge, ' +
    'a row = [fact_id, source, target, relation, asserted_by, confidence, context] joined ' +
    'by 0x01 (null -> empty string; confidence = decimal string); all edge rows sorted ' +
    'lexicographically and joined by "\\n". The share manifest itself is NOT part of the input.',
} as const;

function canonicalizeSnapshot(nodes: NodeRecord[], edges: EdgeRow[]): string {
  // SEP is a single control character (0x01), not the empty string — chosen
  // because it can't appear in real node/edge text, so a value containing a
  // comma or pipe can never be mistaken for a field boundary.
  const SEP = '';
  const nodeLines = nodes
    .map(n => [n.id, n.type, n.domain, n.name, n.description ?? '', (n.aliases ?? []).join(','), n.source_ref ?? ''].join(SEP))
    .sort();
  const edgeLines = edges
    .map(e => [e.fact_id, e.source, e.target, e.relation, e.asserted_by ?? '', String(e.confidence), e.context ?? ''].join(SEP))
    .sort();
  return nodeLines.join('\n') + '\n--\n' + edgeLines.join('\n');
}

export function computeSnapshotId(nodes: NodeRecord[], edges: EdgeRow[]): string {
  return createHash('sha256').update(canonicalizeSnapshot(nodes, edges)).digest('hex');
}

// Reads the persisted snapshot.id written by exportShareSnapshot. Returns
// null if it's missing (e.g. a snapshot exported before this file existed) —
// callers fall back to computing it on the fly from the loaded store in that case.
export function loadSnapshotId(shareId: string): string | null {
  const idPath = path.join(shareDir(shareId), 'snapshot-id.txt');
  try {
    return fs.readFileSync(idPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export async function exportShareSnapshot(
  shareId: string,
  domains: string[],
): Promise<{ node_count: number; edge_count: number; artifact_count: number }> {
  const dir = shareDir(shareId);
  fs.mkdirSync(dir, { recursive: true });

  // KuzuDB workaround (established elsewhere in this codebase, see crud/nodes.ts
  // similarNodes): passing an array directly as an `IN` parameter is avoided in
  // favor of an explicit `IN [$d0, $d1, ...]` list of individually bound params.
  const domainParams: Record<string, unknown> = {};
  const domainList = domains.map((d, i) => {
    domainParams[`d${i}`] = d;
    return `$d${i}`;
  }).join(', ');

  const nodeRows = await queryAll<RawNodeRow>(
    `MATCH (e:Entity) WHERE e.domain IN [${domainList}]
     RETURN e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description,
            e.aliases AS aliases, e.source_ref AS source_ref, e.created_at AS created_at, e.updated_at AS updated_at`,
    domainParams,
  );

  const edgeRows = await queryAll<RawEdgeRow>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity)
     WHERE a.domain IN [${domainList}] AND b.domain IN [${domainList}]
     RETURN r.fact_id AS fact_id, a.id AS source, a.name AS source_name, a.type AS source_type,
            b.id AS target, b.name AS target_name, b.type AS target_type, r.relation AS relation,
            r.asserted_by AS asserted_by, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
    domainParams,
  );

  const nodes: NodeRecord[] = nodeRows.map(n => ({
    id: n.id, type: n.type, domain: n.domain, name: n.name,
    description: n.description ?? '', aliases: n.aliases ?? [], source_ref: n.source_ref ?? '',
    created_at: n.created_at, updated_at: n.updated_at,
  }));

  const edges: EdgeRow[] = edgeRows.map(e => ({
    fact_id: e.fact_id, source: e.source, source_name: e.source_name, source_type: e.source_type,
    target: e.target, target_name: e.target_name, target_type: e.target_type, relation: e.relation,
    asserted_by: e.asserted_by ?? '', confidence: e.confidence, context: e.context ?? '', created_at: e.created_at, updated_at: e.updated_at,
  }));

  fs.writeFileSync(path.join(dir, 'nodes.jsonl'), nodes.map(n => JSON.stringify(n)).join('\n') + (nodes.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'edges.jsonl'), edges.map(e => JSON.stringify(e)).join('\n') + (edges.length ? '\n' : ''));

  // manifest.ts's snapshot.id — computed here (once, at export/refresh time),
  // not per manifest request. See computeSnapshotId's comment above.
  fs.writeFileSync(path.join(dir, 'snapshot-id.txt'), computeSnapshotId(nodes, edges));

  // Copy in-scope embeddings cheaply (in-memory filter + write, no re-embedding).
  const embeddingKeys = new Set<string>();
  for (const n of nodes) embeddingKeys.add(n.id);
  for (const e of edges) embeddingKeys.add(`assertion:${e.fact_id}`);
  const embeddingsSubset = getEmbeddingsSubset(embeddingKeys);
  fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify(embeddingsSubset));

  // Layout for the landing page's mini-explorer graph. Computed once here (both
  // on creation and on /refresh) and persisted — never recomputed per page view.
  // Iterations scale inversely with size to bound cost: small shares get the full
  // 300 for a settled layout, larger ones taper down to 100.
  const iterations = Math.round(Math.max(100, Math.min(300, 300 - nodes.length * 0.3)));
  const layout = computeLayout(
    nodes.map(n => ({ id: n.id, type: n.type })),
    edges.map(e => ({ source: e.source, target: e.target })),
    iterations,
  );
  fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout.positions));

  // Artifact blobs in scope (same domain filter as the node/edge queries
  // above) get copied into this share's own directory — see artifacts.ts for
  // why this is a copy-at-export-time step rather than a live re-read.
  const { artifact_count } = exportShareArtifacts(shareId, domains);

  return { node_count: nodes.length, edge_count: edges.length, artifact_count };
}

export function loadShareLayout(shareId: string): Record<string, { x: number; y: number }> | null {
  const layoutPath = path.join(shareDir(shareId), 'layout.json');
  if (!fs.existsSync(layoutPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteShareSnapshot(shareId: string): void {
  const dir = shareDir(shareId);
  fs.rmSync(dir, { recursive: true, force: true });
}
