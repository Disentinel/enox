import type { Request, Response } from 'express';
import { queryAll } from '../db.js';
import { searchSimilar } from '../embeddings.js';
import { getConfig } from '../federation.js';

interface ContextNode {
  id: string;
  name: string;
  type: string;
  domain: string;
  description: string;
  score: number;
}

interface ContextEdge {
  source_name: string;
  target_name: string;
  relation: string;
  confidence: number;
  context: string;
}

// Approximate token count (1 token ≈ 4 chars)
function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

// Naive stemming: strip common suffixes
function stem(word: string): string {
  return word
    .replace(/(?:ies|es|s|ing|ed|tion|ment|ness|ity|ous|ive|able|ible)$/i, '')
    .replace(/(?:ов|ев|ей|ий|ых|их|ам|ям|ами|ями|ах|ях|ом|ем|ой|ей|ую|юю|ая|яя|ое|ее|ые|ие|ого|его|ому|ему)$/i, ''); // basic Russian
}

// Extract potential entity mentions from user prompt
function extractMentions(prompt: string): string[] {
  const words = prompt.toLowerCase();
  const tokens = words.split(/[\s,.:;!?()"']+/).filter((w) => w.length > 2);
  // Also add stemmed versions
  const stemmed = tokens.map(stem).filter((w) => w.length > 2);
  // And 2-gram phrases
  const wordList = words.split(/\s+/);
  for (let i = 0; i < wordList.length - 1; i++) {
    tokens.push(wordList.slice(i, i + 2).join(' '));
    if (i < wordList.length - 2) {
      tokens.push(wordList.slice(i, i + 3).join(' '));
    }
  }
  return [...new Set([...tokens, ...stemmed])];
}

export async function getContext(req: Request, res: Response) {
  const { prompt, budget = 1500 } = req.body as { prompt?: string; budget?: number };

  if (!prompt || !prompt.trim()) {
    res.json({ nodes: [], edges: [], overflow: 0 });
    return;
  }

  const charBudget = (budget as number) * 4;
  const mentions = extractMentions(prompt);

  // Step 1: Find matching entities — local + federation peers
  type NodeRow = { id: string; name: string; type: string; domain: string; description: string; aliases: string[] | null; _node?: string };

  const localNodes = await queryAll<NodeRow>(
    'MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.type AS type, e.domain AS domain, e.description AS description, e.aliases AS aliases',
  );

  const allNodes: NodeRow[] = [...localNodes];

  // Fetch from federation peers in parallel
  const config = getConfig();
  if (config?.peers?.length) {
    const peerFetches = config.peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.url}/api/nodes`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const peerNodes = (await resp.json()) as NodeRow[];
          const localIds = new Set(localNodes.map(n => n.id));
          for (const n of peerNodes) {
            if (!localIds.has(n.id)) {
              allNodes.push({ ...n, _node: peer.prefix });
            }
          }
        }
      } catch {
        // Peer unreachable, skip
      }
    });
    await Promise.all(peerFetches);
  }

  // Score each node by how well it matches the prompt
  const scored: Array<{ node: typeof allNodes[0]; score: number }> = [];

  for (const node of allNodes) {
    let score = 0;
    const nameLower = node.name.toLowerCase();
    const nameStemmed = stem(nameLower);
    // Split multi-word name into individual words for matching
    const nameWords = nameLower.split(/[\s\-_]+/);
    const aliases = (node.aliases || []).map((a) => a.toLowerCase());

    for (const mention of mentions) {
      const mentionStem = stem(mention);

      // Exact name match
      if (nameLower === mention) {
        score += 10;
      }
      // Name contains mention (require 5+ chars to avoid noise)
      else if (nameLower.includes(mention) && mention.length > 4) {
        score += 5;
      }
      // Stemmed match: "perspectives" → "perspect" matches "perspective"
      else if (mentionStem.length > 4 && nameStemmed.includes(mentionStem)) {
        score += 5;
      }
      // Individual word match: "perspective" in "Perspective as Lens"
      else if (nameWords.some(w => w === mention || (mentionStem.length > 4 && stem(w) === mentionStem))) {
        score += 4;
      }
      // Mention contains name (require 5+ chars)
      else if (mention.includes(nameLower) && nameLower.length > 5) {
        score += 3;
      }
      // Alias match
      for (const alias of aliases) {
        if (alias === mention) score += 8;
        else if (alias.includes(mention) && mention.length > 4) score += 4;
      }
    }

    // Skip provenance-heavy nodes in ambient context
    if (node.type === 'date' || node.type === 'event') {
      score *= 0.3;
    }

    if (score > 0) {
      scored.push({ node, score });
    }
  }

  // Fallback: if text matching found few results, try embedding similarity
  if (scored.length < 5) {
    try {
      const embResults = await searchSimilar(prompt, 10);
      for (const { id, score: embScore } of embResults) {
        if (embScore < 0.3) continue; // skip weak matches
        const existing = scored.find(s => s.node.id === id);
        if (existing) {
          existing.score += embScore * 5; // boost already-matched
        } else {
          const n = allNodes.find(n => n.id === id);
          if (n) scored.push({ node: n, score: embScore * 5 });
        }
      }
    } catch {
      // Embeddings not ready yet, skip
    }
  }

  if (scored.length === 0) {
    res.json({ nodes: [], edges: [], overflow: 0 });
    return;
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 2: Take top seed entities, then expand 1-hop
  const seedIds = new Set(scored.slice(0, 10).map((s) => s.node.id));

  // Get 1-hop neighbors of seeds — query each seed individually (KuzuDB list param workaround)
  const neighborRows: Array<{
    src: string;
    src_name: string;
    tgt: string;
    tgt_name: string;
    relation: string;
    confidence: number;
    context: string;
  }> = [];

  // Local neighbors
  for (const seedId of seedIds) {
    const rows = await queryAll<{
      src: string;
      src_name: string;
      tgt: string;
      tgt_name: string;
      relation: string;
      confidence: number;
      context: string;
    }>(
      `MATCH (a:Entity)-[r:Assertion]->(b:Entity)
       WHERE a.id = $seed OR b.id = $seed
       RETURN a.id AS src, a.name AS src_name, b.id AS tgt, b.name AS tgt_name,
              r.relation AS relation, r.confidence AS confidence, r.context AS context`,
      { seed: seedId },
    );
    neighborRows.push(...rows);
  }

  // Peer neighbors — fetch assertions from peers for seeds that live there
  if (config?.peers?.length) {
    for (const peer of config.peers) {
      try {
        const peerEdges = (await (await fetch(`${peer.url}/api/assertions`, { signal: AbortSignal.timeout(3000) })).json()) as Array<{
          source: string; target: string; relation: string; confidence: number; context: string;
        }>;
        // Find peer nodes for name lookup
        const peerNodeMap = new Map(allNodes.filter(n => n._node === peer.prefix).map(n => [n.id, n.name]));
        for (const e of peerEdges) {
          if (seedIds.has(e.source) || seedIds.has(e.target)) {
            neighborRows.push({
              src: e.source,
              src_name: peerNodeMap.get(e.source) || e.source.split('/').pop() || e.source,
              tgt: e.target,
              tgt_name: peerNodeMap.get(e.target) || e.target.split('/').pop() || e.target,
              relation: e.relation,
              confidence: e.confidence,
              context: e.context || '',
            });
          }
        }
      } catch {
        // Peer unreachable
      }
    }
  }

  // Collect all node IDs in the subgraph
  const subgraphNodeIds = new Set(seedIds);
  for (const row of neighborRows) {
    subgraphNodeIds.add(row.src);
    subgraphNodeIds.add(row.tgt);
  }

  // Build node lookup
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Step 3: Rank and budget-pack
  // Score subgraph nodes: seeds get high score, neighbors get edge confidence
  const nodeScores = new Map<string, number>();
  for (const s of scored) {
    nodeScores.set(s.node.id, s.score);
  }
  for (const row of neighborRows) {
    const otherId = seedIds.has(row.src) ? row.tgt : row.src;
    const current = nodeScores.get(otherId) || 0;
    nodeScores.set(otherId, current + row.confidence);
  }

  // Sort all subgraph nodes by score
  const rankedNodeIds = [...subgraphNodeIds].sort(
    (a, b) => (nodeScores.get(b) || 0) - (nodeScores.get(a) || 0),
  );

  // Greedily pack into budget
  const resultNodes: ContextNode[] = [];
  const includedIds = new Set<string>();
  let usedChars = 0;

  for (const nid of rankedNodeIds) {
    const n = nodeMap.get(nid);
    if (!n) continue;

    const entry: ContextNode = {
      id: n.id,
      name: n.name,
      type: n.type,
      domain: n.domain || '',
      description: n.description || '',
      score: nodeScores.get(nid) || 0,
    };

    // For well-known concepts, skip description to save budget for edges
    const isWellKnown = ['concept', 'component', 'pattern'].includes(n.type) && entry.score < 8;
    const descText = isWellKnown ? '' : (n.description || '');
    entry.description = descText;

    const entryCost = tokenEstimate(
      `${n.name} (${n.type}, ${n.domain})${descText ? ' — ' + descText : ''}`,
    ) * 4;

    if (usedChars + entryCost > charBudget) break;

    resultNodes.push(entry);
    includedIds.add(nid);
    usedChars += entryCost;
  }

  // Pack edges between included nodes
  const resultEdges: ContextEdge[] = [];
  let edgeOverflow = 0;

  // Sort edges by confidence descending
  const sortedEdges = [...neighborRows].sort((a, b) => b.confidence - a.confidence);

  for (const row of sortedEdges) {
    if (!includedIds.has(row.src) || !includedIds.has(row.tgt)) continue;
    // Skip provenance edges in ambient context
    if (['discussed_on', 'created_on', 'authored_by'].includes(row.relation)) continue;

    const edgeCost =
      tokenEstimate(`${row.src_name} --[${row.relation}]--> ${row.tgt_name} (${row.confidence})`) * 4;

    if (usedChars + edgeCost > charBudget) {
      edgeOverflow++;
      continue;
    }

    resultEdges.push({
      source_name: row.src_name,
      target_name: row.tgt_name,
      relation: row.relation,
      confidence: row.confidence,
      context: row.context || '',
    });
    usedChars += edgeCost;
  }

  // Count total overflow (nodes + edges that didn't fit)
  const totalOverflow = rankedNodeIds.length - includedIds.size + edgeOverflow;

  res.json({
    nodes: resultNodes,
    edges: resultEdges,
    overflow: totalOverflow,
    seeds: scored.slice(0, 5).map((s) => s.node.name),
    budget_used: Math.ceil(usedChars / 4),
    budget_total: budget,
  });
}
