import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

/**
 * Create an MCP server bound to a specific authenticated user. Every write
 * performed over this server's tools is attributed to `assertedBy`
 * (the caller's username), never a hardcoded identity.
 */
export function createMcpServer(assertedBy: string): McpServer {
  const server = new McpServer(
    {
      name: 'enox-smart-node',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `You have access to Enox, a persistent knowledge graph that serves as long-term memory shared across all projects and repositories.

USE ENOX TO:
- Recall past context before starting new work (recall, semantic_search, recent_activity)
- Remember findings, decisions, and experiment results (remember, add_assertion)
- Check if something was already tried or decided (semantic_search, query_graph)
- Explore what is known about an entity (explore)
- Track what supersedes or contradicts prior findings

RECOMMENDED WORKFLOW:
1. At session start: use recent_activity to see what other sessions recorded recently
2. Before decisions: use semantic_search or recall to check for prior art and known failures
3. During work: record important findings with remember (simple) or add_assertion (precise)
4. Use explore to understand the full context around any entity

KEY RELATION TYPES for memory:
- supersedes — newer finding replaces older one
- contradicts — conflicting evidence
- depends_on / enables — causal relationships
- about — links a task/session to its topic
- references — cites an artifact, file, or URL
- triggered_by — what caused this finding/experiment

TIPS:
- Include rich context strings when adding assertions — this is what semantic_search finds
- Use recall for broad "what do we know about X" queries (combines embedding search + graph traversal)
- Use semantic_search for precise similarity matching
- Use query_graph for exact name/type filtering and neighbor traversal
- Staleness: results include age_days — older findings in fast-moving domains (ML) may be outdated`,
    },
  );

  registerTools(server, assertedBy);

  return server;
}
