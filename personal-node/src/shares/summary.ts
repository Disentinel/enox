// Shared summary computation — used by both the markdown/HTML landing page and
// the plain-HTTP GET /share/:id/api/summary endpoint, so the two can never disagree
// about node/edge counts.
import type { GraphStore, NodeRecord } from '../mcp/graph-store.js';
import type { ShareRecord } from './types.js';

export interface CentralEntity {
  id: string;
  name: string;
  type: string;
  degree: number;
  source_ref?: string;
}

export interface RejectedAlternative {
  id: string;
  name: string;
  relation: string;
}

export interface DecisionWithRejects {
  id: string;
  name: string;
  description: string;
  rejected: RejectedAlternative[];
}

export interface ShareSummary {
  name: string;
  description: string | null;
  domains: string[];
  node_count: number;
  edge_count: number;
  nodes_by_type: Record<string, number>;
  edges_by_relation: Record<string, number>;
  has_semantic_search: boolean;
  snapshot_at: string | null;
  expires_at: string | null;
  central_entities: CentralEntity[];
  decisions: DecisionWithRejects[];
}

const MAX_CENTRAL_ENTITIES = 6;
// A receipt is meant to be read at a glance — cap how many decisions it lists,
// surfacing the ones with the most rejected alternatives first (the most
// "interesting" decisions to a human skimming what they're sharing).
const MAX_DECISIONS = 20;

export async function buildShareSummary(share: ShareRecord, store: GraphStore): Promise<ShareSummary> {
  const stats = await store.stats();

  const nodes_by_type: Record<string, number> = {};
  for (const row of stats.by_domain) {
    nodes_by_type[row.type] = (nodes_by_type[row.type] ?? 0) + row.cnt;
  }

  const edges_by_relation: Record<string, number> = {};
  for (const row of stats.by_relation) {
    edges_by_relation[row.relation] = (edges_by_relation[row.relation] ?? 0) + row.cnt;
  }

  const allNodes = await store.findNodes({});

  const central_entities = await computeCentralEntities(store, allNodes);
  const decisions = await computeDecisionsWithRejects(store, allNodes);

  return {
    name: share.name,
    description: share.description,
    domains: share.domains,
    node_count: stats.total_nodes,
    edge_count: stats.total_edges,
    nodes_by_type,
    edges_by_relation,
    has_semantic_search: store.supportsSemanticSearch,
    snapshot_at: share.snapshot_at,
    expires_at: share.expires_at,
    central_entities,
    decisions,
  };
}

async function computeCentralEntities(store: GraphStore, allNodes: NodeRecord[]): Promise<CentralEntity[]> {
  const withDegree = await Promise.all(allNodes.map(async n => {
    const degree = (await store.outgoing(n.id)).length + (await store.incoming(n.id)).length;
    return { id: n.id, name: n.name, type: n.type, degree, source_ref: n.source_ref };
  }));
  withDegree.sort((a, b) => b.degree - a.degree);
  return withDegree.slice(0, MAX_CENTRAL_ENTITIES);
}

async function computeDecisionsWithRejects(store: GraphStore, allNodes: NodeRecord[]): Promise<DecisionWithRejects[]> {
  const decisionNodes = allNodes.filter(n => n.type === 'decision');
  if (decisionNodes.length === 0) return [];

  const withRejects = await Promise.all(decisionNodes.map(async d => {
    const [outgoing, incoming] = await Promise.all([store.outgoing(d.id), store.incoming(d.id)]);
    const rejected: RejectedAlternative[] = [];
    for (const e of outgoing) {
      if (e.target_type === 'rejected_alternative') rejected.push({ id: e.target, name: e.target_name, relation: e.relation });
    }
    for (const e of incoming) {
      if (e.source_type === 'rejected_alternative') rejected.push({ id: e.source, name: e.source_name, relation: e.relation });
    }
    return { id: d.id, name: d.name, description: d.description ?? '', rejected };
  }));

  withRejects.sort((a, b) => b.rejected.length - a.rejected.length);
  return withRejects.slice(0, MAX_DECISIONS);
}
