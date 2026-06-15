import { z } from 'zod';
import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { computeFactId } from '../util.js';
import { SUGGESTED_NODE_TYPES, SUGGESTED_RELATION_TYPES, ENTITY_URI_PREFIX } from '../types.js';
import { searchSimilar } from '../embeddings.js';
import { getSqlite } from '../db/sqlite.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Usage tracking: increment query_count for accessed nodes
function trackNodeUsage(nodeIds: string[]): void {
  try {
    const db = getSqlite();
    const upsert = db.prepare(
      `INSERT INTO node_usage (node_id, query_count, last_queried_at)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(node_id) DO UPDATE SET query_count = query_count + 1, last_queried_at = datetime('now')`,
    );
    for (const id of nodeIds) {
      if (id) upsert.run(id);
    }
  } catch { /* usage tracking is best-effort */ }
}

// Staleness detection: domain-specific TTL in days
const STALENESS_TTL: Record<string, number> = { ml: 90, ai: 90, cs: 180, opinion: 365, memory: 180, default: 365 };

function addStaleness(row: Record<string, unknown>): Record<string, unknown> {
  const updatedAt = row.updated_at as string | undefined;
  if (!updatedAt) return row;
  const ageDays = Math.round((Date.now() - Date.parse(updatedAt)) / 86400000);
  const domain = (row.domain as string) || 'default';
  const ttl = STALENESS_TTL[domain] ?? STALENESS_TTL.default;
  return { ...row, age_days: ageDays, stale: ageDays > ttl };
}

// Schemaless: node type / relation are free strings. We surface the suggested
// vocabularies in tool descriptions so agents have a sensible starting palette,
// but nothing is validated against them.
const NODE_TYPE_HINT = `Node type (free-form string). Common: ${SUGGESTED_NODE_TYPES.join(', ')}`;
const RELATION_HINT = `Relation type (free-form string). Common: ${SUGGESTED_RELATION_TYPES.slice(0, 24).join(', ')}, ...`;

/**
 * Register all MCP tools on `server`. Every assertion/node write is attributed
 * to `assertedBy` — the authenticated caller's username — so multi-tenant
 * provenance is automatic and never hardcoded.
 */
