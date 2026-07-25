// Builds the exact `DATA` object the approved design (share-receipt.html)
// expects to find in its `const DATA = {...}` declaration. One function, one
// source of truth, consumed by both the full-graph (<=MAX_SVG_NODES) and the
// no-graph fallback path — the difference between them is only whether
// `positions`/`nodes`/`edges` are populated (see buildReceiptData below).
import type { GraphStore } from '../mcp/graph-store.js';
import type { ShareRecord } from './types.js';
import type { ShareSummary } from './summary.js';
import { loadShareArtifactsIndex } from './artifacts.js';

// Graphs above this size skip the SVG (a force-directed drawing of thousands
// of nodes is unreadable anyway, and embedding full node/edge/position data
// for that many nodes bloats the page) in favor of a search+explorer view
// backed by the live HTTP API.
export const MAX_SVG_NODES = 400;

export interface ReceiptShareData {
  name: string;
  description: string;
  domains: string[];
  node_count: number;
  edge_count: number;
  nodes_by_type: Record<string, number>;
  snapshot_at: string;
  expires_at: string | null;
  owner_name: string | null;
  landing_url: string;
  /** Display/copy value, token included — also the fetchable "API index" URL. */
  api_base_url: string;
  /** Bare path, no token — internal use only, for building sub-paths client-side. */
  api_path: string;
  token: string;
  mcp_url: string;
  has_semantic_search: boolean;
}

export interface ReceiptNodeData {
  id: string;
  type: string;
  name: string;
  description: string;
  /** URL/DOI/arxiv/doc-ref this entity was sourced from — provenance, rendered as a link in the explorer. */
  source_ref?: string;
}

export interface ReceiptEdgeData {
  source: string;
  target: string;
  relation: string;
  /** Who/what asserted this fact — provenance, rendered next to the relation in the explorer. */
  asserted_by?: string;
  /** The assertion's context prose (e.g. a term's definition on a part_of edge) — rendered under the relation in the explorer. */
  context?: string;
}

/** One artifact (skill file, note, etc.) in scope for this share — see artifacts.ts's ShareArtifactMeta. */
export interface ReceiptArtifactData {
  id: string;
  title: string;
  content_type: string;
  filename: string | null;
}

export interface ReceiptData {
  share: ReceiptShareData;
  nodes: ReceiptNodeData[];
  edges: ReceiptEdgeData[];
  positions?: Record<string, { x: number; y: number }>;
  central_entities: string[];
  decisions: Array<{ id: string; rejected: string[] }>;
  /** Always present (possibly empty) — the receipt only renders a Documents section when non-empty. */
  artifacts: ReceiptArtifactData[];
}

export interface ReceiptUrls {
  landingUrl: string;
  apiPath: string;
  mcpUrl: string;
  token: string;
}

function formatTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  // Same locale-independent convention used elsewhere (explore/traverse tools,
  // the previous receipt page): a plain rendering of the stored ISO string.
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16) + ' UTC';
}

export async function buildReceiptData(
  share: ShareRecord,
  summary: ShareSummary,
  store: GraphStore,
  positions: Record<string, { x: number; y: number }> | null,
  urls: ReceiptUrls,
  ownerName: string | null,
): Promise<ReceiptData> {
  const shareData: ReceiptShareData = {
    name: summary.name,
    description: summary.description ?? '',
    domains: summary.domains,
    node_count: summary.node_count,
    edge_count: summary.edge_count,
    nodes_by_type: summary.nodes_by_type,
    snapshot_at: formatTimestamp(summary.snapshot_at) ?? 'unknown',
    expires_at: formatTimestamp(summary.expires_at),
    owner_name: ownerName,
    landing_url: urls.landingUrl,
    api_base_url: `${urls.apiPath}?token=${urls.token}`,
    api_path: urls.apiPath,
    token: urls.token,
    mcp_url: urls.mcpUrl,
    has_semantic_search: summary.has_semantic_search,
  };

  const central_entities = summary.central_entities.map(e => e.id);
  const decisions = summary.decisions.map(d => ({ id: d.id, rejected: d.rejected.map(r => r.id) }));

  // Independent of the graph-eligibility branch below — artifacts are never
  // graph nodes, so a share can carry documents even at 0 nodes or past the
  // SVG threshold, and the receipt page should still surface them either way.
  const artifacts: ReceiptArtifactData[] = loadShareArtifactsIndex(share.id)
    .map(a => ({ id: a.id, title: a.title, content_type: a.content_type, filename: a.filename }));

  const graphEligible = positions !== null && summary.node_count <= MAX_SVG_NODES;
  if (!graphEligible) {
    return { share: shareData, nodes: [], edges: [], central_entities, decisions, artifacts };
  }

  const allNodes = await store.findNodes({});
  const nodes: ReceiptNodeData[] = allNodes
    .filter(n => positions![n.id])
    .map(n => ({ id: n.id, type: n.type, name: n.name, description: n.description ?? '', source_ref: n.source_ref ?? '' }));

  // GraphStore only exposes per-node traversal (outgoing/incoming) — the
  // caller passes a store that also has allEdges() (SnapshotGraphStore does)
  // when the graph-eligible path is taken; see public.ts.
  const store2 = store as GraphStore & { allEdges?: () => Array<{ source: string; target: string; relation: string; asserted_by?: string; context?: string }> };
  const rawEdges = store2.allEdges ? store2.allEdges() : [];
  const edges: ReceiptEdgeData[] = rawEdges
    .filter(e => positions![e.source] && positions![e.target])
    .map(e => ({ source: e.source, target: e.target, relation: e.relation, asserted_by: e.asserted_by ?? '', context: e.context ?? '' }));

  return { share: shareData, nodes, edges, positions: positions!, central_entities, decisions, artifacts };
}
