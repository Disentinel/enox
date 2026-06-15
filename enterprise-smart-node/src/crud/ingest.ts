import type { Request, Response } from 'express';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { queryAll } from '../db/kuzu.js';
import { ENTITY_URI_PREFIX } from '../types.js';
import { computeFactId } from '../util.js';

const PROMPT_TEMPLATE = `You are an ENOX knowledge graph extractor. You receive a short free-text note from a user about their knowledge graph. Extract entities and relations.

## Context
The user is looking at their knowledge graph and adding a note. The note may reference existing entities, add opinions, create new concepts, or draw connections.

## URI references
If the note contains full entity URIs like URIPREFIX_PLACEHOLDER/cs/knowledge_graph — use that exact ID in edges (strip the prefix, use just cs/knowledge_graph). Do NOT create a new entity for it.

## Entity types (free-form — these are common suggestions, not a fixed list)
concept, decision, component, pattern, rejected_alternative, opinion, preference, value, belief, date, event, channel, post, person

## Relation types (free-form — these are common suggestions, not a fixed list)
depends_on, supersedes, implements, contradicts, part_of, extends, enables, isomorphic_to,
decided_on, discussed_on, changed_on, created_on, preceded_by, triggered_by,
prefers, distrusts, values, rejects, believes, frustrated_by,
published_in, authored_by, mentioned_in

## ID format
{domain}/{snake_case_name} — e.g. cs/knowledge_graph, opinion/practice_over_theory

## Output: ONLY valid JSONL, no commentary. Entities first, then edges.

Entity: {"_type": "node", "id": "<domain/slug>", "node_type": "<type>", "label": "<Name>", "description": "<1-2 sentences>", "aliases": [], "domain": "<domain>"}
Edge: {"_type": "edge", "from": "<id>", "rel": "<relation>", "to": "<id>", "confidence": <float>, "context": "<why>", "source": "manual", "extracted": "DATEPLACEHOLDER", "status": "extracted"}

## EXISTING ENTITIES the note may reference:
EXISTING_GRAPH_PLACEHOLDER

## Currently selected entity in the graph:
SELECTED_PLACEHOLDER

## The user's note:
`;

async function getExistingGraph(): Promise<string> {
  try {
    const nodes = await queryAll<{ id: string; name: string }>(
      'MATCH (e:Entity) RETURN e.id AS id, e.name AS name',
    );
    return nodes.map((n) => `${n.id} — ${n.name}`).join('\n');
  } catch {
    return '(empty)';
  }
}

function makeEntityId(domain: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${ENTITY_URI_PREFIX}/${domain}/${slug}`;
}

export async function ingest(req: Request, res: Response) {
  const assertedBy = req.userId ?? 'system';
  const { text, selectedNode } = req.body as {
    text?: string;
    selectedNode?: { id: string; name: string; description?: string };
  };

  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  // Build prompt
  const existingGraph = await getExistingGraph();
  const selectedCtx = selectedNode
    ? `${selectedNode.id} — ${selectedNode.name}${selectedNode.description ? ': ' + selectedNode.description : ''}`
    : '(none)';

  const today = new Date().toISOString().slice(0, 10);
  let prompt = PROMPT_TEMPLATE.replace('EXISTING_GRAPH_PLACEHOLDER', existingGraph)
    .replace('SELECTED_PLACEHOLDER', selectedCtx)
    .replace('URIPREFIX_PLACEHOLDER', ENTITY_URI_PREFIX)
    .replace('DATEPLACEHOLDER', today);
  prompt += text;

  // Run Sonnet
  let rawOutput: string;
  try {
    rawOutput = execSync('claude -p --model sonnet --output-format text', {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Extraction failed', detail: msg.slice(0, 200) });
    return;
  }

  // Parse JSONL
  const created: { nodes: string[]; edges: string[] } = { nodes: [], edges: [] };
  const nodeMap = new Map<string, Record<string, unknown>>();

  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj._type === 'node') {
      const domain = (obj.domain as string) || 'cs';
      const label = (obj.label as string) || '';
      const id = makeEntityId(domain, label);
      nodeMap.set(obj.id as string, { ...obj, resolvedId: id });

      // Create via internal API
      try {
        const { queryOne, execute } = await import('../db/kuzu.js');
        const existing = await queryOne(
          'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
          { id },
        );
        if (!existing) {
          const now = new Date().toISOString();
          await execute(
            'CREATE (:Entity {id: $id, type: $type, domain: $domain, name: $name, description: $description, aliases: $aliases, source_ref: $source_ref, created_at: $now, updated_at: $now})',
            {
              id,
              type: (obj.node_type as string) || 'concept',
              domain,
              name: label,
              description: (obj.description as string) || '',
              aliases: (obj.aliases as string[]) || [],
              source_ref: 'manual',
              now,
            },
          );
          created.nodes.push(label);
        }
      } catch {
        // Node might already exist
      }
    }
  }

  // Second pass: edges
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj._type === 'edge') {
      const fromJsonl = obj.from as string;
      const toJsonl = obj.to as string;

      // Resolve IDs: check nodeMap first, then try as existing graph ID
      const fromNode = nodeMap.get(fromJsonl);
      const toNode = nodeMap.get(toJsonl);

      let fromId = fromNode
        ? (fromNode.resolvedId as string)
        : `${ENTITY_URI_PREFIX}/${fromJsonl}`;
      let toId = toNode
        ? (toNode.resolvedId as string)
        : `${ENTITY_URI_PREFIX}/${toJsonl}`;

      const { queryOne, execute } = await import('../db/kuzu.js');

      // Verify both exist
      const srcExists = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: fromId },
      );
      const tgtExists = await queryOne(
        'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id',
        { id: toId },
      );

      if (!srcExists || !tgtExists) continue;

      const relation = obj.rel as string;
      const factId = computeFactId(fromId, relation, toId);

      // Check duplicate
      const existingEdge = await queryOne(
        'MATCH ()-[r:Assertion]->() WHERE r.fact_id = $fact_id RETURN r.fact_id AS fact_id',
        { fact_id: factId },
      );
      if (existingEdge) continue;

      try {
        const now = new Date().toISOString();
        await execute(
          `MATCH (a:Entity), (b:Entity) WHERE a.id = $source AND b.id = $target
           CREATE (a)-[:Assertion {fact_id: $fact_id, relation: $relation, asserted_by: $asserted_by, confidence: $confidence, proof_depth: $proof_depth, context: $context, created_at: $now, updated_at: $now}]->(b)`,
          {
            source: fromId,
            target: toId,
            fact_id: factId,
            relation,
            asserted_by: assertedBy,
            confidence: (obj.confidence as number) ?? 1.0,
            proof_depth: 0,
            context: (obj.context as string) || '',
            now,
          },
        );
        created.edges.push(`${relation}`);
      } catch {
        // Edge creation failed
      }
    }
  }

  res.json({
    nodes_created: created.nodes,
    edges_created: created.edges,
    summary: `Created ${created.nodes.length} nodes, ${created.edges.length} edges`,
  });
}
