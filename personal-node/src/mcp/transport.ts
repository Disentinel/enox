import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.js';

// JSON-RPC body returned when a client presents an Mcp-Session-Id the server no
// longer knows (e.g. the in-memory httpSessions Map was wiped by a restart). Per
// the MCP Streamable HTTP spec the server MUST answer HTTP 404 so the client
// transparently re-runs `initialize` and gets a fresh session, rather than being
// fed into a new transport that answers -32000 "Server not initialized".
const SESSION_NOT_FOUND_BODY = {
  jsonrpc: '2.0' as const,
  error: { code: -32001, message: 'Session not found or expired; reinitialize' },
  id: null,
};

export function mountMcpTransports(app: Express): void {
  // --- SSE transport (primary, per plan spec) ---
  const sseSessions = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/sse/messages', res);
    const sessionId = transport.sessionId;
    sseSessions.set(sessionId, transport);
    console.log(`[mcp/sse] session ${sessionId} connected`);

    const server = createMcpServer();
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

    if (sessionId) {
      // A session id was presented: either resume the known session, or 404 so
      // the client re-initializes. Never fall through into "New session" here —
      // that would feed a non-initialize body to a fresh transport and get a
      // misleading -32000 "Server not initialized" (HTTP 200).
      if (httpSessions.has(sessionId)) {
        const transport = httpSessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }
      console.log(`[mcp/http] unknown session ${sessionId} on POST -> 404 (reinitialize)`);
      res.status(404).json(SESSION_NOT_FOUND_BODY);
      return;
    }

    // No session id: only an initialize request may create a new session.
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no session ID and not an initialize request' },
        id: null,
      });
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

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    const transport = httpSessions.get(sessionId);
    if (!transport) {
      console.log(`[mcp/http] unknown session ${sessionId} on GET -> 404 (reinitialize)`);
      res.status(404).json(SESSION_NOT_FOUND_BODY);
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    const transport = httpSessions.get(sessionId);
    if (!transport) {
      console.log(`[mcp/http] unknown session ${sessionId} on DELETE -> 404 (reinitialize)`);
      res.status(404).json(SESSION_NOT_FOUND_BODY);
      return;
    }
    await transport.handleRequest(req, res);
    httpSessions.delete(sessionId);
  });
}
