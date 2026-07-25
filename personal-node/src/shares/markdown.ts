// Builds the agent-native landing document for a share — effectively a SKILL.md
// for whatever AI agent fetches GET /share/:id. Tool descriptions are pulled from
// read-tools.ts's catalog so this can never drift from what the MCP server actually
// exposes; counts are pulled from the same buildShareSummary() the JSON /api/summary
// endpoint uses, for the same reason.
import { READ_TOOL_CATALOG, SEMANTIC_SEARCH_CATALOG_ENTRY } from '../mcp/read-tools.js';
import type { ShareSummary } from './summary.js';
import type { ShareRecord } from './types.js';
import type { SnapshotGraphStore } from './snapshot-store.js';
import type { NodeRecord } from '../mcp/graph-store.js';

export interface ShareLandingUrls {
  mcpUrl: string;
  apiBaseUrl: string;
  token: string;
}

// summary is passed in (computed once by the caller via buildShareSummary) so
// the markdown and the HTML receipt page never call it twice for one request.
export async function buildShareLandingMarkdown(
  share: ShareRecord,
  store: SnapshotGraphStore,
  summary: ShareSummary,
  urls: ShareLandingUrls,
): Promise<string> {
  const { mcpUrl, apiBaseUrl, token } = urls;

  const nodeTypeLines = topEntries(summary.nodes_by_type);
  const relationLines = topEntries(summary.edges_by_relation);

  const tools = [...READ_TOOL_CATALOG];
  if (store.supportsSemanticSearch) tools.push(SEMANTIC_SEARCH_CATALOG_ENTRY);

  const picks = await pickExampleNodes(store);

  const lines: string[] = [];
  lines.push(`# ${share.name}`);
  lines.push('');
  if (share.description) {
    lines.push(share.description);
    lines.push('');
  }
  lines.push('This is a shared slice of an Enox knowledge graph. Give this URL to your AI agent — it can fetch this document for instructions and then query the graph directly, with plain HTTP GET requests or over MCP if you have a client for it. (A human opening this same URL in a browser sees a receipt of what is shared, plus a small graph viewer, instead of this markdown.)');
  lines.push('');

  lines.push('## What is Enox');
  lines.push('Enox is a personal knowledge graph: entities (concepts, decisions, people, papers, etc.) connected by typed, confidence-scored assertions (edges) with provenance and free-text context. This share is a read-only, point-in-time snapshot of one slice of it — scoped to the domain(s) below.');
  lines.push('Enox is an open protocol: https://github.com/Disentinel/enox');
  lines.push('');

  lines.push('## What is in this share');
  lines.push(`Domains: ${summary.domains.join(', ')}`);
  lines.push(`Nodes: ${summary.node_count} total`);
  if (nodeTypeLines.length) lines.push(nodeTypeLines.map(l => `  - ${l}`).join('\n'));
  lines.push(`Edges: ${summary.edge_count} total`);
  if (relationLines.length) lines.push(relationLines.map(l => `  - ${l}`).join('\n'));
  lines.push('');

  // HTTP API comes first: the most common guest agent is a web-chat agent with
  // a browsing/fetch tool and no MCP client, so this has to be self-sufficient
  // on its own — complete GET examples with the token already filled in, for
  // every endpoint, not just a couple.
  lines.push('## HTTP API (works with any agent that can fetch a URL)');
  lines.push("Plain HTTP GET, no MCP client or library needed — every endpoint below takes the token as a query param. This is the primary way to use a share; most guest agents (a web chat with a browsing tool, e.g. ChatGPT) only have this, not an MCP client.");
  lines.push('');
  lines.push(`- \`GET ${apiBaseUrl}/summary\` — this same overview as JSON`);
  lines.push(`- \`GET ${apiBaseUrl}/nodes?q=<substring>\` — search nodes by name/description`);
  lines.push(`- \`GET ${apiBaseUrl}/nodes/<nodeId>\` — one node plus all its edges (nodeId must be URL-encoded)`);
  lines.push(`- \`GET ${apiBaseUrl}/explore?name=<name-or-id>\` — one entity and its connections as readable text`);
  lines.push(`- \`GET ${apiBaseUrl}/traverse?from=<name-or-id>&depth=1..3\` — multi-hop BFS subgraph`);
  if (store.supportsSemanticSearch) {
    lines.push(`- \`GET ${apiBaseUrl}/search?q=<text>\` — meaning-based search (embeddings)`);
  }
  lines.push('');
  lines.push('Complete, ready-to-fetch examples (token already filled in) — one per endpoint:');
  lines.push('');
  lines.push('```');
  lines.push(`${apiBaseUrl}/summary?token=${token}`);
  if (picks[0]) lines.push(`${apiBaseUrl}/nodes?q=${encodeURIComponent(firstWord(picks[0].name))}&token=${token}`);
  if (picks[0]) lines.push(`${apiBaseUrl}/nodes/${encodeURIComponent(picks[0].id)}?token=${token}`);
  if (picks[0]) lines.push(`${apiBaseUrl}/explore?name=${encodeURIComponent(picks[0].name)}&token=${token}`);
  if (picks[1] ?? picks[0]) lines.push(`${apiBaseUrl}/traverse?from=${encodeURIComponent((picks[1] ?? picks[0]).name)}&depth=2&token=${token}`);
  if (store.supportsSemanticSearch) {
    const q = picks[0]?.description?.slice(0, 60) || picks[0]?.name || 'a topic in this domain';
    lines.push(`${apiBaseUrl}/search?q=${encodeURIComponent(q)}&token=${token}`);
  }
  lines.push('```');
  lines.push('');

  lines.push('## MCP endpoint (secondary — only if you have an MCP client)');
  lines.push('Connect your MCP client (Streamable HTTP) to:');
  lines.push('');
  lines.push('```');
  lines.push(mcpUrl);
  lines.push('```');
  lines.push('');
  lines.push('The token is already embedded in the URL above — no separate auth step needed.');
  lines.push('');

  lines.push('## Tools (MCP)');
  for (const t of tools) {
    lines.push(`- **${t.name}** — ${t.oneLiner}`);
  }
  lines.push('');

  const mcpExamples = buildMcpExamples(picks, store.supportsSemanticSearch);
  if (mcpExamples.length) {
    lines.push('## Example MCP queries to try');
    for (const ex of mcpExamples) lines.push(`- ${ex}`);
    lines.push('');
  }

  lines.push('## Etiquette');
  lines.push(`This is a read-only view scoped to: ${summary.domains.join(', ')}. There are no write tools or write endpoints — you cannot modify the owner's graph. Please don't attempt to probe outside this scope; anything not in the domains above simply isn't here.`);

  return lines.join('\n') + '\n';
}

