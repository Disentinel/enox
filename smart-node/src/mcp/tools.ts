import { z } from 'zod';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { queryAll, queryOne, execute } from '../db.js';
import { computeFactId } from '../util.js';
import { NODE_TYPES, RELATION_TYPES, ENTITY_URI_PREFIX } from '../types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logQuery } from '../lance.js';

export function registerTools(server: McpServer): void {
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
      const startTime = Date.now();
      // If node_id is given, return neighbors
      if (node_id) {
        const conditions = relation ? 'AND r.relation = $relation ' : '';
        const params: Record<string, unknown> = { id: node_id };
        if (relation) params.relation = relation;

        const outgoing = await queryAll(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id ${conditions}
           RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, b.name AS target_name, b.type AS target_type, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
          params,
        );
        const incoming = await queryAll(
          `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE b.id = $id ${conditions}
           RETURN r.fact_id AS fact_id, a.id AS source, a.name AS source_name, a.type AS source_type, b.id AS target, r.relation AS relation, r.confidence AS confidence, r.context AS context`,
          params,
        );

        const node = await queryOne(
          'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description',
          { id: node_id },
        );

        logQuery({
          tool: 'query_graph',
          queryText: node_id ?? '',
          nodeIds: [node_id],
          resultCount: 1,
          responseMs: Date.now() - startTime,
          source: 'mcp',
        }).catch(() => {});
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
        'RETURN e.id AS id, e.type AS type, e.name AS name, e.description AS description, e.aliases AS aliases';

      const nodes = await queryAll(cypher, params);
      logQuery({
        tool: 'query_graph',
        queryText: query ?? type ?? '',
        nodeIds: (nodes as any[]).map((n: any) => n.id),
        resultCount: (nodes as any[]).length,
        responseMs: Date.now() - startTime,
        source: 'mcp',
      }).catch(() => {});
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
        relation: z.enum(RELATION_TYPES).describe('Relation type'),
        source_type: z.enum(NODE_TYPES).optional().default('concept').describe('Type for auto-created source node'),
        source_domain: z.string().optional().default('cs').describe('Knowledge domain for auto-created source node'),
        target_type: z.enum(NODE_TYPES).optional().default('concept').describe('Type for auto-created target node'),
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
          asserted_by: 'vadim',
          confidence,
          proof_depth: 0,
          context: context ?? '',
          now,
        },
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ fact_id, source: sourceId, target: targetId, relation, confidence, context: context ?? '' }, null, 2),
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
}
