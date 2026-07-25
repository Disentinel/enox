// GraphStore: the interface MCP read tools query against. Two implementations exist —
// KuzuGraphStore (this file) reads the live main graph via db/kuzu.ts, and
// SnapshotGraphStore (src/shares/snapshot-store.ts) reads an in-memory share snapshot.
// Tools in read-tools.ts are written once against this interface and work over either.
import { queryAll, queryOne } from '../db/kuzu.js';

export interface NodeRecord {
  id: string;
  type: string;
  domain: string;
  name: string;
  description: string;
  aliases?: string[];
  /** URL/DOI/arxiv/doc-ref this entity was sourced from — provenance, surfaced read-side. */
  source_ref?: string;
  created_at?: string;
  updated_at?: string;
}

export interface EdgeRow {
  fact_id: string;
  source: string;
  source_name: string;
  source_type: string;
  target: string;
  target_name: string;
  target_type: string;
  relation: string;
  /** Who/what asserted this fact — human identity or "agent:<name>". Provenance, surfaced read-side. */
  asserted_by?: string;
  confidence: number;
  context: string;
  created_at?: string;
  updated_at?: string;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  by_domain: Array<{ domain: string; type: string; cnt: number }>;
  by_relation: Array<{ relation: string; cnt: number }>;
}

export interface SimilarityHit {
  id: string;
  score: number;
  match_type: 'node' | 'assertion';
}

export interface EdgeByFactId {
  source_id: string;
  source_name: string;
  source_domain: string;
  target_id: string;
  target_name: string;
  relation: string;
  asserted_by?: string;
  confidence: number;
  context: string;
}

export interface GraphStore {
  /** Human-readable label for this store (used in tool descriptions/errors). */
  readonly label: string;
  /** Whether semantic_search should be exposed for this store. */
  readonly supportsSemanticSearch: boolean;

  findNodes(opts: { query?: string; type?: string; domain?: string; limit?: number }): Promise<NodeRecord[]>;
  getNode(id: string): Promise<NodeRecord | null>;
  /** Resolve a node by ID, exact name, name-contains, then (best-effort) embedding similarity. */
  resolveNode(term: string): Promise<NodeRecord | null>;
  outgoing(id: string, relation?: string): Promise<EdgeRow[]>;
  incoming(id: string, relation?: string): Promise<EdgeRow[]>;
  stats(): Promise<GraphStats>;
  searchSimilar(query: string, topK: number): Promise<SimilarityHit[]>;
  getEdgeByFactId(factId: string): Promise<EdgeByFactId | null>;
}

const NODE_COLS =
  'e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.aliases AS aliases, e.source_ref AS source_ref, e.created_at AS created_at, e.updated_at AS updated_at';

const EDGE_COLS_OUT =
  'r.fact_id AS fact_id, a.id AS source, a.name AS source_name, a.type AS source_type, b.id AS target, b.name AS target_name, b.type AS target_type, r.relation AS relation, r.asserted_by AS asserted_by, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at';

export class KuzuGraphStore implements GraphStore {
  readonly label = 'main graph';
  readonly supportsSemanticSearch = true;

  async findNodes(opts: { query?: string; type?: string; domain?: string; limit?: number }): Promise<NodeRecord[]> {
    const { query, type, domain, limit } = opts;
    let cypher = 'MATCH (e:Entity) ';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query) {
      conditions.push('lower(e.name) CONTAINS lower($query)');
      params.query = query;
    }
    if (type) {
      conditions.push('e.type = $type');
      params.type = type;
    }
    if (domain) {
      conditions.push('e.domain STARTS WITH $domain');
      params.domain = domain;
    }
    if (conditions.length) cypher += 'WHERE ' + conditions.join(' AND ') + ' ';
    cypher += `RETURN ${NODE_COLS}`;
    if (limit) cypher += ` LIMIT ${limit}`;

    return queryAll<NodeRecord>(cypher, params);
  }

  async getNode(id: string): Promise<NodeRecord | null> {
    return queryOne<NodeRecord>(`MATCH (e:Entity) WHERE e.id = $id RETURN ${NODE_COLS}`, { id });
  }

  async resolveNode(term: string): Promise<NodeRecord | null> {
    let node = await this.getNode(term);
    if (node) return node;

    node = await queryOne<NodeRecord>(
      `MATCH (e:Entity) WHERE lower(e.name) = lower($name) RETURN ${NODE_COLS}`,
      { name: term },
    );
    if (node) return node;

    node = await queryOne<NodeRecord>(
      `MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($name) RETURN ${NODE_COLS} LIMIT 1`,
      { name: term },
    );
    if (node) return node;

    try {
      const { searchSimilar } = await import('../embeddings.js');
      const hits = await searchSimilar(term, 1);
      if (hits.length > 0 && hits[0].score > 0.4 && hits[0].match_type === 'node') {
        node = await this.getNode(hits[0].id);
        if (node) return node;
      }
    } catch { /* embeddings not ready */ }

    return null;
  }

  async outgoing(id: string, relation?: string): Promise<EdgeRow[]> {
    const relCond = relation ? ' AND r.relation = $relation' : '';
    const params: Record<string, unknown> = { id };
    if (relation) params.relation = relation;
    return queryAll<EdgeRow>(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id${relCond} RETURN ${EDGE_COLS_OUT}`,
      params,
    );
  }

  async incoming(id: string, relation?: string): Promise<EdgeRow[]> {
    const relCond = relation ? ' AND r.relation = $relation' : '';
    const params: Record<string, unknown> = { id };
    if (relation) params.relation = relation;
    return queryAll<EdgeRow>(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id${relCond} RETURN ${EDGE_COLS_OUT}`,
      params,
    );
  }

  async stats(): Promise<GraphStats> {
    const by_domain = await queryAll<{ domain: string; type: string; cnt: number }>(
      'MATCH (e:Entity) RETURN e.domain AS domain, e.type AS type, count(*) AS cnt',
    );
    const by_relation = await queryAll<{ relation: string; cnt: number }>(
      'MATCH ()-[r:Assertion]->() RETURN r.relation AS relation, count(*) AS cnt',
    );
    const totalNodes = await queryAll<{ cnt: number }>('MATCH (e:Entity) RETURN count(*) AS cnt');
    const totalEdges = await queryAll<{ cnt: number }>('MATCH ()-[r:Assertion]->() RETURN count(*) AS cnt');

    return {
      total_nodes: totalNodes[0]?.cnt ?? 0,
      total_edges: totalEdges[0]?.cnt ?? 0,
      by_domain,
      by_relation,
    };
  }

  async searchSimilar(query: string, topK: number): Promise<SimilarityHit[]> {
    const { searchSimilar } = await import('../embeddings.js');
    return searchSimilar(query, topK);
  }

  async getEdgeByFactId(factId: string): Promise<EdgeByFactId | null> {
    return queryOne<EdgeByFactId>(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fid
       RETURN a.id AS source_id, a.name AS source_name, a.domain AS source_domain,
              b.id AS target_id, b.name AS target_name, r.relation AS relation,
              r.asserted_by AS asserted_by, r.confidence AS confidence, r.context AS context`,
      { fid: factId },
    );
  }
}

export const mainGraphStore = new KuzuGraphStore();