function firstWord(name: string): string {
  return name.split(' ')[0] || name;
}

function topEntries(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, cnt]) => `${k}: ${cnt}`);
}

async function pickExampleNodes(store: SnapshotGraphStore): Promise<NodeRecord[]> {
  const sample = await store.findNodes({ limit: 200 });
  if (sample.length === 0) return [];

  // Prefer well-connected nodes for examples — more interesting to traverse/explore.
  const withDegree = await Promise.all(sample.map(async n => ({
    node: n,
    degree: (await store.outgoing(n.id)).length + (await store.incoming(n.id)).length,
  })));
  withDegree.sort((a, b) => b.degree - a.degree);
  return withDegree.slice(0, 3).map(x => x.node);
}

function buildMcpExamples(picks: NodeRecord[], supportsSemanticSearch: boolean): string[] {
  if (picks.length === 0) return [];

  const examples: string[] = [];
  if (picks[0]) examples.push(`explore("${picks[0].name}") — see everything connected to it`);
  if (picks[1]) examples.push(`traverse("${picks[1].name}", max_depth=2) — walk the subgraph two hops out`);
  if (supportsSemanticSearch) {
    examples.push(`semantic_search("${picks[0]?.description?.slice(0, 60) || picks[0]?.name || 'a topic in this domain'}") — meaning-based search`);
  } else {
    examples.push(`query_graph(query="${firstWord(picks[0].name)}") — text search by name`);
  }
  examples.push(`recall("${picks[2]?.name || picks[0]?.name}") — broad "what do we know about this" summary`);

  return examples;
}
