import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'enox-smart-node',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerTools(server);

  return server;
}
