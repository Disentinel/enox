// Streamable HTTP /mcp session-handling: spec-correct behavior for an unknown
// Mcp-Session-Id (e.g. after a server restart wiped the in-memory httpSessions
// Map). The client must get HTTP 404 so it transparently re-runs `initialize`,
// NOT a 200 JSON-RPC -32000 "Server not initialized" that it can't recover from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestHarness } from '../test-support/harness.js';

let harness: TestHarness;

before(async () => {
  harness = await startTestServer();
});

after(async () => {
  await harness.stop();
});

const MCP_ACCEPT = 'application/json, text/event-stream';

test('POST /mcp with an unknown mcp-session-id and a non-initialize body -> 404 (reinitialize), not 200 Server not initialized', async () => {
  const resp = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${harness.authToken}`,
      'mcp-session-id': 'bogus-session-does-not-exist',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  assert.equal(resp.status, 404, 'unknown session id must yield HTTP 404 so the client re-initializes');
  const body = (await resp.json()) as { error?: { code?: number; message?: string } };
  assert.equal(body.error?.code, -32001);
  // Must NOT be the misleading SDK "Server not initialized" fall-through.
  assert.doesNotMatch(JSON.stringify(body), /Server not initialized/i);
});

test('POST /mcp with NO session id and a valid initialize body -> 200 + returns an mcp-session-id header (happy path intact)', async () => {
  const resp = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${harness.authToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
    }),
  });

  assert.equal(resp.status, 200, 'initialize with no session id must still create a session');
  assert.ok(resp.headers.get('mcp-session-id'), 'initialize response must return an mcp-session-id header');
});

test('POST /mcp with NO session id and a non-initialize body -> 400 (bad request, not a new session)', async () => {
  const resp = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${harness.authToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  assert.equal(resp.status, 400);
  const body = (await resp.json()) as { error?: { code?: number } };
  assert.equal(body.error?.code, -32000);
});

test('DELETE /mcp with an unknown mcp-session-id -> 404, and with no session id -> 400', async () => {
  const unknown = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${harness.authToken}`,
      'mcp-session-id': 'bogus-session-does-not-exist',
    },
  });
  assert.equal(unknown.status, 404, 'unknown session id on DELETE must be 404');

  const missing = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${harness.authToken}` },
  });
  assert.equal(missing.status, 400, 'missing session id on DELETE must be 400');
});
