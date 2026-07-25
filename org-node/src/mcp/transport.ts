import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { loadConfig } from '../config.js';

/**
 * Resolve the asserted_by identity for an MCP connection. In private mode the
 * requireAuth middleware has already rejected anyone without a valid token, so
 * req.userId is set; we fall back to 'anonymous' only on a public node.
 */
function callerIdentity(req: { userId?: string }): string {
  return req.userId ?? (loadConfig().mode === 'public' ? 'anonymous' : 'system');
}

export function mountMcpTransports(app: Express): void {
  // --- SSE transport (primary, per plan spec) ---
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/sse/messages', res);
    const sessionId = transport.sessionId;
    sseSessions.set(sessionId, transport);
    const assertedBy = callerIdentity(req);
    console.log(`[mcp/sse] session ${sessionId} connected (user: ${assertedBy})`);

    const server = createMcpServer(assertedBy);
    await server.connect(transport);

    res.on('close', () => {
      sseSessions.delete(sessionId);
      console.log(`[mcp/sse] session ${sessionId} disconnected`);
    });
  });

  app.post('/sse/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  // --- StreamableHTTP transport (bonus) ---
  const httpSessions = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && httpSessions.has(sessionId)) {
      const transport = httpSessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        httpSessions.set(sid, transport);
        console.log(`[mcp/http] session ${sid} initialized`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) httpSessions.delete(sid);
      console.log(`[mcp/http] session ${sid} closed`);
    };

    const assertedBy = callerIdentity(req);
    const server = createMcpServer(assertedBy);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = httpSessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = httpSessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    await transport.handleRequest(req, res);
    httpSessions.delete(sessionId);
  });
}
