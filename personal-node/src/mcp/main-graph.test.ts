import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer, seedGraph, type TestHarness } from '../test-support/harness.js';

let harness: TestHarness;

before(async () => {
  harness = await startTestServer();
  await seedGraph(
    [{ id: 'm1', type: 'concept', domain: 'main', name: 'Main Node' }],
    [],
  );
});

after(async () => {
  await harness.stop();
});

test('main graph REST API still requires auth', async () => {
  const unauth = await fetch(`${harness.baseUrl}/api/nodes`);
  assert.equal(unauth.status, 401);

  const authed = await fetch(`${harness.baseUrl}/api/nodes`, {
    headers: { Authorization: `Bearer ${harness.authToken}` },
  });
  assert.equal(authed.status, 200);
  const nodes = (await authed.json()) as Array<{ id: string }>;
  assert.ok(nodes.some(n => n.id === 'm1'));
});

test('main /mcp still requires auth and exposes both read and write tools after the read-tools refactor', async () => {
  const unauthResp = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
    }),
  });
  assert.equal(unauthResp.status, 401, 'main /mcp must still require the main auth token');

  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${harness.authToken}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();

  for (const readTool of ['query_graph', 'graph_stats', 'explore', 'traverse', 'recall', 'semantic_search']) {
    assert.ok(names.includes(readTool), `main graph should still expose read tool ${readTool}`);
  }
  for (const writeTool of ['add_assertion', 'update_assertion', 'delete_assertion', 'update_node', 'remember', 'batch_assertions', 'decide', 'recent_activity']) {
    assert.ok(names.includes(writeTool), `main graph should still expose ${writeTool}`);
  }

  await client.close();
});