export function registerTools(server: McpServer, assertedBy: string): void {
  server.registerTool(
    'query_graph',
    {
      description:
        'Search nodes in the knowledge graph. Filter by name query, node type, or get neighbors of a specific node.',
      inputSchema: {
        query: z.string().optional().describe('Text search in node names (case-insensitive)'),
        node_id: z.string().optional().describe('Get neighbors of this node'),
        relation: z.string().optional().describe('Filter assertions by relation type'),
        type: z.string().optional().describe('Filter nodes by type'),
      },
    },
    async ({ query, node_id, relation, type }) => {
      // If node_id is given, return neighbors
      if (node_id) {
        const conditions = relation ? 'AND r.relation = $relation ' : '';
        const params: Record<string, unknown> = { id: node_id };
        if (relation) params.relation = relation;

        const outgoing = await queryAll(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id ${conditions}
           RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, b.name AS target_name, b.type AS target_type, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
          params,
        );
        const incoming = await queryAll(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id ${conditions}
           RETURN r.fact_id AS fact_id, a.id AS source, a.name AS source_name, a.type AS source_type, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at`,
          params,
        );

        const node = await queryOne(
          'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.created_at AS created_at, e.updated_at AS updated_at',
          { id: node_id },
        );

        // Track usage
        const touchedIds = [node_id, ...outgoing.map((r: Record<string, unknown>) => r.target as string), ...incoming.map((r: Record<string, unknown>) => r.source as string)];
        trackNodeUsage(touchedIds);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ node, outgoing, incoming }, null, 2),
            },
          ],
        };
      }

      // Otherwise, search/filter nodes
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

      if (conditions.length) {
        cypher += 'WHERE ' + conditions.join(' AND ') + ' ';
      }

      cypher +=
        'RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.aliases AS aliases, e.created_at AS created_at, e.updated_at AS updated_at';

      const nodes = await queryAll(cypher, params);
      trackNodeUsage(nodes.map((n: Record<string, unknown>) => n.id as string));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(nodes, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'add_assertion',
    {
      description:
        'Add an assertion (edge) between two entities. Auto-creates source and target nodes if they do not exist.',
      inputSchema: {
        source: z.string().describe('Source node name or ID'),
        target: z.string().describe('Target node name or ID'),
        relation: z.string().describe(RELATION_HINT),
        source_type: z.string().optional().default('concept').describe(`Type for auto-created source node. ${NODE_TYPE_HINT}`),
        source_domain: z.string().optional().default('cs').describe('Knowledge domain for auto-created source node'),
        target_type: z.string().optional().default('concept').describe(`Type for auto-created target node. ${NODE_TYPE_HINT}`),
        target_domain: z.string().optional().default('cs').describe('Knowledge domain for auto-created target node'),
        confidence: z.number().min(0).max(1).optional().default(1.0),
        context: z.string().optional().describe('Why this assertion holds'),
      },
    },
    async ({ source, target, relation, source_type, source_domain, target_type, target_domain, confidence, context }) => {
      // Auto-create source node if not found
      let srcNode = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: source },
      );
      if (!srcNode) {
        // Try by name
        srcNode = await queryOne(
          'MATCH (e:Entity) WHERE e.name = $name RETURN e.id AS id',
          { name: source },
        );
      }
      if (!srcNode) {
        const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const id = `${ENTITY_URI_PREFIX}/${source_domain}/${slug}`;
        const now = new Date().toISOString();
        await execute(
          'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
          { id, type: source_type, domain: source_domain, name: source, description: '', aliases: [], now },
        );
        srcNode = { id };
      }

      // Auto-create target node if not found
      let tgtNode = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: target },
      );
      if (!tgtNode) {
        tgtNode = await queryOne(
          'MATCH (e:Entity) WHERE e.name = $name RETURN e.id AS id',
          { name: target },
        );
      }
      if (!tgtNode) {
        const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const id = `${ENTITY_URI_PREFIX}/${target_domain}/${slug}`;
        const now = new Date().toISOString();
        await execute(
          'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
          { id, type: target_type, domain: target_domain, name: target, description: '', aliases: [], now },
        );
        tgtNode = { id };
      }

      const sourceId = (srcNode as Record<string, unknown>).id as string;
      const targetId = (tgtNode as Record<string, unknown>).id as string;
      const fact_id = computeFactId(sourceId, relation, targetId);
      const now = new Date().toISOString();

      await execute(
        `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
         CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $asserted_by, confidence: $confidence, proof_depth: $proof_depth, context: $context, created_at: $now, updated_at: $now}]->(b)`,
        {
          source: sourceId,
          target: targetId,
          fact_id,
          relation,
          asserted_by: assertedBy,
          confidence,
          proof_depth: 0,
          context: context ?? '',
          now,
        },
      );

      // Contradiction detection: check for inverse relation between same nodes
      const warnings: string[] = [];
      const SYMMETRIC_CONTRADICTIONS = ['supersedes', 'outperforms', 'contradicts'];
      if (SYMMETRIC_CONTRADICTIONS.includes(relation)) {
        const inverse = await queryOne(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity)
           WHERE a.id = $target AND b.id = $source AND r.relation = $relation
           RETURN r.fact_id AS fact_id, r.context AS context`,
          { source: sourceId, target: targetId, relation },
        );
        if (inverse) {
          warnings.push(`Potential contradiction: inverse "${relation}" assertion exists from target to source (fact_id: ${(inverse as Record<string, unknown>).fact_id})`);
        }
      }

      const result: Record<string, unknown> = { fact_id, source: sourceId, target: targetId, relation, confidence, context: context ?? '' };
      if (warnings.length > 0) result.warnings = warnings;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_assertion',
    {
      description: 'Update an existing assertion by fact_id.',
      inputSchema: {
        fact_id: z.string().describe('The fact_id of the assertion to update'),
        confidence: z.number().min(0).max(1).optional(),
        context: z.string().optional(),
      },
    },
    async ({ fact_id, confidence, context }) => {
      const existing = await queryOne(
        'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
        { fact_id },
      );
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Assertion ${fact_id} not found` }], isError: true };
      }

      const sets: string[] = [];
      const params: Record<string, unknown> = { fact_id };
      const now = new Date().toISOString();

      if (confidence !== undefined) {
        sets.push('r.confidence = $confidence');
        params.confidence = confidence;
      }
      if (context !== undefined) {
        sets.push('r.context = $context');
        params.context = context;
      }
      sets.push('r.updated_at = $now');
      params.now = now;

      await execute(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id SET ${sets.join(', ')}`,
        params,
      );

      const updated = await queryOne(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id
         RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.updated_at AS updated_at`,
        { fact_id },
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  server.registerTool(
    'delete_assertion',
    {
      description: 'Delete an assertion by fact_id.',
      inputSchema: {
        fact_id: z.string().describe('The fact_id of the assertion to delete'),
      },
    },
    async ({ fact_id }) => {
      const existing = await queryOne(
        'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
        { fact_id },
      );
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Assertion ${fact_id} not found` }], isError: true };
      }

      await execute(
        'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id DELETE r',
        { fact_id },
      );

      return {
        content: [{ type: 'text' as const, text: `Deleted assertion ${fact_id}` }],
      };
    },
  );

  server.registerTool(
    'graph_stats',
    {
      description: 'Get current graph statistics — node count, edge count, domain breakdown.',
      inputSchema: {},
    },
    async () => {
      const nodes = await queryAll(
        'MATCH (e:Entity) RETURN e.domain AS domain, e.type AS type, count(*) AS cnt',
      );
      const edges = await queryAll(
        'MATCH ()-[r:Assertion]->() RETURN r.relation AS relation, count(*) AS cnt',
      );
      const totalNodes = await queryAll('MATCH (e:Entity) RETURN count(*) AS cnt');
      const totalEdges = await queryAll('MATCH ()-[r:Assertion]->() RETURN count(*) AS cnt');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                total_nodes: (totalNodes[0] as Record<string, unknown>)?.cnt ?? 0,
                total_edges: (totalEdges[0] as Record<string, unknown>)?.cnt ?? 0,
                by_domain: nodes,
                by_relation: edges,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── semantic_search ──────────────────────────────────────────────────
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
      // Fetch more than top_k to allow for domain post-filtering
      const fetchK = domain ? top_k * 3 : top_k;
      const similar = await searchSimilar(query, include_edges ? fetchK * 2 : fetchK);
      if (similar.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No embedding matches found. The embedding worker may still be processing.' }] };
      }

      // Enrich node matches with full data
      const nodeResults: Record<string, unknown>[] = [];
      for (const { id, score, match_type } of similar) {
        if (match_type === 'assertion') continue; // handle below
        const node = await queryOne(
          'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.domain AS domain, e.name AS name, e.description AS description, e.created_at AS created_at, e.updated_at AS updated_at',
          { id },
        );
        if (!node) continue;
        const n = node as Record<string, unknown>;
        if (domain && typeof n.domain === 'string' && !n.domain.startsWith(domain)) continue;
        nodeResults.push(addStaleness({ ...n, similarity: Math.round(score * 1000) / 1000 }));
        if (nodeResults.length >= top_k) break;
      }

      // Enrich edge matches
      const edgeResults: Record<string, unknown>[] = [];
      if (include_edges) {
        for (const { id, score, match_type } of similar) {
          if (match_type !== 'assertion') continue;
          const factId = id.replace(/^assertion:/, '');
          const edge = await queryOne(
            `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fid
             RETURN a.name AS source_name, a.id AS source_id, a.domain AS source_domain, b.name AS target_name, b.id AS target_id, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
            { fid: factId },
          );
          if (!edge) continue;
          const e = edge as Record<string, unknown>;
          if (domain && typeof e.source_domain === 'string' && !e.source_domain.startsWith(domain)) continue;
          edgeResults.push({ ...e, similarity: Math.round(score * 1000) / 1000 });
          if (edgeResults.length >= top_k) break;
        }
      }

      trackNodeUsage(nodeResults.map((r: Record<string, unknown>) => r.id as string));
      const result: Record<string, unknown> = { nodes: nodeResults };
      if (include_edges) result.edges = edgeResults;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── recent_activity ──────────────────────────────────────────────────
  server.registerTool(
    'recent_activity',
    {
      description:
        'Get recently created or updated assertions, ordered by time. Use at session start to see what other sessions have recorded.',
      inputSchema: {
        since: z.string().optional().describe('ISO date string to filter from, e.g. "2026-03-20"'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results'),
      },
    },
    async ({ since, limit }) => {
      const conditions = since ? 'WHERE r.updated_at >= $since ' : '';
      const params: Record<string, unknown> = {};
      if (since) params.since = since;

      const results = await queryAll(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) ${conditions}
         RETURN a.name AS source_name, a.id AS source_id, r.relation AS relation, b.name AS target_name, b.id AS target_id, r.confidence AS confidence, r.context AS context, r.created_at AS created_at, r.updated_at AS updated_at
         ORDER BY r.updated_at DESC LIMIT ${limit}`,
        params,
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── update_node ──────────────────────────────────────────────────────
  server.registerTool(
    'update_node',
    {
      description:
        'Update an existing node — change its name, description, or aliases.',
      inputSchema: {
        node_id: z.string().describe('Node URI to update'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
        aliases: z.array(z.string()).optional().describe('New aliases list (replaces existing)'),
      },
    },
    async ({ node_id, name, description, aliases }) => {
      const existing = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: node_id },
      );
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Node ${node_id} not found` }], isError: true };
      }

      const sets: string[] = [];
      const params: Record<string, unknown> = { id: node_id };
      const now = new Date().toISOString();

      if (name !== undefined) {
        sets.push('e.name = $name');
        params.name = name;
      }
      if (description !== undefined) {
        sets.push('e.description = $description');
        params.description = description;
      }
      if (aliases !== undefined) {
        sets.push('e.aliases = $aliases');
        params.aliases = aliases;
      }
      sets.push('e.updated_at = $now');
      params.now = now;

      await execute(
        `MATCH (e:Entity) WHERE e.id = $id SET ${sets.join(', ')}`,
        params,
      );

      const updated = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.aliases AS aliases, e.updated_at AS updated_at',
        { id: node_id },
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  // ── recall ───────────────────────────────────────────────────────────
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

      // Step 1: Find matching entities via embedding + text search
      type ScoredNode = { id: string; name: string; type: string; domain: string; description: string; score: number };
      const scored: ScoredNode[] = [];

      // Text search
      const domainCondition = domain ? ' AND e.domain STARTS WITH $domain' : '';
      const textParams: Record<string, unknown> = { q: query };
      if (domain) textParams.domain = domain;
      const textMatches = await queryAll<{ id: string; name: string; type: string; domain: string; description: string }>(
        `MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($q)${domainCondition} RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description LIMIT 20`,
        textParams,
      );
      for (const n of textMatches) {
        scored.push({ ...n, score: n.name.toLowerCase() === query.toLowerCase() ? 10 : 5 });
      }

      // Embedding search
      try {
        const embResults = await searchSimilar(query, 15);
        for (const { id, score: embScore, match_type } of embResults) {
          if (embScore < 0.25) continue;
          if (match_type === 'assertion') continue; // handle nodes only for seed; assertions come via graph traversal
          const existing = scored.find(s => s.id === id);
          if (existing) {
            existing.score += embScore * 5;
          } else {
            const n = await queryOne<{ id: string; name: string; type: string; domain: string; description: string }>(
              'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description',
              { id },
            );
            if (n) {
              if (domain && !n.domain.startsWith(domain)) continue;
              scored.push({ ...n, score: embScore * 5 });
            }
          }
        }
      } catch { /* embeddings not ready */ }

      if (scored.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ nodes: [], edges: [], message: 'No matches found' }) }] };
      }

      scored.sort((a, b) => b.score - a.score);
      const seedIds = new Set(scored.slice(0, 10).map(s => s.id));

      // Step 2: 1-hop neighbor expansion
      type EdgeRow = { src: string; src_name: string; tgt: string; tgt_name: string; relation: string; confidence: number; context: string; created_at: string };
      const neighborRows: EdgeRow[] = [];

      for (const seedId of seedIds) {
        const rows = await queryAll<EdgeRow>(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity)
           WHERE a.id = $seed OR b.id = $seed
           RETURN a.id AS src, a.name AS src_name, b.id AS tgt, b.name AS tgt_name,
                  r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at`,
          { seed: seedId },
        );
        neighborRows.push(...rows);
      }

      // Step 3: Budget-pack results
      const resultNodes: Array<{ name: string; type: string; description: string; score: number }> = [];
      const includedIds = new Set<string>();
      let usedChars = 0;

      for (const s of scored.slice(0, 30)) {
        const entry = `${s.name} (${s.type}): ${s.description || ''}`;
        const cost = entry.length;
        if (usedChars + cost > charBudget) break;
        resultNodes.push({ name: s.name, type: s.type, description: s.description || '', score: Math.round(s.score * 10) / 10 });
        includedIds.add(s.id);
        usedChars += cost;
      }

      // Add neighbor nodes
      for (const row of neighborRows) {
        for (const nid of [row.src, row.tgt]) {
          if (includedIds.has(nid)) continue;
          includedIds.add(nid);
        }
      }

      // Pack edges
      const resultEdges: Array<{ source: string; relation: string; target: string; confidence: number; context: string }> = [];
      const sortedEdges = [...neighborRows].sort((a, b) => b.confidence - a.confidence);
      const seenEdges = new Set<string>();

      for (const row of sortedEdges) {
        const edgeKey = `${row.src}|${row.relation}|${row.tgt}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        const edgeText = `${row.src_name} --[${row.relation}]--> ${row.tgt_name}`;
        const cost = edgeText.length + (row.context?.length || 0);
        if (usedChars + cost > charBudget) continue;

        resultEdges.push({
          source: row.src_name,
          relation: row.relation,
          target: row.tgt_name,
          confidence: row.confidence,
          context: row.context || '',
        });
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

  // ── remember ─────────────────────────────────────────────────────────
  server.registerTool(
    'remember',
    {
      description:
        'Remember a finding, decision, or observation. High-level memory write — auto-creates nodes and infers relation type. Use for quickly persisting knowledge.',
      inputSchema: {
        subject: z.string().describe('What this is about — entity name or existing node ID'),
        fact: z.string().describe('The finding, decision, or observation to remember'),
        relation: z.string().optional().describe('Explicit relation type (free-form; auto-inferred if omitted)'),
        domain: z.string().optional().default('memory').describe('Knowledge domain'),
        confidence: z.number().min(0).max(1).optional().default(0.9),
      },
    },
    async ({ subject, fact, relation, domain, confidence }) => {
      // Resolve or create subject node
      let subjectNode = await queryOne<{ id: string; name: string }>(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name',
        { id: subject },
      );
      if (!subjectNode) {
        subjectNode = await queryOne<{ id: string; name: string }>(
          'MATCH (e:Entity) WHERE lower(e.name) = lower($name) RETURN e.id AS id, e.name AS name',
          { name: subject },
        );
      }
      if (!subjectNode) {
        // Try fuzzy match
        subjectNode = await queryOne<{ id: string; name: string }>(
          'MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($name) RETURN e.id AS id, e.name AS name LIMIT 1',
          { name: subject },
        );
      }
      if (!subjectNode) {
        const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const id = `${ENTITY_URI_PREFIX}/${domain}/${slug}`;
        const now = new Date().toISOString();
        await execute(
          'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
          { id, type: 'concept', domain, name: subject, description: '', aliases: [], now },
        );
        subjectNode = { id, name: subject };
      }

      // Create fact node
      const factSlug = fact.substring(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const factId = `${ENTITY_URI_PREFIX}/${domain}/fact_${factSlug}`;
      const now = new Date().toISOString();

      // Check if fact node already exists (idempotency)
      const existingFact = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: factId },
      );
      if (!existingFact) {
        // Infer node type from content
        let factType: string = 'belief';
        const factLower = fact.toLowerCase();
        if (factLower.includes('decided') || factLower.includes('decision') || factLower.includes('chose')) factType = 'decision';
        else if (factLower.includes('prefer') || factLower.includes('better')) factType = 'preference';
        else if (factLower.includes('reject') || factLower.includes('avoid') || factLower.includes("don't")) factType = 'rejected_alternative';

        await execute(
          'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
          { id: factId, type: factType, domain, name: fact.substring(0, 120), description: fact, aliases: [], now },
        );
      }

      // Infer relation type
      if (!relation) {
        const fl = fact.toLowerCase();
        if (fl.includes('replaces') || fl.includes('instead of') || fl.includes('supersede')) relation = 'supersedes';
        else if (fl.includes('contradict') || fl.includes('conflict') || fl.includes('actually')) relation = 'contradicts';
        else if (fl.includes('depends') || fl.includes('requires') || fl.includes('needs')) relation = 'depends_on';
        else if (fl.includes('enables') || fl.includes('allows') || fl.includes('makes possible')) relation = 'enables';
        else relation = 'about';
      }

      const edgeFactId = computeFactId(subjectNode.id, relation, factId);

      // Check for existing edge (idempotency)
      const existingEdge = await queryOne(
        'MATCH ()-[r:Assertion]->() WHERE r.fact_id = $fid RETURN r.fact_id AS fact_id',
        { fid: edgeFactId },
      );

      if (!existingEdge) {
        await execute(
          `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
           CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $now, updated_at: $now}]->(b)`,
          {
            source: subjectNode.id,
            target: factId,
            fact_id: edgeFactId,
            relation,
            by: assertedBy,
            conf: confidence,
            pd: 0,
            ctx: fact,
            now,
          },
        );
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            subject: { id: subjectNode.id, name: subjectNode.name },
            fact: { id: factId, text: fact.substring(0, 120) },
            relation,
            fact_id: edgeFactId,
            created: !existingEdge,
          }, null, 2),
        }],
      };
    },
  );

  // ── explore ──────────────────────────────────────────────────────────
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
      // Resolve entity
      let node = await queryOne<{ id: string; type: string; name: string; description: string; domain: string; created_at: string; updated_at: string }>(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.domain AS domain, e.created_at AS created_at, e.updated_at AS updated_at',
        { id: entity },
      );
      if (!node) {
        node = await queryOne(
          'MATCH (e:Entity) WHERE lower(e.name) = lower($name) RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.domain AS domain, e.created_at AS created_at, e.updated_at AS updated_at',
          { name: entity },
        );
      }
      if (!node) {
        node = await queryOne(
          'MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($name) RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.domain AS domain, e.created_at AS created_at, e.updated_at AS updated_at LIMIT 1',
          { name: entity },
        );
      }
      if (!node) {
        // Try embedding search
        try {
          const embResults = await searchSimilar(entity, 1);
          if (embResults.length > 0 && embResults[0].score > 0.4) {
            node = await queryOne(
              'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.domain AS domain, e.created_at AS created_at, e.updated_at AS updated_at',
              { id: embResults[0].id },
            );
          }
        } catch { /* embeddings not ready */ }
      }
      if (!node) {
        return { content: [{ type: 'text' as const, text: `Entity "${entity}" not found` }], isError: true };
      }

      const outgoing = await queryAll<{ name: string; type: string; relation: string; confidence: number; context: string; created_at: string }>(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
         RETURN b.name AS name, b.type AS type, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at`,
        { id: node.id },
      );
      const incoming = await queryAll<{ name: string; type: string; relation: string; confidence: number; context: string; created_at: string }>(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id
         RETURN a.name AS name, a.type AS type, r.relation AS relation, r.confidence AS confidence, r.context AS context, r.created_at AS created_at`,
        { id: node.id },
      );

      // Format in DSL notation
      const lines: string[] = [];
      lines.push(`# ${node.name} (${node.type}, ${node.domain})`);
      if (node.description) lines.push(`> ${node.description}`);
      lines.push(`Created: ${node.created_at} | Updated: ${node.updated_at}`);
      lines.push('');

      if (outgoing.length > 0) {
        lines.push(`## Outgoing (${outgoing.length})`);
        for (const e of outgoing) {
          const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
          lines.push(`  ${node.name} --[${e.relation}]--> ${e.name}${conf}`);
          if (e.context) lines.push(`    context: ${e.context.substring(0, 200)}`);
        }
        lines.push('');
      }

      if (incoming.length > 0) {
        lines.push(`## Incoming (${incoming.length})`);
        for (const e of incoming) {
          const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
          lines.push(`  ${e.name} --[${e.relation}]--> ${node.name}${conf}`);
          if (e.context) lines.push(`    context: ${e.context.substring(0, 200)}`);
        }
      }

      trackNodeUsage([node.id]);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ── traverse ────────────────────────────────────────────────────────
  server.registerTool(
    'traverse',
    {
      description:
        'Multi-hop graph traversal from a starting entity. Returns a subgraph of all nodes and edges reachable within max_depth hops. Use for questions like "what relates to X through Y" or "show everything connected to X".',
      inputSchema: {
        entity: z.string().describe('Starting entity — name, ID, or search term'),
        max_depth: z.number().int().min(1).max(3).optional().default(2).describe('Maximum traversal depth (1-3 hops)'),
        relation: z.string().optional().describe('Filter edges by relation type (e.g. "outperforms", "fails_on", "alternative_to")'),
        direction: z.enum(['out', 'in', 'both']).optional().default('both').describe('Traversal direction'),
      },
    },
    async ({ entity, max_depth, relation, direction }) => {
      // Resolve start entity (same logic as explore)
      let startNode = await queryOne<{ id: string; name: string; type: string; domain: string; description: string }>(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description',
        { id: entity },
      );
      if (!startNode) {
        startNode = await queryOne(
          'MATCH (e:Entity) WHERE lower(e.name) = lower($name) RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description',
          { name: entity },
        );
      }
      if (!startNode) {
        startNode = await queryOne(
          'MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($name) RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description LIMIT 1',
          { name: entity },
        );
      }
      if (!startNode) {
        try {
          const embResults = await searchSimilar(entity, 1);
          if (embResults.length > 0 && embResults[0].score > 0.4) {
            startNode = await queryOne(
              'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description',
              { id: embResults[0].id },
            );
          }
        } catch { /* embeddings not ready */ }
      }
      if (!startNode) {
        return { content: [{ type: 'text' as const, text: `Entity "${entity}" not found` }], isError: true };
      }

      // BFS traversal
      const MAX_FRONTIER = 25; // cap frontier per level to limit queries
      type EdgeRow = { src: string; src_name: string; src_type: string; tgt: string; tgt_name: string; tgt_type: string; relation: string; confidence: number; context: string };
      const visitedNodes = new Set<string>([startNode.id]);
      const collectedEdges: Array<EdgeRow & { depth: number }> = [];
      const nodeInfo = new Map<string, { name: string; type: string; domain?: string; description?: string }>();
      nodeInfo.set(startNode.id, { name: startNode.name, type: startNode.type, domain: startNode.domain, description: startNode.description });

      let frontier = [startNode.id];

      for (let depth = 1; depth <= max_depth; depth++) {
        if (frontier.length === 0) break;

        const nextFrontier: string[] = [];

        for (const nodeId of frontier.slice(0, MAX_FRONTIER)) {
          const relCondition = relation ? ' AND r.relation = $relation' : '';
          const params: Record<string, unknown> = { id: nodeId };
          if (relation) params.relation = relation;

          if (direction === 'out' || direction === 'both') {
            const rows = await queryAll<EdgeRow>(
              `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id${relCondition}
               RETURN a.id AS src, a.name AS src_name, a.type AS src_type, b.id AS tgt, b.name AS tgt_name, b.type AS tgt_type, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
              params,
            );
            for (const row of rows) {
              collectedEdges.push({ ...row, depth });
              if (!nodeInfo.has(row.tgt)) nodeInfo.set(row.tgt, { name: row.tgt_name, type: row.tgt_type });
              if (!visitedNodes.has(row.tgt)) {
                visitedNodes.add(row.tgt);
                nextFrontier.push(row.tgt);
              }
            }
          }

          if (direction === 'in' || direction === 'both') {
            const rows = await queryAll<EdgeRow>(
              `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id${relCondition}
               RETURN a.id AS src, a.name AS src_name, a.type AS src_type, b.id AS tgt, b.name AS tgt_name, b.type AS tgt_type, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
              params,
            );
            for (const row of rows) {
              collectedEdges.push({ ...row, depth });
              if (!nodeInfo.has(row.src)) nodeInfo.set(row.src, { name: row.src_name, type: row.src_type });
              if (!visitedNodes.has(row.src)) {
                visitedNodes.add(row.src);
                nextFrontier.push(row.src);
              }
            }
          }
        }

        frontier = nextFrontier;
      }

      // Dedup edges
      const seenEdges = new Set<string>();
      const uniqueEdges = collectedEdges.filter(e => {
        const key = `${e.src}|${e.relation}|${e.tgt}`;
        if (seenEdges.has(key)) return false;
        seenEdges.add(key);
        return true;
      });

      // Format as DSL
      const lines: string[] = [];
      lines.push(`# Traverse: ${startNode.name} (depth ≤ ${max_depth}${relation ? `, relation=${relation}` : ''}${direction !== 'both' ? `, direction=${direction}` : ''})`);
      lines.push(`Discovered ${visitedNodes.size} nodes, ${uniqueEdges.length} edges\n`);

      // Group edges by depth
      for (let d = 1; d <= max_depth; d++) {
        const atDepth = uniqueEdges.filter(e => e.depth === d);
        if (atDepth.length === 0) continue;
        lines.push(`## Depth ${d} (${atDepth.length} edges)`);
        for (const e of atDepth.sort((a, b) => b.confidence - a.confidence)) {
          const conf = e.confidence < 1 ? ` (${e.confidence})` : '';
          lines.push(`  ${e.src_name} --[${e.relation}]--> ${e.tgt_name}${conf}`);
          if (e.context) lines.push(`    ${e.context.substring(0, 150)}`);
        }
        lines.push('');
      }

      trackNodeUsage([...visitedNodes]);
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ── batch_assertions ─────────────────────────────────────────────────
  server.registerTool(
    'batch_assertions',
    {
      description:
        'Add multiple assertions in one call. Each assertion auto-creates nodes if needed. Returns summary of successes and failures.',
      inputSchema: {
        assertions: z.array(z.object({
          source: z.string(),
          target: z.string(),
          relation: z.string(),
          source_type: z.string().optional().default('concept'),
          target_type: z.string().optional().default('concept'),
          source_domain: z.string().optional().default('cs'),
          target_domain: z.string().optional().default('cs'),
          confidence: z.number().min(0).max(1).optional().default(1.0),
          context: z.string().optional(),
        })).min(1).max(50).describe('Array of assertions to add'),
      },
    },
    async ({ assertions }) => {
      const results: Array<{ fact_id: string; source: string; target: string; relation: string; ok: boolean; error?: string }> = [];

      for (const a of assertions) {
        try {
          // Resolve/create source
          let srcNode = await queryOne<{ id: string }>('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id: a.source });
          if (!srcNode) srcNode = await queryOne<{ id: string }>('MATCH (e:Entity) WHERE e.name = $name RETURN e.id AS id', { name: a.source });
          if (!srcNode) {
            const slug = a.source.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const id = `${ENTITY_URI_PREFIX}/${a.source_domain}/${slug}`;
            const now = new Date().toISOString();
            await execute(
              'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
              { id, type: a.source_type, domain: a.source_domain, name: a.source, description: '', aliases: [], now },
            );
            srcNode = { id };
          }

          // Resolve/create target
          let tgtNode = await queryOne<{ id: string }>('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id: a.target });
          if (!tgtNode) tgtNode = await queryOne<{ id: string }>('MATCH (e:Entity) WHERE e.name = $name RETURN e.id AS id', { name: a.target });
          if (!tgtNode) {
            const slug = a.target.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const id = `${ENTITY_URI_PREFIX}/${a.target_domain}/${slug}`;
            const now = new Date().toISOString();
            await execute(
              'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, created_at: $now, updated_at: $now})',
              { id, type: a.target_type, domain: a.target_domain, name: a.target, description: '', aliases: [], now },
            );
            tgtNode = { id };
          }

          const fact_id = computeFactId(srcNode.id, a.relation, tgtNode.id);
          const now = new Date().toISOString();

          await execute(
            `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
             CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $now, updated_at: $now}]->(b)`,
            { source: srcNode.id, target: tgtNode.id, fact_id, relation: a.relation, by: assertedBy, conf: a.confidence, pd: 0, ctx: a.context ?? '', now },
          );

          results.push({ fact_id, source: srcNode.id, target: tgtNode.id, relation: a.relation, ok: true });
        } catch (err) {
          results.push({ fact_id: '', source: a.source, target: a.target, relation: a.relation, ok: false, error: String(err) });
        }
      }

      const succeeded = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok).length;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ succeeded, failed, results }, null, 2),
        }],
      };
    },
  );

  // ── decide ───────────────────────────────────────────────────────────
  server.registerTool(
    'decide',
    {
      description:
        'Get ranked recommendations for a task or problem. Scores candidates by wins (supersedes), failures (contradicts), and graph connections. Optionally filter out methods that fail on specified constraints.',
      inputSchema: {
        task: z.string().describe('What you want to do — e.g. "link prediction", "agent long-term memory", "distributed consensus"'),
        constraints: z.array(z.string()).optional().default([]).describe('Constraints to avoid — methods that fail_on/contradict these are excluded'),
        limit: z.number().int().min(1).max(20).optional().default(10).describe('Max recommendations'),
      },
    },
    async ({ task, constraints, limit }) => {
      // Step 1: Find concepts related to the task
      const textMatches = await queryAll<{ id: string; name: string; type: string; description: string }>(
        'MATCH (e:Entity) WHERE lower(e.name) CONTAINS lower($q) RETURN e.id AS id, e.name AS name, e.type AS type, e.description AS description LIMIT 10',
        { q: task },
      );

      let relatedIds = new Set(textMatches.map(n => n.id));

      // Also try embedding search if text matches are sparse
      if (relatedIds.size < 3) {
        try {
          const embResults = await searchSimilar(task, 5);
          for (const { id, score, match_type } of embResults) {
            if (score < 0.3 || match_type !== 'node') continue;
            relatedIds.add(id);
          }
        } catch { /* embeddings not ready */ }
      }

      // Step 2: Collect candidates — entities connected to related concepts
      const INTRO_RELS = new Set(['enables', 'implements', 'depends_on', 'introduces', 'is_based_on']);
      const candidates = new Map<string, { id: string; name: string; type: string; description: string; score: number; wins: number; failures: number; notes: string[] }>();

      for (const relId of relatedIds) {
        // Entities that point TO related concepts via intro relations
        const incoming = await queryAll<{ id: string; name: string; type: string; description: string; relation: string; confidence: number; context: string }>(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id
           RETURN a.id AS id, a.name AS name, a.type AS type, a.description AS description, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
          { id: relId },
        );
        for (const row of incoming) {
          if (!INTRO_RELS.has(row.relation)) continue;
          if (!candidates.has(row.id)) {
            candidates.set(row.id, { id: row.id, name: row.name, type: row.type, description: row.description || '', score: 0, wins: 0, failures: 0, notes: [] });
          }
          const c = candidates.get(row.id)!;
          c.score += row.confidence;
          if (row.context) c.notes.push(row.context.substring(0, 100));
        }

        // The related concept itself is a candidate
        const self = textMatches.find(n => n.id === relId);
        if (self && !candidates.has(self.id)) {
          candidates.set(self.id, { id: self.id, name: self.name, type: self.type, description: self.description || '', score: 1.0, wins: 0, failures: 0, notes: [] });
        }
      }

      if (candidates.size === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ task, recommendations: [], message: 'No candidates found' }) }] };
      }

      // Step 3: Score by supersedes (wins) and contradicts (failures)
      for (const [id, cand] of candidates) {
        const outEdges = await queryAll<{ relation: string; confidence: number; target_name: string; context: string }>(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
           RETURN r.relation AS relation, r.confidence AS confidence, b.name AS target_name, r.context AS context`,
          { id },
        );
        for (const e of outEdges) {
          if (e.relation === 'supersedes' || e.relation === 'outperforms') {
            cand.wins++;
            cand.score += e.confidence * 0.5;
          }
          if (e.relation === 'contradicts' || e.relation === 'fails_on') {
            cand.failures++;
            cand.score -= e.confidence * 0.3;
          }
        }
      }

      // Step 4: Filter by constraints
      const constraintLower = constraints.map(c => c.toLowerCase());
      const filtered: Array<typeof candidates extends Map<string, infer V> ? V : never> = [];

      for (const cand of candidates.values()) {
        let excluded = false;
        if (constraintLower.length > 0) {
          const failEdges = await queryAll<{ target_name: string; context: string }>(
            `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id AND (r.relation = 'contradicts' OR r.relation = 'fails_on')
             RETURN b.name AS target_name, r.context AS context`,
            { id: cand.id },
          );
          for (const fe of failEdges) {
            const failText = `${fe.target_name} ${fe.context || ''}`.toLowerCase();
            if (constraintLower.some(c => failText.includes(c))) {
              excluded = true;
              break;
            }
          }
        }
        if (!excluded) filtered.push(cand);
      }

      // Step 5: Sort and return
      filtered.sort((a, b) => b.score - a.score);
      const top = filtered.slice(0, limit);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task,
            constraints,
            recommendations: top.map((c, i) => ({
              rank: i + 1,
              name: c.name,
              type: c.type,
              description: c.description?.substring(0, 200) || '',
              score: Math.round(c.score * 100) / 100,
              wins: c.wins,
              known_failures: c.failures,
              notes: c.notes.slice(0, 3),
            })),
            total_candidates: candidates.size,
            after_filtering: filtered.length,
          }, null, 2),
        }],
      };
    },
  );
}
