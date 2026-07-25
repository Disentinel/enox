import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RELATION_TYPES, NODE_TYPES } from '../types.js';
import type { GraphStore, NodeRecord, EdgeRow } from './graph-store.js';

// One-line catalog used both when registering tools and when generating the
// share landing markdown, so the two never drift apart.
export const READ_TOOL_CATALOG: Array<{ name: string; oneLiner: string }> = [
  { name: 'query_graph', oneLiner: 'Search nodes by name/type, or pass node_id to get a node plus its neighbors.' },
  { name: 'graph_stats', oneLiner: 'Node/edge counts broken down by domain, type, and relation.' },
  { name: 'explore', oneLiner: 'Show one entity and all its incoming/outgoing relationships as readable text.' },
  { name: 'traverse', oneLiner: 'Multi-hop BFS from a starting entity — "what connects to X within N hops".' },
  { name: 'recall', oneLiner: 'Broad "what do we know about X" — text + semantic search, packed into a token budget.' },
];
export const SEMANTIC_SEARCH_CATALOG_ENTRY = {
  name: 'semantic_search',
  oneLiner: 'Meaning-based search over node names/descriptions using embeddings.',
};

// Domain-specific staleness TTL (kept identical to the main-graph tool set).
const STALENESS_TTL: Record<string, number> = { ml: 90, ai: 90, cs: 180, opinion: 365, memory: 180, default: 365 };

function addStaleness(row: Record<string, unknown>): Record<string, unknown> {
  const updatedAt = row.updated_at as string | undefined;
  if (!updatedAt) return row;
  const ageDays = Math.round((Date.now() - Date.parse(updatedAt)) / 86400000);
  const domain = (row.domain as string) || 'default';
  const ttl = STALENESS_TTL[domain] ?? STALENESS_TTL.default;
  return { ...row, age_days: ageDays, stale: ageDays > ttl };
}

// ─────────────────────────────────────────────────────────────────────────
// Core logic, extracted so it has exactly one implementation shared by the
// MCP tools below AND the plain-HTTP share API (src/shares/api-router.ts).
// Each function takes a GraphStore and returns a plain result — the MCP
// wrappers below just JSON.stringify (or pass through) into `content`; the
// HTTP handlers res.json() the same value directly.
// ─────────────────────────────────────────────────────────────────────────

export interface ExploreResult {
  node: NodeRecord;
  outgoing: EdgeRow[];
  incoming: EdgeRow[];
  text: string;
}

export async function runExplore(store: GraphStore, entity: string): Promise<ExploreResult | null> {
  const node = await store.resolveNode(entity);
  if (!node) return null;

  const outgoing = await store.outgoing(node.id);
  const incoming = await store.incoming(node.id);

  const lines: string[] = [];
  lines.push(`# ${node.name} (${node.type}, ${node.domain})`);
  if (node.description) lines.push(`> ${node.description}`);
  if (node.source_ref) lines.push(`Source: ${node.source_ref}`);
  lines.push(`Created: ${node.created_at} | Updated: ${node.updated_at}`);
  lines.push('');

  if (outgoing.length > 0) {
    lines.push(`## Outgoing (${outgoing.length})`);
    for (const e of outgoing) {
      const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
      const by = e.asserted_by ? ` [by ${e.asserted_by}]` : '';
      lines.push(`  ${node.name} --[${e.relation}]--> ${e.target_name}${conf}${by}`);
      if (e.context) lines.push(`    context: ${e.context.substring(0, 200)}`);
    }
    lines.push('');
  }

  if (incoming.length > 0) {
    lines.push(`## Incoming (${incoming.length})`);
    for (const e of incoming) {
      const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
      const by = e.asserted_by ? ` [by ${e.asserted_by}]` : '';
      lines.push(`  ${e.source_name} --[${e.relation}]--> ${node.name}${conf}${by}`);
      if (e.context) lines.push(`    context: ${e.context.substring(0, 200)}`);
    }
  }

  return { node, outgoing, incoming, text: lines.join('\n') };
}

export interface TraverseOptions {
  entity: string;
  maxDepth: number;
  relation?: string;
  direction: 'out' | 'in' | 'both';
}

export interface TraverseEdge {
  src: string; src_name: string; tgt: string; tgt_name: string;
  relation: string; asserted_by?: string; confidence: number; context: string; depth: number;
}

export interface TraverseResult {
  startNode: NodeRecord;
  nodesDiscovered: number;
  edges: TraverseEdge[];
  text: string;
}

