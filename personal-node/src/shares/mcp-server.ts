import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadTools } from '../mcp/read-tools.js';
import type { SnapshotGraphStore } from './snapshot-store.js';
import type { ShareRecord } from './types.js';

// MCP server for a single share, scoped to its snapshot. Only the read tool
// subset is registered (query_graph, graph_stats, explore, traverse, recall,
// and semantic_search when the snapshot carries embeddings) — no write tools,
// no perspectives/queue/workers, matching the "read-only, scope = these
// domains only" contract described on the share's landing page.
export function createShareMcpServer(store: SnapshotGraphStore, share: ShareRecord): McpServer {
  const server = new McpServer(
    {
      name: `enox-share-${share.id}`,
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions: `You have read-only access to "${share.name}", a shared slice of an Enox knowledge graph (domains: ${share.domains.join(', ')}).

${share.description ?? ''}

This is a snapshot, not the live graph — there are no write tools. Use query_graph/explore/traverse/recall to look around, and semantic_search if available for meaning-based lookups. Everything you can see here is in scope; there is nothing else to find outside these domains.`,
    },
  );

  registerReadTools(server, store, { includeSemanticSearch: store.supportsSemanticSearch });

  return server;
}
