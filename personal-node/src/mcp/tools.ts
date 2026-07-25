import { z } from 'zod';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { queryAll, queryOne, execute } from '../db/kuzu.js';
import { computeFactId, truncateAtWordBoundary, withFactIdLock } from '../util.js';
import { NODE_TYPES, RELATION_TYPES, ENTITY_URI_PREFIX } from '../types.js';
import { loadConfig } from '../config.js';
import { searchSimilar } from '../embeddings.js';
import { getSqlite } from '../db/sqlite.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mainGraphStore } from './graph-store.js';
import { registerReadTools } from './read-tools.js';
import { createShare, listSharesWithUrls, revokeShareById } from '../shares/service.js';
import { createArtifact, listArtifacts, getArtifact } from '../artifacts/service.js';

// remember() stores the full fact text as `description`, but `name` is used
// in listings/graph labels — cap it for display, but at a word boundary with
// an ellipsis, not a bare substring cut (was `fact.substring(0, 120)`, which
// sliced mid-word and silently dropped the tail — see okf-lab dedup work,
// 2026-07-23, and the "Systematic 120-char name truncation" node in the graph).
const NAME_MAX_LEN = 300;

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

export function registerTools(server: McpServer): void {
  // Read-only tools (query_graph, graph_stats, explore, traverse, recall, semantic_search)
  // are implemented once in read-tools.ts against the GraphStore interface, and reused
  // here (over the live main graph) and by each share's MCP server (over its snapshot).
  registerReadTools(server, mainGraphStore, { includeSemanticSearch: true, trackUsage: trackNodeUsage });

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
        asserted_by: z.string().min(1).optional().describe('Who/what is asserting this. Convention: humans pass a plain identity ("alice"); agents pass "agent:<name>". Defaults to the configured agent identity if omitted — this tool is called by agents, so an omitted identity is attributed to the agent, never to a human.'),
        proof_depth: z.number().int().min(0).optional().default(0).describe('Optional depth-of-proof signal (open-ended, not required)'),
      },
    },
    async ({ source, target, relation, source_type, source_domain, target_type, target_domain, confidence, context, asserted_by, proof_depth }) => {
      const effectiveAssertedBy = asserted_by ?? loadConfig().agentIdentity;
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

      // Upsert, not blind create: this handler used to CREATE unconditionally,
      // so every re-assertion of the same (source, relation, target) — the
      // normal way an agent records an updated confidence/context for a
      // belief it already holds — added a second relationship row sharing the
      // same fact_id instead of updating the first. That produced 453
      // duplicate-fact_id groups in production (found + cleaned up 2026-07-23,
      // see okf-lab/dedup-audit.json). Guarding under factIdLock closes the
      // check-then-write gap for same-process concurrent callers too.
      const upserted = await withFactIdLock(fact_id, async () => {
        const existing = await queryOne<{ fact_id: string }>(
          'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
          { fact_id },
        );
        const now = new Date().toISOString();
        if (existing) {
          // Re-asserting an existing fact updates who's asserting it now, too —
          // not just confidence/context — so asserted_by reflects the most
          // recent assertor rather than freezing on whoever created the row.
          await execute(
            `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id
             SET r.confidence = $confidence, r.context = $context, r.asserted_by = $asserted_by, r.updated_at = $now`,
            { fact_id, confidence, context: context ?? '', asserted_by: effectiveAssertedBy, now },
          );
          return false; // updated, not created
        }
        await execute(
          `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
           CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $asserted_by, confidence: $confidence, proof_depth: $proof_depth, context: $context, created_at: $now, updated_at: $now}]->(b)`,
          {
            source: sourceId,
            target: targetId,
            fact_id,
            relation,
            asserted_by: effectiveAssertedBy,
            confidence,
            proof_depth,
            context: context ?? '',
            now,
          },
        );
        return true; // created
      });

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

      const result: Record<string, unknown> = {
        fact_id, source: sourceId, target: targetId, relation, asserted_by: effectiveAssertedBy, confidence, proof_depth, context: context ?? '',
        created: upserted,
        updated: !upserted,
      };
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
        asserted_by: z.string().min(1).optional().describe('Correct/update who is asserting this'),
        proof_depth: z.number().int().min(0).optional(),
      },
    },
    async ({ fact_id, confidence, context, asserted_by, proof_depth }) => {
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
      if (asserted_by !== undefined) {
        sets.push('r.asserted_by = $asserted_by');
        params.asserted_by = asserted_by;
      }
      if (proof_depth !== undefined) {
        sets.push('r.proof_depth = $proof_depth');
        params.proof_depth = proof_depth;
      }
      sets.push('r.updated_at = $now');
      params.now = now;

      await execute(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id SET ${sets.join(', ')}`,
        params,
      );

      const updated = await queryOne(
        `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id
         RETURN r.fact_id AS fact_id, a.id AS source, b.id AS target, r.relation AS relation, r.asserted_by AS asserted_by, r.confidence AS confidence, r.proof_depth AS proof_depth, r.context AS context, r.updated_at AS updated_at`,
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

  // ── remember ─────────────────────────────────────────────────────────
  server.registerTool(
    'remember',
    {
      description:
        'Remember a finding, decision, or observation. High-level memory write — auto-creates nodes and infers relation type. Use for quickly persisting knowledge.',
      inputSchema: {
        subject: z.string().describe('What this is about — entity name or existing node ID'),
        fact: z.string().describe('The finding, decision, or observation to remember'),
        relation: z.enum(RELATION_TYPES).optional().describe('Explicit relation type (auto-inferred if omitted)'),
        domain: z.string().optional().default('memory').describe('Knowledge domain'),
        confidence: z.number().min(0).max(1).optional().default(0.9),
        asserted_by: z.string().min(1).optional().describe('Who/what is asserting this. Convention: humans pass a plain identity ("alice"); agents pass "agent:<name>". Defaults to the configured agent identity if omitted.'),
      },
    },
    async ({ subject, fact, relation, domain, confidence, asserted_by }) => {
      const effectiveAssertedBy = asserted_by ?? loadConfig().agentIdentity;
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
          { id: factId, type: factType, domain, name: truncateAtWordBoundary(fact, NAME_MAX_LEN), description: fact, aliases: [], now },
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
            by: effectiveAssertedBy,
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
            fact: { id: factId, text: truncateAtWordBoundary(fact, NAME_MAX_LEN) },
            relation,
            asserted_by: effectiveAssertedBy,
            fact_id: edgeFactId,
            created: !existingEdge,
          }, null, 2),
        }],
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
          relation: z.enum(RELATION_TYPES),
          source_type: z.enum(NODE_TYPES).optional().default('concept'),
          target_type: z.enum(NODE_TYPES).optional().default('concept'),
          source_domain: z.string().optional().default('cs'),
          target_domain: z.string().optional().default('cs'),
          confidence: z.number().min(0).max(1).optional().default(1.0),
          context: z.string().optional(),
          asserted_by: z.string().min(1).optional().describe('Who/what is asserting this. Convention: humans pass a plain identity ("alice"); agents pass "agent:<name>". Defaults to the configured agent identity if omitted.'),
          proof_depth: z.number().int().min(0).optional().default(0),
        })).min(1).max(50).describe('Array of assertions to add'),
      },
    },
    async ({ assertions }) => {
      const results: Array<{ fact_id: string; source: string; target: string; relation: string; asserted_by?: string; ok: boolean; created?: boolean; error?: string }> = [];
      const defaultAssertedBy = loadConfig().agentIdentity;

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
          const effectiveAssertedBy = a.asserted_by ?? defaultAssertedBy;

          // Upsert (see add_assertion above for why: this loop used to CREATE
          // unconditionally, so an assertions array that re-asserts the same
          // triple — or two separate batch_assertions calls asserting the
          // same fact — duplicated fact_id rows instead of updating one).
          const created = await withFactIdLock(fact_id, async () => {
            const existing = await queryOne<{ fact_id: string }>(
              'MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
              { fact_id },
            );
            const now = new Date().toISOString();
            if (existing) {
              await execute(
                `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE r.fact_id = $fact_id
                 SET r.confidence = $conf, r.context = $ctx, r.asserted_by = $by, r.updated_at = $now`,
                { fact_id, conf: a.confidence, ctx: a.context ?? '', by: effectiveAssertedBy, now },
              );
              return false;
            }
            await execute(
              `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
               CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $by, confidence: $conf, proof_depth: $pd, context: $ctx, created_at: $now, updated_at: $now}]->(b)`,
              { source: srcNode.id, target: tgtNode.id, fact_id, relation: a.relation, by: effectiveAssertedBy, conf: a.confidence, pd: a.proof_depth, ctx: a.context ?? '', now },
            );
            return true;
          });

          results.push({ fact_id, source: srcNode.id, target: tgtNode.id, relation: a.relation, asserted_by: effectiveAssertedBy, ok: true, created });
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

  // ── Share management ─────────────────────────────────────────────────
  // Mint / list / revoke share links over the live graph. These orchestrate
  // through src/shares/service.ts — the exact same create/list/revoke code the
  // REST /api/shares handlers call, so the two surfaces can't drift. Registered
  // ONLY here (the main /mcp server); the per-share read-only capsule uses
  // registerReadTools and never gets these, so a share can't mint sub-shares.

  // ── create_share ─────────────────────────────────────────────────────
  server.registerTool(
    'create_share',
    {
      description:
        'Create a shareable read-only snapshot of specific graph domain(s) and get a link + token. The snapshot is exported at creation time; the link exposes ONLY the named domains (a read-only slice, no write tools). You MUST name which domain(s) to expose — there is no "whole graph" default.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Human label for this share, shown on the landing page and in listings.'),
        domains: z.array(z.string().min(1)).min(1).describe("Graph domains to include in this share. REQUIRED — there is no default; you must name which domain(s) to expose (e.g. ['bander'] or ['enox','enox-skills'])."),
        description: z.string().optional().describe('Optional longer description shown on the share landing page.'),
        ttl_days: z.number().int().min(1).max(3650).optional().describe('Optional expiry, in days from now. Omit for a share that does not expire.'),
      },
    },
    async ({ name, domains, description, ttl_days }) => {
      try {
        const result = await createShare({ name, domains, description, ttl_days });
        const summary =
          `Share "${name}" created for domain(s): ${domains.join(', ')}.\n` +
          `URL:   ${result.url}\n` +
          `Token: ${result.token}\n` +
          `id: ${result.id} — ${result.node_count} nodes, ${result.edge_count} edges, ${result.artifact_count} artifacts.`;
        return {
          content: [{ type: 'text' as const, text: summary }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create share: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── list_shares ──────────────────────────────────────────────────────
  server.registerTool(
    'list_shares',
    {
      description:
        'List existing share links with their domains, counts, and URLs. Revoked shares are omitted unless include_revoked is set. The url is null for a revoked share.',
      inputSchema: {
        include_revoked: z.boolean().optional().default(false).describe('Include revoked shares in the listing (default false).'),
      },
    },
    async ({ include_revoked }) => {
      const all = listSharesWithUrls();
      const shares = (include_revoked ? all : all.filter(s => !s.revoked)).map(s => ({
        id: s.id,
        name: s.name,
        domains: s.domains,
        node_count: s.node_count,
        edge_count: s.edge_count,
        url: s.url,
        revoked: s.revoked,
        created_at: s.created_at,
        expires_at: s.expires_at,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: shares.length, shares }, null, 2) }],
        structuredContent: { count: shares.length, shares },
      };
    },
  );

  // ── revoke_share ─────────────────────────────────────────────────────
  server.registerTool(
    'revoke_share',
    {
      description:
        'Revoke a share by id — the link stops working (returns 410) and its snapshot is deleted. Returns a not-found result if no share has that id.',
      inputSchema: {
        id: z.string().min(1).describe('The share id (as returned by create_share / list_shares).'),
      },
    },
    async ({ id }) => {
      const revoked = revokeShareById(id);
      if (!revoked) {
        return {
          content: [{ type: 'text' as const, text: `Share ${id} not found — nothing to revoke.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Share ${id} revoked. Its link no longer resolves and the snapshot was deleted.` }],
      };
    },
  );

  // ── Artifact store ───────────────────────────────────────────────────
  // Upload / list / read artifacts (skills, docs, CSVs, blobs) stored in the
  // graph. These orchestrate through src/artifacts/service.ts — the exact same
  // create/list/get code the REST /api/artifacts handlers call, so the two
  // surfaces can't drift. Registered ONLY here (the main /mcp server); the
  // per-share read-only capsule uses registerReadTools and never gets these,
  // so a share can never write artifacts.

  // ── create_artifact ──────────────────────────────────────────────────
  server.registerTool(
    'create_artifact',
    {
      description:
        'Store an artifact (a skill, document, CSV, JSON, or binary blob) in the graph and get back its id + entity_id. The artifact becomes an addressable node you can link to and read later. Identical content re-uploaded to the same domain is deduplicated (deduped:true) rather than duplicated.',
      inputSchema: {
        title: z.string().min(1).describe('Human-readable title for the artifact.'),
        domain: z.string().min(1).describe('Which graph domain this artifact belongs to. REQUIRED — there is no default; you must name the domain (e.g. "enox-skills").'),
        content_type: z.string().min(1).describe("MIME content type, e.g. 'text/markdown', 'text/csv', 'application/json'."),
        body: z.string().describe('The artifact content. For binary types, pass base64 text and set encoding:"base64".'),
        encoding: z.enum(['utf8', 'base64']).optional().default('utf8').describe('How `body` is encoded. Use "base64" for binary content-types.'),
        filename: z.string().optional().describe('Optional original filename (affects the on-disk blob name only).'),
        parse_okf: z.boolean().optional().default(false).describe('If the body is markdown, materialize its OKF frontmatter relations into the graph as edges.'),
        links: z.array(z.object({
          entity_id: z.string().min(1).describe('Existing entity id to link this artifact to.'),
          relation: z.enum(RELATION_TYPES).optional().default('describes').describe('Relation type for the edge (default "describes").'),
        })).optional().default([]).describe('Explicit edges from the artifact node to existing entities in the graph.'),
      },
    },
    async ({ title, domain, content_type, body, encoding, filename, parse_okf, links }) => {
      try {
        const r = await createArtifact({ title, domain, content_type, body, encoding, filename, parse_okf, links });
        const summary = r.deduped
          ? `Artifact "${r.title}" already existed in domain "${r.domain}" (deduped by content hash).\n` +
            `id: ${r.id}\nentity_id: ${r.entity_id}\nsize: ${r.size} bytes, sha256: ${r.sha256}`
          : `Artifact "${r.title}" created in domain "${r.domain}".\n` +
            `id: ${r.id}\nentity_id: ${r.entity_id}\n` +
            `content_type: ${r.content_type}, size: ${r.size} bytes, sha256: ${r.sha256}\n` +
            `links_created: ${r.links_created}, edges_materialized: ${r.edges_materialized}`;
        return {
          content: [{ type: 'text' as const, text: summary }],
          structuredContent: r as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create artifact: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── list_artifacts ───────────────────────────────────────────────────
  server.registerTool(
    'list_artifacts',
    {
      description:
        'List stored artifacts (newest first), optionally filtered by domain and/or content_type. Returns compact records; use get_artifact to read a specific one.',
      inputSchema: {
        domain: z.string().optional().describe('Filter to artifacts in this domain.'),
        content_type: z.string().optional().describe('Filter to this exact content_type.'),
        limit: z.number().int().min(1).max(500).optional().default(100).describe('Max results (1..500, default 100).'),
        offset: z.number().int().min(0).optional().default(0).describe('Pagination offset (default 0).'),
      },
    },
    async ({ domain, content_type, limit, offset }) => {
      const rows = listArtifacts({ domain, content_type, limit, offset });
      const artifacts = rows.map(r => ({
        id: r.id,
        entity_id: r.entity_id,
        title: r.title,
        domain: r.domain,
        content_type: r.content_type,
        filename: r.filename,
        size: r.size,
        created_at: r.created_at,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ count: artifacts.length, artifacts }, null, 2) }],
        structuredContent: { count: artifacts.length, artifacts },
      };
    },
  );

  // ── get_artifact ─────────────────────────────────────────────────────
  server.registerTool(
    'get_artifact',
    {
      description:
        'Read a stored artifact by id: its record, its outgoing (`links`) and `incoming` graph edges, and — when include_body is set and the content_type is text-ish — the decoded text body. This is how you READ a stored skill or document.',
      inputSchema: {
        id: z.string().min(1).describe('The artifact id (as returned by create_artifact / list_artifacts).'),
        include_body: z.boolean().optional().default(true).describe('Include the decoded text body when the content_type is text-ish (default true). Binary blobs are never inlined.'),
      },
    },
    async ({ id, include_body }) => {
      const result = await getArtifact(id, { includeBody: include_body });
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: `Artifact ${id} not found.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