// ── Provenance: source_ref / asserted_by first-class (asserted_by required
// on REST creation, no anonymous facts), proof_depth left as-is (optional,
// default 0 — retire-vs-revive is an open decision, not settled here) ──

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${harness.authToken}`,
      ...(init.headers ?? {}),
    },
  });
}

test('createNode with source_ref round-trips through getNode', async () => {
  const createResp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      type: 'paper',
      domain: 'enox',
      name: 'Provenance Round-Trip Test Paper',
      source_ref: 'https://arxiv.org/abs/9999.99999',
    }),
  });
  assert.equal(createResp.status, 201);
  const created = (await createResp.json()) as { id: string; source_ref: string };
  assert.equal(created.source_ref, 'https://arxiv.org/abs/9999.99999');

  const getResp = await authedFetch(`/api/node?id=${encodeURIComponent(created.id)}`);
  assert.equal(getResp.status, 200);
  const fetched = (await getResp.json()) as { source_ref: string };
  assert.equal(fetched.source_ref, 'https://arxiv.org/abs/9999.99999');
});

// "No paper node without a URL" (project decision, 2026-07-24) — targeted rule on
// CreateNodeSchema only; existing paper nodes without source_ref are
// grandfathered (UpdateNodeSchema is untouched).

test('createNode type=paper without source_ref -> 400', async () => {
  const resp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ type: 'paper', domain: 'enox', name: 'Paper Missing Source Ref Test' }),
  });
  assert.equal(resp.status, 400);
});

test('createNode type=paper with a valid URL source_ref -> 201', async () => {
  const resp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      type: 'paper',
      domain: 'enox',
      name: 'Paper Valid Source Ref Test',
      source_ref: 'https://arxiv.org/abs/2504.19413',
    }),
  });
  assert.equal(resp.status, 201);
});

test('createNode type=paper with a non-URL source_ref -> 400', async () => {
  const resp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ type: 'paper', domain: 'enox', name: 'Paper Bad Source Ref Test', source_ref: 'not-a-url' }),
  });
  assert.equal(resp.status, 400);
});

test('createNode type=concept without source_ref -> 201 (rule is paper-only)', async () => {
  const resp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ type: 'concept', domain: 'test', name: 'Concept No Source Ref Test' }),
  });
  assert.equal(resp.status, 201);
});

test('createAssertion requires asserted_by — 400 when missing, round-trips (with proof_depth) when present', async () => {
  await seedGraph(
    [
      { id: 'prov-a', type: 'concept', domain: 'test', name: 'Prov A' },
      { id: 'prov-b', type: 'concept', domain: 'test', name: 'Prov B' },
      { id: 'prov-g', type: 'concept', domain: 'test', name: 'Prov G' },
      { id: 'prov-h', type: 'concept', domain: 'test', name: 'Prov H' },
    ],
    [],
  );

  // No anonymous facts via REST: omitting asserted_by is a 400, not a silent default.
  const missing = await authedFetch('/api/assertions', {
    method: 'POST',
    body: JSON.stringify({ source: 'prov-g', target: 'prov-h', relation: 'references' }),
  });
  assert.equal(missing.status, 400);

  // Present -> round-trips through create + get. proof_depth is still optional
  // (not retired) and defaults to 0 when the caller doesn't supply it.
  const withIdentity = await authedFetch('/api/assertions', {
    method: 'POST',
    body: JSON.stringify({ source: 'prov-a', target: 'prov-b', relation: 'references', asserted_by: 'alice' }),
  });
  assert.equal(withIdentity.status, 201);
  const created = (await withIdentity.json()) as { asserted_by: string; fact_id: string; proof_depth: number };
  assert.equal(created.asserted_by, 'alice');
  assert.equal(created.proof_depth, 0);

  const getResp = await authedFetch(`/api/assertions/${encodeURIComponent(created.fact_id)}`);
  const fetched = (await getResp.json()) as { asserted_by: string; proof_depth: number };
  assert.equal(fetched.asserted_by, 'alice');
  assert.equal(fetched.proof_depth, 0);
});

test('MCP add_assertion defaults asserted_by to the configured agent identity (never alice) when the caller omits it', async () => {
  await seedGraph(
    [
      { id: 'prov-i', type: 'concept', domain: 'test', name: 'Prov I' },
      { id: 'prov-j', type: 'concept', domain: 'test', name: 'Prov J' },
    ],
    [],
  );

  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${harness.authToken}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(transport);

  const result = await client.callTool({
    name: 'add_assertion',
    arguments: { source: 'prov-i', target: 'prov-j', relation: 'references' },
  });
  await client.close();

  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text').map(c => c.text).join('\n');
  const parsed = JSON.parse(text) as { asserted_by: string };
  // Test harness leaves ENOX_AGENT_IDENTITY unset, so this is the code's own
  // default — an MCP write tool is called by an agent, not typed by a human,
  // so an omitted identity must never be attributed to him.
  assert.notEqual(parsed.asserted_by, 'alice');
  assert.equal(parsed.asserted_by, 'agent:unknown');
});

test('concept --references--> paper node carries structural source_ref provenance (nanopub-style, end-to-end)', async () => {
  const paperResp = await authedFetch('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({
      type: 'paper',
      domain: 'enox',
      name: 'Anatomy of a Nanopublication (test fixture)',
      source_ref: 'https://doi.org/10.3233/ISU-2010-0613',
    }),
  });
  assert.equal(paperResp.status, 201);
  const paper = (await paperResp.json()) as { id: string; source_ref: string };

  await seedGraph([{ id: 'concept-nanopub-test', type: 'concept', domain: 'test', name: 'Nanopublications (test fixture)' }], []);

  const edgeResp = await authedFetch('/api/assertions', {
    method: 'POST',
    body: JSON.stringify({
      source: 'concept-nanopub-test',
      target: paper.id,
      relation: 'references',
      asserted_by: 'session:test-provenance-e2e',
      context: 'test fixture mirroring the Nanopublications -> Anatomy-of-a-Nanopublication backfill',
    }),
  });
  assert.equal(edgeResp.status, 201);
  const edge = (await edgeResp.json()) as { asserted_by: string };
  assert.equal(edge.asserted_by, 'session:test-provenance-e2e');

  const neighbors = await authedFetch(`/api/graph/neighbors?id=${encodeURIComponent('concept-nanopub-test')}`);
  const body = (await neighbors.json()) as { outgoing: Array<{ target: string; relation: string; asserted_by?: string }> };
  const outEdge = body.outgoing.find(o => o.target === paper.id && o.relation === 'references');
  assert.ok(outEdge, 'the references edge should be in neighbors output');
  assert.equal(outEdge!.asserted_by, 'session:test-provenance-e2e', '/api/graph/neighbors must surface asserted_by on the edge, not leave it undefined');

  // And from the paper's own side: its /api/graph/neighbors node payload must
  // carry source_ref (this is the read path a share-explorer node click hits).
  const paperNeighbors = await authedFetch(`/api/graph/neighbors?id=${encodeURIComponent(paper.id)}`);
  const paperNeighborsBody = (await paperNeighbors.json()) as { node: { source_ref?: string }; incoming: Array<{ source: string; relation: string; asserted_by?: string }> };
  assert.equal(paperNeighborsBody.node.source_ref, 'https://doi.org/10.3233/ISU-2010-0613', '/api/graph/neighbors node payload must include source_ref');
  const inEdge = paperNeighborsBody.incoming.find(i => i.source === 'concept-nanopub-test');
  assert.equal(inEdge?.asserted_by, 'session:test-provenance-e2e', 'incoming side of /api/graph/neighbors must also surface asserted_by');

  const traverse = await authedFetch(`/api/graph/traverse?id=${encodeURIComponent('concept-nanopub-test')}&max_depth=1`);
  const traverseBody = (await traverse.json()) as { edges: Array<{ tgt: string; relation: string; asserted_by?: string }> };
  const traverseEdge = traverseBody.edges.find(e => e.tgt === paper.id && e.relation === 'references');
  assert.equal(traverseEdge?.asserted_by, 'session:test-provenance-e2e', '/api/graph/traverse must surface asserted_by on each edge');

  const paperGet = await authedFetch(`/api/node?id=${encodeURIComponent(paper.id)}`);
  const paperFetched = (await paperGet.json()) as { source_ref: string };
  assert.equal(paperFetched.source_ref, 'https://doi.org/10.3233/ISU-2010-0613');
});

test('MCP query_graph/explore/traverse surface source_ref (node) and asserted_by (edge)', async () => {
  await seedGraph(
    [
      { id: 'mcp-prov-paper', type: 'paper', domain: 'test', name: 'MCP Provenance Paper', source_ref: 'https://arxiv.org/abs/1111.11111' },
      { id: 'mcp-prov-concept', type: 'concept', domain: 'test', name: 'MCP Provenance Concept' },
    ],
    [{ source: 'mcp-prov-concept', target: 'mcp-prov-paper', relation: 'references', fact_id: 'fact-mcp-prov', asserted_by: 'agent:test-runner' }],
  );

  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${harness.authToken}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(transport);

  const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
    (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text).join('\n');

  const queryResult = await client.callTool({ name: 'query_graph', arguments: { node_id: 'mcp-prov-paper' } });
  const queryParsed = JSON.parse(textOf(queryResult)) as { node: { source_ref?: string }; incoming: Array<{ asserted_by?: string }> };
  assert.equal(queryParsed.node.source_ref, 'https://arxiv.org/abs/1111.11111', 'query_graph node_id lookup must include source_ref');
  assert.ok(queryParsed.incoming.some(i => i.asserted_by === 'agent:test-runner'), 'query_graph node_id lookup must include asserted_by on edges');

  const exploreResult = await client.callTool({ name: 'explore', arguments: { entity: 'mcp-prov-paper' } });
  const exploreText = textOf(exploreResult);
  assert.match(exploreText, /Source: https:\/\/arxiv\.org\/abs\/1111\.11111/, 'explore text should show the node Source line');
  assert.match(exploreText, /\[by agent:test-runner\]/, 'explore text should show asserted_by on the edge');

  const traverseResult = await client.callTool({ name: 'traverse', arguments: { entity: 'mcp-prov-concept', max_depth: 1 } });
  const traverseText = textOf(traverseResult);
  assert.match(traverseText, /\[by agent:test-runner\]/, 'traverse text should show asserted_by on the edge');

  await client.close();
});