export async function runTraverse(store: GraphStore, opts: TraverseOptions): Promise<TraverseResult | null> {
  const { entity, maxDepth, relation, direction } = opts;
  const startNode = await store.resolveNode(entity);
  if (!startNode) return null;

  const MAX_FRONTIER = 25;
  const visitedNodes = new Set<string>([startNode.id]);
  const collectedEdges: TraverseEdge[] = [];

  let frontier = [startNode.id];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.length === 0) break;
    const nextFrontier: string[] = [];

    for (const nodeId of frontier.slice(0, MAX_FRONTIER)) {
      if (direction === 'out' || direction === 'both') {
        for (const e of await store.outgoing(nodeId, relation)) {
          collectedEdges.push({ src: e.source, src_name: e.source_name, tgt: e.target, tgt_name: e.target_name, relation: e.relation, asserted_by: e.asserted_by, confidence: e.confidence, context: e.context, depth });
          if (!visitedNodes.has(e.target)) { visitedNodes.add(e.target); nextFrontier.push(e.target); }
        }
      }
      if (direction === 'in' || direction === 'both') {
        for (const e of await store.incoming(nodeId, relation)) {
          collectedEdges.push({ src: e.source, src_name: e.source_name, tgt: e.target, tgt_name: e.target_name, relation: e.relation, asserted_by: e.asserted_by, confidence: e.confidence, context: e.context, depth });
          if (!visitedNodes.has(e.source)) { visitedNodes.add(e.source); nextFrontier.push(e.source); }
        }
      }
    }
    frontier = nextFrontier;
  }

  const seenEdges = new Set<string>();
  const uniqueEdges = collectedEdges.filter(e => {
    const key = `${e.src}|${e.relation}|${e.tgt}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });

  const lines: string[] = [];
  lines.push(`# Traverse: ${startNode.name} (depth ≤ ${maxDepth}${relation ? `, relation=${relation}` : ''}${direction !== 'both' ? `, direction=${direction}` : ''})`);
  lines.push(`Discovered ${visitedNodes.size} nodes, ${uniqueEdges.length} edges\n`);

  for (let d = 1; d <= maxDepth; d++) {
    const atDepth = uniqueEdges.filter(e => e.depth === d);
    if (atDepth.length === 0) continue;
    lines.push(`## Depth ${d} (${atDepth.length} edges)`);
    for (const e of atDepth.sort((a, b) => b.confidence - a.confidence)) {
      const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
      const by = e.asserted_by ? ` [by ${e.asserted_by}]` : '';
      lines.push(`  ${e.src_name} --[${e.relation}]--> ${e.tgt_name}${conf}${by}`);
      if (e.context) lines.push(`    ${e.context.substring(0, 150)}`);
    }
    lines.push('');
  }

  return { startNode, nodesDiscovered: visitedNodes.size, edges: uniqueEdges, text: lines.join('\n') };
}

export interface SemanticSearchOptions {
  query: string;
  topK: number;
  domain?: string;
  includeEdges?: boolean;
}

export interface SemanticSearchResult {
  nodes: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
}

export async function runSemanticSearch(store: GraphStore, opts: SemanticSearchOptions): Promise<SemanticSearchResult> {
  const { query, topK, domain, includeEdges } = opts;
  const fetchK = domain ? topK * 3 : topK;
  const similar = await store.searchSimilar(query, includeEdges ? fetchK * 2 : fetchK);

  const nodes: Record<string, unknown>[] = [];
  for (const { id, score, match_type } of similar) {
    if (match_type === 'assertion') continue;
    const node = await store.getNode(id);
    if (!node) continue;
    if (domain && !node.domain.startsWith(domain)) continue;
    nodes.push(addStaleness({ ...node, similarity: Math.round(score * 1000) / 1000 }));
    if (nodes.length >= topK) break;
  }

  const result: SemanticSearchResult = { nodes };

  if (includeEdges) {
    const edges: Record<string, unknown>[] = [];
    for (const { id, score, match_type } of similar) {
      if (match_type !== 'assertion') continue;
      const factId = id.replace(/^assertion:/, '');
      const edge = await store.getEdgeByFactId(factId);
      if (!edge) continue;
      if (domain && !edge.source_domain.startsWith(domain)) continue;
      edges.push({ ...edge, similarity: Math.round(score * 1000) / 1000 });
      if (edges.length >= topK) break;
    }
    result.edges = edges;
  }

  return result;
}

export interface ReadToolsOptions {
  /** Include semantic_search (only meaningful if the store has embeddings). */
  includeSemanticSearch?: boolean;
  /** Best-effort usage tracking hook (main graph only — writes to sqlite). */
  trackUsage?: (nodeIds: string[]) => void;
}

// Registers the read-only tool subset (query_graph, graph_stats, explore, traverse,
// recall, and optionally semantic_search) against an arbitrary GraphStore. Used by
// the main /mcp server (over the live graph), each share's /share/:id/mcp server
// (over that share's snapshot), and indirectly by the plain-HTTP share API, which
// calls the same run*() functions above directly instead of going through MCP.
export function registerReadTools(server: McpServer, store: GraphStore, opts: ReadToolsOptions = {}): void {
  const track = opts.trackUsage ?? (() => {});

  server.registerTool(
    'query_graph',
    {
      description:
        'Search nodes in the knowledge graph. Filter by name query, node type, or get neighbors of a specific node.',
      inputSchema: {
        query: z.string().optional().describe('Text search in node names (case-insensitive)'),
        node_id: z.string().optional().describe('Get neighbors of this node'),
        relation: z.enum(RELATION_TYPES).optional().describe('Filter assertions by relation type'),
        type: z.enum(NODE_TYPES).optional().describe('Filter nodes by type'),
      },
    },
    async ({ query, node_id, relation, type }) => {
      if (node_id) {
        const outgoing = await store.outgoing(node_id, relation);
        const incoming = await store.incoming(node_id, relation);
        const node = await store.getNode(node_id);

        track([node_id, ...outgoing.map(r => r.target), ...incoming.map(r => r.source)]);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ node, outgoing, incoming }, null, 2) }],
        };
      }

      const nodes = await store.findNodes({ query, type });
      track(nodes.map(n => n.id));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(nodes, null, 2) }],
      };
    },
  );

  server.registerTool(
    'graph_stats',
    {
      description: `Get current graph statistics — node count, edge count, domain breakdown (${store.label}).`,
      inputSchema: {},
    },
    async () => {
      const stats = await store.stats();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
      };
    },
  );

  server.registerTool(
    'explore',
    {
      description:
        'Explore an entity and all its connections in a readable DSL format. Shows incoming and outgoing relationships with confidence scores.',
      inputSchema: {
        entity: z.string().describe('Entity name, ID, or search term'),
      },
    },
    async ({ entity }) => {
      const result = await runExplore(store, entity);
      if (!result) {
        return { content: [{ type: 'text' as const, text: `Entity "${entity}" not found` }], isError: true };
      }
      track([result.node.id]);
      return { content: [{ type: 'text' as const, text: result.text }] };
    },
  );

  server.registerTool(
    'traverse',
    {
      description:
        'Multi-hop graph traversal from a starting entity. Returns a subgraph of all nodes and edges reachable within max_depth hops. Use for questions like "what relates to X through Y" or "show everything connected to X".',
      inputSchema: {
        entity: z.string().describe('Starting entity — name, ID, or search term'),
        max_depth: z.number().int().min(1).max(3).optional().default(2).describe('Maximum traversal depth (1-3 hops)'),
        relation: z.enum(RELATION_TYPES).optional().describe('Filter edges by relation type (e.g. "outperforms", "fails_on", "alternative_to")'),
        direction: z.enum(['out', 'in', 'both']).optional().default('both').describe('Traversal direction'),
      },
    },
    async ({ entity, max_depth, relation, direction }) => {
      const result = await runTraverse(store, { entity, maxDepth: max_depth, relation, direction });
      if (!result) {
        return { content: [{ type: 'text' as const, text: `Entity "${entity}" not found` }], isError: true };
      }
      track([result.startNode.id, ...result.edges.flatMap(e => [e.src, e.tgt])]);
      return { content: [{ type: 'text' as const, text: result.text }] };
    },
  );

  server.registerTool(
    'recall',
    {
      description:
        'Recall everything known about a topic. Combines semantic search + text matching + 1-hop graph traversal, packed into a token budget. Use for broad "what do we know about X" queries.',
      inputSchema: {
        query: z.string().describe('Topic or question to recall knowledge about'),
        budget: z.number().int().min(100).max(10000).optional().default(1500).describe('Max tokens in response'),
        domain: z.string().optional().describe('Filter results by domain (e.g. "cs.SE", "cs.AI", "cs")'),
      },
    },
    async ({ query, budget, domain }) => {
      const charBudget = budget * 4;
      type Scored = NodeRecord & { score: number };
      const scored: Scored[] = [];

      const textMatches = await store.findNodes({ query, domain, limit: 20 });
      for (const n of textMatches) {
        scored.push({ ...n, score: n.name.toLowerCase() === query.toLowerCase() ? 10 : 5 });
      }

      if (store.supportsSemanticSearch) {
        try {
          const embResults = await store.searchSimilar(query, 15);
          for (const { id, score: embScore, match_type } of embResults) {
            if (embScore < 0.25 || match_type === 'assertion') continue;
            const existing = scored.find(s => s.id === id);
            if (existing) {
              existing.score += embScore * 5;
            } else {
              const n = await store.getNode(id);
              if (n) {
                if (domain && !n.domain.startsWith(domain)) continue;
                scored.push({ ...n, score: embScore * 5 });
              }
            }
          }
        } catch { /* embeddings not ready */ }
      }

      if (scored.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ nodes: [], edges: [], message: 'No matches found' }) }] };
      }

      scored.sort((a, b) => b.score - a.score);
      const seedIds = new Set(scored.slice(0, 10).map(s => s.id));

      type EdgeRowLike = { src: string; src_name: string; tgt: string; tgt_name: string; relation: string; asserted_by?: string; confidence: number; context: string };
      const neighborRows: EdgeRowLike[] = [];
      for (const seedId of seedIds) {
        for (const e of await store.outgoing(seedId)) {
          neighborRows.push({ src: e.source, src_name: e.source_name, tgt: e.target, tgt_name: e.target_name, relation: e.relation, asserted_by: e.asserted_by, confidence: e.confidence, context: e.context });
        }
        for (const e of await store.incoming(seedId)) {
          neighborRows.push({ src: e.source, src_name: e.source_name, tgt: e.target, tgt_name: e.target_name, relation: e.relation, asserted_by: e.asserted_by, confidence: e.confidence, context: e.context });
        }
      }

      const resultNodes: Array<{ name: string; type: string; description: string; source_ref?: string; score: number }> = [];
      const includedIds = new Set<string>();
      let usedChars = 0;

      for (const s of scored.slice(0, 30)) {
        const entry = `${s.name} (${s.type}): ${s.description || ''}`;
        const cost = entry.length;
        if (usedChars + cost > charBudget) break;
        resultNodes.push({ name: s.name, type: s.type, description: s.description || '', source_ref: s.source_ref, score: Math.round(s.score * 10) / 10 });
        includedIds.add(s.id);
        usedChars += cost;
      }

      const resultEdges: Array<{ source: string; relation: string; target: string; asserted_by?: string; confidence: number; context: string }> = [];
      const sortedEdges = [...neighborRows].sort((a, b) => b.confidence - a.confidence);
      const seenEdges = new Set<string>();

      for (const row of sortedEdges) {
        const edgeKey = `${row.src}|${row.relation}|${row.tgt}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        const edgeText = `${row.src_name} --[${row.relation}]--> ${row.tgt_name}`;
        const cost = edgeText.length + (row.context?.length || 0);
        if (usedChars + cost > charBudget) continue;

        resultEdges.push({ source: row.src_name, relation: row.relation, target: row.tgt_name, asserted_by: row.asserted_by, confidence: row.confidence, context: row.context || '' });
        usedChars += cost;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            nodes: resultNodes,
            edges: resultEdges,
            seeds: scored.slice(0, 5).map(s => s.name),
            budget_used: Math.ceil(usedChars / 4),
            budget_total: budget,
          }, null, 2),
        }],
      };
    },
  );

  if (opts.includeSemanticSearch && store.supportsSemanticSearch) {
    server.registerTool(
      'semantic_search',
      {
        description:
          'Search the knowledge graph by meaning using embeddings. Finds nodes whose name/description are semantically similar to the query, even if exact words differ.',
        inputSchema: {
          query: z.string().describe('Natural language query to search for'),
          top_k: z.number().int().min(1).max(50).optional().default(10).describe('Max results to return'),
          domain: z.string().optional().describe('Filter results by domain (e.g. "cs.SE", "cs.AI", "cs")'),
          include_edges: z.boolean().optional().default(false).describe('Also search edge contexts (assertion embeddings). Useful for finding relationships like "fails_on dynamic dispatch".'),
        },
      },
      async ({ query, top_k, domain, include_edges }) => {
        const result = await runSemanticSearch(store, { query, topK: top_k, domain, includeEdges: include_edges });
        track(result.nodes.map(r => r.id as string));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
}
