import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer, seedGraph, type TestHarness } from '../test-support/harness.js';
import { loadSnapshotStore } from './snapshot-store.js';
import { shareDir } from './snapshot.js';
import { getSqlite } from '../db/sqlite.js';
import { READ_TOOL_CATALOG } from '../mcp/read-tools.js';

let harness: TestHarness;

before(async () => {
  harness = await startTestServer();
  // alpha/beta domains, one cross-domain edge (a1 -> b1) that must never
  // appear in an alpha-only share.
  await seedGraph(
    [
      { id: 'a1', type: 'concept', domain: 'alpha', name: 'Alpha One', description: 'first alpha node' },
      { id: 'a2', type: 'concept', domain: 'alpha', name: 'Alpha Two', description: 'second alpha node' },
      { id: 'b1', type: 'concept', domain: 'beta', name: 'Beta One', description: 'a beta node' },
    ],
    [
      { source: 'a1', target: 'a2', relation: 'depends_on', fact_id: 'fact-a1-a2' },
      { source: 'a1', target: 'b1', relation: 'related_to', fact_id: 'fact-a1-b1' },
    ],
  );
});

after(async () => {
  await harness.stop();
});

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${harness.authToken}`, 'Content-Type': 'application/json' };
}

async function createShare(domains: string[], opts: { name?: string; ttl_days?: number } = {}) {
  const res = await fetch(`${harness.baseUrl}/api/shares`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name: opts.name ?? 'Test Share', domains, ttl_days: opts.ttl_days }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body) as { id: string; url: string; token: string; node_count: number; edge_count: number; artifact_count: number };
}

async function createArtifact(payload: Record<string, unknown>) {
  const res = await fetch(`${harness.baseUrl}/api/artifacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return JSON.parse(body) as { id: string; entity_id: string; size: number; sha256: string };
}

// Pulls `const DATA = {...}` back out of the rendered receipt page. The value
// is JSON (server-templated), so a non-greedy match up to the following
// `const TYPE_RAW` declaration is enough — no need to parse JS.
function extractData(html: string): {
  share: Record<string, unknown>;
  nodes: Array<{ id: string; type: string; name: string; description: string; source_ref?: string }>;
  edges: Array<{ source: string; target: string; relation: string; asserted_by?: string }>;
  artifacts: Array<{ id: string; title: string; content_type: string; filename: string | null }>;
  positions?: Record<string, { x: number; y: number }>;
} {
  const match = html.match(/const DATA = ([\s\S]*?);\s*\nconst TYPE_RAW/);
  assert.ok(match, 'const DATA = {...} should be present in the rendered page');
  return JSON.parse(match![1]);
}

test('share creation exports only in-scope nodes and drops the cross-domain edge', async () => {
  const share = await createShare(['alpha']);
  assert.equal(share.node_count, 2, 'only a1 and a2 are in the alpha domain');
  assert.equal(share.edge_count, 1, 'only a1->a2 has both endpoints in scope');

  const store = loadSnapshotStore(share.id, 'Test Share');
  assert.ok(store, 'snapshot store should load from disk');

  const a1 = await store!.getNode('a1');
  const a2 = await store!.getNode('a2');
  const b1 = await store!.getNode('b1');
  assert.ok(a1 && a2, 'in-scope nodes are present');
  assert.equal(b1, null, 'out-of-scope node must not be in the snapshot');

  const outgoing = await store!.outgoing('a1');
  assert.equal(outgoing.length, 1, 'only the in-scope edge survives');
  assert.equal(outgoing[0].target, 'a2');
  assert.ok(!outgoing.some(e => e.target === 'b1'), 'cross-domain edge must be dropped');
});

test('auth: missing/wrong token -> 401, revoked -> 410, expired -> 410', async () => {
  const share = await createShare(['alpha'], { name: 'Auth Test Share' });

  const noToken = await fetch(`${harness.baseUrl}/share/${share.id}`);
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(`${harness.baseUrl}/share/${share.id}?token=not-the-real-token`);
  assert.equal(wrongToken.status, 401);

  const ok = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  assert.equal(ok.status, 200);

  // Revoke via the owner endpoint, then the same token must now 410.
  const revokeRes = await fetch(`${harness.baseUrl}/api/shares/${share.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.equal(revokeRes.status, 204);

  const afterRevoke = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  assert.equal(afterRevoke.status, 410);

  // Expiry: create a fresh share, then backdate its expires_at directly (no
  // need to wait for a real TTL to elapse).
  const expiring = await createShare(['alpha'], { name: 'Expiring Share', ttl_days: 1 });
  const db = getSqlite();
  db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    expiring.id,
  );

  const afterExpiry = await fetch(`${harness.baseUrl}/share/${expiring.id}?token=${expiring.token}`);
  assert.equal(afterExpiry.status, 410);
});

test('landing markdown contains the MCP endpoint with token and the read-tool catalog', async () => {
  const share = await createShare(['alpha'], { name: 'Markdown Share', });

  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);

  const body = await res.text();
  assert.match(body, new RegExp(`/share/${share.id}/mcp\\?token=${share.token}`));
  for (const t of READ_TOOL_CATALOG) {
    assert.ok(body.includes(t.name), `markdown should mention tool ${t.name}`);
  }
  // No embeddings were produced for this share (embedding worker never ran in
  // tests), so semantic_search must not be advertised.
  assert.ok(!body.includes('semantic_search'), 'semantic_search should be absent without embeddings');
});

test('MCP flow over a share: initialize -> tools/list (read-only) -> tool call stays in scope', async () => {
  const share = await createShare(['alpha'], { name: 'MCP Share' });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${harness.baseUrl}/share/${share.id}/mcp?token=${share.token}`),
  );
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();

  for (const readTool of ['query_graph', 'graph_stats', 'explore', 'traverse', 'recall']) {
    assert.ok(names.includes(readTool), `expected read tool ${readTool} to be present`);
  }
  for (const writeTool of ['add_assertion', 'update_assertion', 'delete_assertion', 'update_node', 'remember', 'batch_assertions', 'decide']) {
    assert.ok(!names.includes(writeTool), `write tool ${writeTool} must not be exposed over a share`);
  }

  const result = await client.callTool({ name: 'query_graph', arguments: { query: 'Alpha' } });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(text, /Alpha One/);
  assert.match(text, /Alpha Two/);
  assert.ok(!text.includes('Beta One'), 'out-of-scope node must never appear in a share tool result');

  await client.close();
});

test('HTTP API: /api/summary and /api/nodes?q= return only in-scope data', async () => {
  const share = await createShare(['alpha'], { name: 'HTTP Summary Share' });
  const base = `${harness.baseUrl}/share/${share.id}/api`;

  const summaryRes = await fetch(`${base}/summary?token=${share.token}`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.equal(summary.node_count, 2);
  assert.equal(summary.edge_count, 1);
  assert.deepEqual(summary.domains, ['alpha']);
  assert.equal(summary.has_semantic_search, false);

  // A query that would match the beta node by substring too ("One" matches
  // both "Alpha One" and "Beta One") must still only return in-scope results,
  // because the snapshot itself never contains the beta node.
  const nodesRes = await fetch(`${base}/nodes?q=${encodeURIComponent('One')}&token=${share.token}`);
  assert.equal(nodesRes.status, 200);
  const nodes = await nodesRes.json() as Array<{ id: string; name: string }>;
  assert.ok(nodes.some((n) => n.id === 'a1'));
  assert.ok(!nodes.some((n) => n.id === 'b1'), 'out-of-scope node must never appear in HTTP API results either');

  const nodeRes = await fetch(`${base}/nodes/${encodeURIComponent('a1')}?token=${share.token}`);
  assert.equal(nodeRes.status, 200);
  const nodeBody = await nodeRes.json();
  assert.equal(nodeBody.node.id, 'a1');
  assert.equal(nodeBody.outgoing.length, 1, 'cross-domain edge must be dropped here too');
  assert.equal(nodeBody.outgoing[0].target, 'a2');

  const exploreRes = await fetch(`${base}/explore?name=${encodeURIComponent('Alpha One')}&token=${share.token}`);
  assert.equal(exploreRes.status, 200);
  const exploreBody = await exploreRes.json();
  assert.match(exploreBody.text, /Alpha Two/);
  assert.ok(!exploreBody.text.includes('Beta One'));

  const traverseRes = await fetch(`${base}/traverse?from=${encodeURIComponent('Alpha One')}&depth=2&token=${share.token}`);
  assert.equal(traverseRes.status, 200);
  const traverseBody = await traverseRes.json();
  assert.equal(traverseBody.nodes_discovered, 2);
  assert.ok(!traverseBody.text.includes('Beta One'));
});

test('HTTP API auth: missing token -> 401, revoked -> 410', async () => {
  const share = await createShare(['alpha'], { name: 'HTTP Auth Share' });
  const base = `${harness.baseUrl}/share/${share.id}/api`;

  const noToken = await fetch(`${base}/summary`);
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(`${base}/summary?token=not-the-real-token`);
  assert.equal(wrongToken.status, 401);

  const ok = await fetch(`${base}/summary?token=${share.token}`);
  assert.equal(ok.status, 200);

  await fetch(`${harness.baseUrl}/api/shares/${share.id}`, { method: 'DELETE', headers: authHeaders() });

  const afterRevoke = await fetch(`${base}/summary?token=${share.token}`);
  assert.equal(afterRevoke.status, 410);
});

test('HTTP API: /api/search 404s with an explanation when the share has no embeddings', async () => {
  const share = await createShare(['alpha'], { name: 'No Embeddings Share' });
  const base = `${harness.baseUrl}/share/${share.id}/api`;

  const res = await fetch(`${base}/search?q=test&token=${share.token}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /semantic search/i);
  assert.match(body.error, /not available/i);
});

test('landing markdown includes a working HTTP API section', async () => {
  const share = await createShare(['alpha'], { name: 'HTTP Landing Share' });

  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  const body = await res.text();

  // The markdown builds URLs from config.publicBaseUrl (a public-facing address
  // that in production differs from wherever the server actually binds — same
  // as the real deployment), so assert on the path shape only, not a specific host.
  assert.match(body, /## HTTP API/);
  const apiPath = `/share/${share.id}/api`;
  assert.ok(body.includes(`${apiPath}/summary`));
  assert.ok(body.includes(`${apiPath}/explore`));
  assert.ok(body.includes(`${apiPath}/traverse`));

  // Pull the example summary URL's path+query out of the markdown and replay it
  // against the actual test server, to confirm the documented URL really works.
  const match = body.match(new RegExp(`(${apiPath}/summary\\?token=\\S+)`));
  assert.ok(match, 'markdown should contain a ready-to-use summary URL');
  const exampleRes = await fetch(`${harness.baseUrl}${match![1]}`);
  assert.equal(exampleRes.status, 200);
  const summary = await exampleRes.json();
  assert.equal(summary.node_count, 2);
});

test('layout.json is written at creation and recomputed at refresh', async () => {
  await seedGraph(
    [
      { id: 'lay1', type: 'concept', domain: 'layout-domain', name: 'Layout One' },
      { id: 'lay2', type: 'concept', domain: 'layout-domain', name: 'Layout Two' },
    ],
    [{ source: 'lay1', target: 'lay2', relation: 'depends_on', fact_id: 'fact-lay1-lay2' }],
  );

  const share = await createShare(['layout-domain'], { name: 'Layout Share' });
  const layoutPath = `${shareDir(share.id)}/layout.json`;
  assert.ok(fs.existsSync(layoutPath), 'layout.json should exist right after creation');

  const firstLayout = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  assert.ok(firstLayout.lay1 && typeof firstLayout.lay1.x === 'number' && typeof firstLayout.lay1.y === 'number');
  assert.ok(firstLayout.lay2);
  assert.ok(!firstLayout.lay3, 'a node added after export should not be in the pre-refresh layout');

  // Add a node, then refresh — the recomputed layout must include it, proving
  // /refresh actually reran the layout rather than reusing the old file.
  await seedGraph(
    [{ id: 'lay3', type: 'concept', domain: 'layout-domain', name: 'Layout Three' }],
    [{ source: 'lay2', target: 'lay3', relation: 'depends_on', fact_id: 'fact-lay2-lay3' }],
  );
  const refreshRes = await fetch(`${harness.baseUrl}/api/shares/${share.id}/refresh`, {
    method: 'POST',
    headers: authHeaders(),
  });
  assert.equal(refreshRes.status, 200);

  const secondLayout = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  assert.ok(secondLayout.lay3, 'refreshed layout should include the newly added node');
  assert.ok(secondLayout.lay1 && secondLayout.lay2);
});

test('/api/summary carries central_entities and decisions with their rejected alternatives', async () => {
  await seedGraph(
    [
      { id: 'dec1', type: 'decision', domain: 'decision-domain', name: 'Use Kuzu for storage', description: 'chose an embedded graph db' },
      { id: 'rej1', type: 'rejected_alternative', domain: 'decision-domain', name: 'Neo4j', description: 'too heavy to embed' },
      { id: 'rej2', type: 'rejected_alternative', domain: 'decision-domain', name: 'Plain SQLite tables', description: 'no graph queries' },
      { id: 'concept1', type: 'concept', domain: 'decision-domain', name: 'Embedded graph database' },
    ],
    [
      { source: 'dec1', target: 'rej1', relation: 'rejects', fact_id: 'fact-dec1-rej1' },
      { source: 'dec1', target: 'rej2', relation: 'rejects', fact_id: 'fact-dec1-rej2' },
      { source: 'dec1', target: 'concept1', relation: 'about', fact_id: 'fact-dec1-concept1' },
    ],
  );

  const share = await createShare(['decision-domain'], { name: 'Decision Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}/api/summary?token=${share.token}`);
  assert.equal(res.status, 200);
  const summary = await res.json();

  assert.ok(Array.isArray(summary.central_entities) && summary.central_entities.length > 0);
  assert.ok(summary.central_entities.some((e: { id: string }) => e.id === 'dec1'), 'the well-connected decision node should be a central entity');
  assert.ok(summary.central_entities[0].degree >= summary.central_entities[summary.central_entities.length - 1].degree, 'central entities should be sorted by degree descending');

  assert.ok(Array.isArray(summary.decisions) && summary.decisions.length === 1);
  const decision = summary.decisions[0];
  assert.equal(decision.id, 'dec1');
  assert.equal(decision.name, 'Use Kuzu for storage');
  assert.equal(decision.rejected.length, 2);
  const rejectedNames = decision.rejected.map((r: { name: string }) => r.name).sort();
  assert.deepEqual(rejectedNames, ['Neo4j', 'Plain SQLite tables']);
});

test('receipt HTML: small share shows dates, copy button, and the SVG graph', async () => {
  await seedGraph(
    [
      { id: 'small1', type: 'concept', domain: 'small-domain', name: 'Small One' },
      { id: 'small2', type: 'concept', domain: 'small-domain', name: 'Small Two' },
    ],
    [{ source: 'small1', target: 'small2', relation: 'depends_on', fact_id: 'fact-small1-small2' }],
  );

  const share = await createShare(['small-domain'], { name: 'Small Receipt Share', ttl_days: 7 });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'text/html' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);

  const html = await res.text();
  assert.ok(html.includes('id="copyAgent"'), 'copyAgent button should be present');
  assert.ok(html.includes('snapshot taken'), 'receipt should show the snapshot date');
  assert.ok(html.includes('link is live until') || html.includes('does not expire'), 'receipt should show expiry status');
  assert.ok(html.includes('id="graph"'), 'a small share should render the graph stage');
  assert.ok(!html.includes('class="no-graph"'), 'a small share should not be in no-graph fallback mode');
  const data = extractData(html);
  assert.ok(data.positions, 'positions should be embedded for the SVG to draw from');
  assert.equal(data.nodes.length, 2);
});

test('receipt HTML: production-shaped data (sentence-length names, disconnected components) truncates every visible surface', async () => {
  // Regression fixture for a real deployed bug: Enox node names are frequently
  // whole sentences (80-150 chars, hard-truncated mid-word by the extraction
  // pipeline), and small personal-graph domains are often several components
  // with zero shared connectivity. Both distributions broke the first version
  // of this page (label overlap, viewBox not fitting label extents, explorer
  // panel header overflowing) even though it passed on short synthetic names.
  const longName1 = 'RFDB storage_v2 compaction ALREADY produces sorted runs: merge_node_segments sorts L1 by node_id (compaction/merge.rs:41), verified against the real snapshot';
  const longName2 = 'Datalog v2 does not enumerate or pre-allocate predicates as column families, the DB stays a graph with base predicates as views';
  const longName3 = 'The bottom-up semi-naive Datalog v2 engine reached Gate A exit on the real graph differential, not fixture tests, which is what actually proved it';

  await seedGraph(
    [
      { id: 'prod1', type: 'concept', domain: 'prod-shaped', name: 'RFDB Datalog v2 StorageView sorted-runs' },
      { id: 'prod2', type: 'decision', domain: 'prod-shaped', name: longName1, description: longName1 },
      { id: 'prod3', type: 'concept', domain: 'prod-shaped', name: 'RFDB Datalog v2 predicate storage is graph-native' },
      { id: 'prod4', type: 'belief', domain: 'prod-shaped', name: longName2, description: longName2 },
      { id: 'prod5', type: 'concept', domain: 'prod-shaped', name: 'RFDB Datalog v2 Gate A complete' },
      { id: 'prod6', type: 'rejected_alternative', domain: 'prod-shaped', name: longName3, description: longName3 },
    ],
    // Two fully disconnected components (prod1-prod2, prod3-prod4) and one
    // isolated singleton (prod5, prod6 unconnected to anything) — matching
    // the real rfdb share's "N separate pairs" topology.
    [
      { source: 'prod1', target: 'prod2', relation: 'about', fact_id: 'fact-prod1-prod2' },
      { source: 'prod3', target: 'prod4', relation: 'about', fact_id: 'fact-prod3-prod4' },
    ],
  );

  const share = await createShare(['prod-shaped'], { name: 'Production-Shaped Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'text/html' },
  });
  const html = await res.text();

  // The design has no chip UI — node names only ever appear (a) inside the
  // embedded DATA blob, truncated client-side at render time, or (b) never in
  // the static HTML shell (h1/desc/receipt only ever show share-level fields,
  // never individual node names). So the real regression to guard is: no long
  // node name leaks into the static shell outside the DATA script, and the
  // full names are still present in DATA for the client to truncate from.
  const shell = html.replace(/const DATA = [\s\S]*?<\/script>/, '');
  assert.ok(!shell.includes(longName1), 'a long node name must never appear in the static HTML shell outside the data blob');
  assert.ok(!shell.includes(longName3), 'a long node name must never appear in the static HTML shell outside the data blob');

  const data = extractData(html);
  assert.equal(data.nodes.length, 6);
  assert.ok(data.positions, 'a 6-node share is well within the SVG threshold');
  assert.ok(Object.keys(data.positions!).length === 6, 'every node must have a packed position');
  assert.ok(data.nodes.some(n => n.name === longName1), 'full untruncated name is preserved in DATA for client-side truncation');
  assert.ok(data.nodes.some(n => n.name === longName3), 'full untruncated name is preserved in DATA for client-side truncation');
});

test('receipt HTML: a node name containing "</script>" cannot break out of the embedded DATA blob', async () => {
  const evilName = 'RFDB note </script><script>window.__pwned = true;</script> compaction detail';
  await seedGraph(
    [
      { id: 'evil1', type: 'concept', domain: 'xss-domain', name: evilName },
      { id: 'evil2', type: 'concept', domain: 'xss-domain', name: 'Companion Node' },
    ],
    [{ source: 'evil1', target: 'evil2', relation: 'depends_on', fact_id: 'fact-evil1-evil2' }],
  );

  const share = await createShare(['xss-domain'], { name: 'XSS Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'text/html' },
  });
  const html = await res.text();

  // The literal, case-sensitive "</script" substring must never appear inside
  // the embedded DATA blob — every "<" in user content must have been escaped
  // to "<" (per this session's escaping rule), which breaks that substring.
  const match = html.match(/const DATA = ([\s\S]*?);\s*\nconst TYPE_RAW/);
  assert.ok(match, 'DATA blob should be present');
  assert.ok(!match![1].includes('</script'), 'the raw DATA blob text must never contain a literal "</script" substring');
  assert.ok(match![1].includes('\\u003c/script>'), 'the escaped form ("<" -> "\\u003c", ">" untouched) should be present instead, proving the escape actually ran');

  // And the page must still parse/round-trip correctly despite the hostile name.
  const data = extractData(html);
  assert.ok(data.nodes.some(n => n.name === evilName), 'the full (unmangled) name is recovered once the client JSON.parses it');
});

test('public share surfaces link the public repo and never mention private internals', async () => {
  await seedGraph(
    [{ id: 'pub1', type: 'concept', domain: 'pub-domain', name: 'Public One' }],
    [],
  );

  const share = await createShare(['pub-domain'], { name: 'Public Surface Share' });
  const htmlRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'text/html' },
  });
  const html = await htmlRes.text();
  const mdRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  const md = await mdRes.text();

  for (const [label, body] of [['HTML', html], ['markdown', md]] as const) {
    assert.ok(body.includes('github.com/Disentinel/enox'), `${label} should link the public Enox repo`);
    assert.ok(!body.includes('grafema-cloud'), `${label} must not mention the private repo`);
  }
});

test('receipt HTML: a share over the SVG node threshold falls back to search instead of drawing a graph', async () => {
  const bigNodes = [];
  const bigEdges = [];
  for (let i = 0; i < 420; i++) {
    bigNodes.push({ id: `big${i}`, type: 'concept', domain: 'big-domain', name: `Big Node ${i}` });
    if (i > 0) bigEdges.push({ source: `big${i - 1}`, target: `big${i}`, relation: 'depends_on', fact_id: `fact-big-${i}` });
  }
  await seedGraph(bigNodes, bigEdges);

  const share = await createShare(['big-domain'], { name: 'Big Share' });
  assert.equal(share.node_count, 420);

  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'text/html' },
  });
  const html = await res.text();
  assert.ok(html.includes('class="no-graph"'), 'a share past the SVG threshold should render in no-graph fallback mode');

  const data = extractData(html);
  assert.equal(data.positions, undefined, 'positions must be omitted entirely — nothing to draw a graph from');
  assert.equal(data.nodes.length, 0, 'the full node list must not be embedded for an oversized share');
  assert.equal(data.edges.length, 0);

  // The search input and graph element are still present in the markup (the
  // design's own layout, just styled into a static stacked flow by .no-graph)
  // — search/detail lookups switch to the live HTTP API instead of a local
  // DATA scan, which the earlier HTTP-API tests already exercise directly.
  assert.ok(html.includes('id="search"'), 'the search box should still be present');
  assert.ok(html.includes('id="graph"'), 'the graph element stays in the DOM (hidden via CSS), not removed');
});

test('share snapshot + HTTP API surface source_ref (node) and asserted_by (edge)', async () => {
  await seedGraph(
    [
      { id: 'prov-paper', type: 'paper', domain: 'prov-domain', name: 'Provenance Paper', source_ref: 'https://arxiv.org/abs/2222.22222' },
      { id: 'prov-concept', type: 'concept', domain: 'prov-domain', name: 'Provenance Concept' },
    ],
    [{ source: 'prov-concept', target: 'prov-paper', relation: 'references', fact_id: 'fact-prov-concept-paper', asserted_by: 'alice' }],
  );

  const share = await createShare(['prov-domain'], { name: 'Provenance Share' });

  // Snapshot store itself (what every share read tool ultimately queries).
  const store = loadSnapshotStore(share.id, 'Provenance Share');
  assert.ok(store, 'snapshot store should load from disk');
  const paperNode = await store!.getNode('prov-paper');
  assert.equal(paperNode?.source_ref, 'https://arxiv.org/abs/2222.22222', 'snapshot node must carry source_ref');
  const outgoing = await store!.outgoing('prov-concept');
  assert.equal(outgoing[0].asserted_by, 'alice', 'snapshot edge must carry asserted_by');

  // Plain-HTTP share API.
  const base = `${harness.baseUrl}/share/${share.id}/api`;
  const nodeRes = await fetch(`${base}/nodes/${encodeURIComponent('prov-paper')}?token=${share.token}`);
  assert.equal(nodeRes.status, 200);
  const nodeBody = await nodeRes.json() as { node: { source_ref?: string }; incoming: Array<{ source: string; asserted_by?: string }> };
  assert.equal(nodeBody.node.source_ref, 'https://arxiv.org/abs/2222.22222', '/share/:id/api/nodes/:id must surface node source_ref');
  const incomingEdge = nodeBody.incoming.find(e => e.source === 'prov-concept');
  assert.equal(incomingEdge?.asserted_by, 'alice', '/share/:id/api/nodes/:id must surface edge asserted_by');

  const summaryRes = await fetch(`${base}/summary?token=${share.token}`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json() as { central_entities: Array<{ id: string; source_ref?: string }> };
  const centralPaper = summary.central_entities.find(e => e.id === 'prov-paper');
  assert.ok(centralPaper, 'the connected paper node should be a central entity');
  assert.equal(centralPaper!.source_ref, 'https://arxiv.org/abs/2222.22222', '/share/:id/api/summary central_entities must surface source_ref');
});

test('receipt HTML embeds source_ref/asserted_by in DATA and the explorer script renders a Source link + "by" attribution', async () => {
  await seedGraph(
    [
      { id: 'land-paper', type: 'paper', domain: 'land-prov-domain', name: 'Landing Provenance Paper', source_ref: 'https://arxiv.org/abs/3333.33333' },
      { id: 'land-concept', type: 'concept', domain: 'land-prov-domain', name: 'Landing Provenance Concept' },
    ],
    [{ source: 'land-concept', target: 'land-paper', relation: 'references', fact_id: 'fact-land-prov', asserted_by: 'alice' }],
  );

  const share = await createShare(['land-prov-domain'], { name: 'Landing Provenance Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  const html = await res.text();

  const data = extractData(html);
  const paperNode = data.nodes.find(n => n.id === 'land-paper');
  assert.equal(paperNode?.source_ref, 'https://arxiv.org/abs/3333.33333', 'DATA.nodes must carry source_ref for the paper');
  const edge = data.edges.find(e => e.source === 'land-concept' && e.target === 'land-paper');
  assert.equal(edge?.asserted_by, 'alice', 'DATA.edges must carry asserted_by');

  // The embedded client script must contain the actual rendering logic for
  // both surfaces (source_ref -> "Source ↗" link, asserted_by -> "by ..." on
  // the relation row) — not just data that a future script might use.
  assert.ok(html.includes('Source ↗'), 'client script should render a "Source ↗" link label for URL-like source_ref');
  assert.ok(html.includes('isUrlLike'), 'client script should include the URL-detection helper deciding link vs plain text');
  assert.ok(html.includes('rby'), 'client script should include the asserted_by "by ..." styling class on relation rows');
});

test('receipt HTML: source_ref/asserted_by containing "</script>" cannot break out of the embedded DATA blob', async () => {
  const evilRef = 'https://example.com/</script><script>window.__pwned2 = true;</script>';
  const evilBy = 'agent:</script><script>window.__pwned3 = true;</script>';
  await seedGraph(
    [
      { id: 'xss-paper', type: 'paper', domain: 'xss-prov-domain', name: 'XSS Provenance Paper', source_ref: evilRef },
      { id: 'xss-concept', type: 'concept', domain: 'xss-prov-domain', name: 'XSS Provenance Concept' },
    ],
    [{ source: 'xss-concept', target: 'xss-paper', relation: 'references', fact_id: 'fact-xss-prov', asserted_by: evilBy }],
  );

  const share = await createShare(['xss-prov-domain'], { name: 'XSS Provenance Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  const html = await res.text();

  const match = html.match(/const DATA = ([\s\S]*?);\s*\nconst TYPE_RAW/);
  assert.ok(match, 'DATA blob should be present');
  assert.ok(!match![1].includes('</script'), 'the raw DATA blob must never contain a literal "</script" substring, even inside source_ref/asserted_by');

  const data = extractData(html);
  assert.ok(data.nodes.some(n => n.source_ref === evilRef), 'the full (unmangled) source_ref is recovered once the client JSON.parses it');
  assert.ok(data.edges.some(e => e.asserted_by === evilBy), 'the full (unmangled) asserted_by is recovered once the client JSON.parses it');
});

test('share root: Accept: application/json returns a full machine manifest; text/html and */* are unaffected', async () => {
  await seedGraph(
    [
      { id: 'man1', type: 'concept', domain: 'manifest-domain', name: 'Manifest One' },
      { id: 'man2', type: 'concept', domain: 'manifest-domain', name: 'Manifest Two' },
    ],
    [{ source: 'man1', target: 'man2', relation: 'depends_on', fact_id: 'fact-man1-man2' }],
  );
  const share = await createShare(['manifest-domain'], { name: 'Manifest Share' });

  const jsonRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, {
    headers: { Accept: 'application/json' },
  });
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await jsonRes.json();

  assert.equal(manifest.protocol, 'enox-share');
  assert.equal(manifest.schema_version, 1);
  assert.match(manifest.snapshot.id, /^[0-9a-f]{64}$/, 'snapshot.id should be a sha256 hex digest');
  assert.equal(manifest.slice.uri, `enox://example.org/share/${share.id}`);
  assert.equal(manifest.slice.scope.node_count, 2);
  assert.equal(manifest.slice.scope.edge_count, 1);
  assert.deepEqual(manifest.slice.scope.domains, ['manifest-domain']);
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'summary'));
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'mcp'));
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'manifest'));
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'human'));
  assert.ok(!manifest.endpoints.some((e: { rel: string }) => e.rel === 'search'), 'search endpoint must be absent without embeddings');
  assert.deepEqual([...manifest.capabilities].sort(), ['mcp', 'read', 'traverse']);
  assert.equal(manifest.auth.type, 'token');
  assert.equal(manifest.auth.query_param, 'token');
  assert.equal(manifest.limits.default_page_size, 20);
  assert.equal(manifest.limits.max_traverse_depth, 3);
  assert.equal(manifest.expiry.revocable, true);
  assert.deepEqual(Object.keys(manifest.errors).sort(), ['401', '404', '410']);

  const htmlRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/, 'text/html must still get the human receipt');

  const defaultRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: '*/*' } });
  assert.match(defaultRes.headers.get('content-type') ?? '', /text\/markdown/, '*/* must still fall back to markdown, not the manifest');
});

test('GET /share/:id/api and the /manifest.json alias return the identical manifest as Accept: application/json on the root', async () => {
  await seedGraph(
    [{ id: 'apiman1', type: 'concept', domain: 'api-manifest-domain', name: 'Api Manifest One' }],
    [],
  );
  const share = await createShare(['api-manifest-domain'], { name: 'API Manifest Share' });

  const rootRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'application/json' } });
  const rootManifest = await rootRes.json();

  const apiRes = await fetch(`${harness.baseUrl}/share/${share.id}/api?token=${share.token}`);
  assert.equal(apiRes.status, 200);
  const apiManifest = await apiRes.json();
  assert.deepEqual(apiManifest, rootManifest, '/api must upgrade to the exact same full manifest as content negotiation on the root');

  const aliasRes = await fetch(`${harness.baseUrl}/share/${share.id}/manifest.json?token=${share.token}`);
  assert.equal(aliasRes.status, 200);
  const aliasManifest = await aliasRes.json();
  assert.deepEqual(aliasManifest, rootManifest, '/manifest.json alias must return the identical manifest');
});

test('unknown share subpaths 404 with a JSON hint, never falling through to the SPA HTML catch-all', async () => {
  await seedGraph([{ id: 'nf1', type: 'concept', domain: '404-domain', name: 'NotFound One' }], []);
  const share = await createShare(['404-domain'], { name: '404 Test Share' });

  // A subpath that looks plausible to an agent guessing (no /api prefix) —
  // this is the exact case that used to silently 200 as HTML.
  const res = await fetch(`${harness.baseUrl}/share/${share.id}/summary?token=${share.token}`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json();
  assert.match(body.error, /unknown/i);
  assert.match(body.hint, /manifest|Accept/i);

  // A nested unknown path under /api falls off the api router's own routes
  // and must land on the same JSON 404, not an Express default HTML error page.
  const nestedRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/doesnotexist?token=${share.token}`);
  assert.equal(nestedRes.status, 404);
  assert.match(nestedRes.headers.get('content-type') ?? '', /application\/json/);
});

test('snapshot.id in the manifest is stable across requests and changes after a data-changing refresh', async () => {
  await seedGraph([{ id: 'snap1', type: 'concept', domain: 'snapshot-id-domain', name: 'Snapshot One' }], []);
  const share = await createShare(['snapshot-id-domain'], { name: 'Snapshot Id Share' });

  const first = await (await fetch(`${harness.baseUrl}/share/${share.id}/api?token=${share.token}`)).json();
  const second = await (await fetch(`${harness.baseUrl}/share/${share.id}/api?token=${share.token}`)).json();
  assert.equal(first.snapshot.id, second.snapshot.id, 'snapshot.id must be stable across requests when nothing changed');

  // Add a node and an edge, then refresh — the exported content actually
  // changed, so the content-addressed id must change too.
  await seedGraph(
    [{ id: 'snap2', type: 'concept', domain: 'snapshot-id-domain', name: 'Snapshot Two' }],
    [{ source: 'snap1', target: 'snap2', relation: 'depends_on', fact_id: 'fact-snap1-snap2' }],
  );
  const refreshRes = await fetch(`${harness.baseUrl}/api/shares/${share.id}/refresh`, { method: 'POST', headers: authHeaders() });
  assert.equal(refreshRes.status, 200);

  const third = await (await fetch(`${harness.baseUrl}/share/${share.id}/api?token=${share.token}`)).json();
  assert.notEqual(third.snapshot.id, first.snapshot.id, 'snapshot.id must change after a refresh that changed the exported data');
});

test('manifest paths 410 once a share is revoked, including an unknown subpath', async () => {
  const share = await createShare(['snapshot-id-domain'], { name: 'Manifest Revoke Share' });

  await fetch(`${harness.baseUrl}/api/shares/${share.id}`, { method: 'DELETE', headers: authHeaders() });

  const apiRes = await fetch(`${harness.baseUrl}/share/${share.id}/api?token=${share.token}`);
  assert.equal(apiRes.status, 410);

  const jsonRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'application/json' } });
  assert.equal(jsonRes.status, 410);

  const aliasRes = await fetch(`${harness.baseUrl}/share/${share.id}/manifest.json?token=${share.token}`);
  assert.equal(aliasRes.status, 410);

  const unknownRes = await fetch(`${harness.baseUrl}/share/${share.id}/summary?token=${share.token}`);
  assert.equal(unknownRes.status, 410, 'auth must run before the not-found check, so a revoked share reports 410 even off an unknown subpath');
});

test('share root carries a Link: rel="describedby" header pointing at the manifest, on all three representations', async () => {
  await seedGraph([{ id: 'link1', type: 'concept', domain: 'link-domain', name: 'Link One' }], []);
  const share = await createShare(['link-domain'], { name: 'Link Header Share' });
  const expectedTarget = `/share/${share.id}/manifest.json?token=${share.token}`;

  for (const accept of ['application/json', 'text/html', '*/*']) {
    const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: accept } });
    assert.equal(res.status, 200);
    const link = res.headers.get('link');
    assert.ok(link, `Accept: ${accept} response must carry a Link header`);
    assert.ok(link!.includes(expectedTarget), `Link header must point at the manifest URL (got: ${link})`);
    assert.match(link!, /rel="describedby"/);
    assert.match(link!, /type="application\/json"/);
  }
});

test('GET /share/:id/manifest (no .json) is an alias for the full manifest', async () => {
  await seedGraph([{ id: 'noext1', type: 'concept', domain: 'noext-domain', name: 'No Extension One' }], []);
  const share = await createShare(['noext-domain'], { name: 'No Extension Share' });

  const res = await fetch(`${harness.baseUrl}/share/${share.id}/manifest?token=${share.token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await res.json();
  assert.equal(manifest.protocol, 'enox-share');

  const jsonExtRes = await fetch(`${harness.baseUrl}/share/${share.id}/manifest.json?token=${share.token}`);
  assert.deepEqual(await jsonExtRes.json(), manifest, '/manifest and /manifest.json must return the identical object');
});

test('?format= query param overrides Accept on the share root', async () => {
  await seedGraph([{ id: 'fmt1', type: 'concept', domain: 'format-domain', name: 'Format One' }], []);
  const share = await createShare(['format-domain'], { name: 'Format Query Share' });
  const base = `${harness.baseUrl}/share/${share.id}?token=${share.token}`;

  // format=json wins even when Accept explicitly asks for HTML.
  const jsonRes = await fetch(`${base}&format=json`, { headers: { Accept: 'text/html' } });
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get('content-type') ?? '', /application\/json/);
  const manifest = await jsonRes.json();
  assert.equal(manifest.protocol, 'enox-share');

  // format=html wins even when Accept asks for JSON.
  const htmlRes = await fetch(`${base}&format=html`, { headers: { Accept: 'application/json' } });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/);

  // format=md (pre-existing convention) still forces markdown over any Accept.
  const mdRes = await fetch(`${base}&format=md`, { headers: { Accept: 'application/json' } });
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get('content-type') ?? '', /text\/markdown/);
});

test('HTML receipt <head> carries a describedby <link>, and the markdown doc states the manifest URL', async () => {
  await seedGraph([{ id: 'head1', type: 'concept', domain: 'head-domain', name: 'Head One' }], []);
  const share = await createShare(['head-domain'], { name: 'Head Link Share' });
  const expectedTarget = `/share/${share.id}/manifest.json?token=${share.token}`;

  const htmlRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  const html = await htmlRes.text();
  assert.match(html, /<head>\s*<link rel="describedby"/, 'the describedby <link> must be the first thing inside <head>');
  assert.ok(html.includes(expectedTarget), 'the <link> href must point at the manifest URL');

  const mdRes = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  const md = await mdRes.text();
  assert.match(md, /^Machine manifest: /, 'the markdown doc must open with a "Machine manifest:" line');
  assert.ok(md.includes(expectedTarget), 'the markdown manifest line must point at the manifest URL');
});

test('landing markdown advertises semantic_search when the snapshot carries embeddings', async () => {
  // Simulate the embedding worker having already embedded a1/a2 by writing the
  // main embeddings.json file directly, then loading it before export — this
  // exercises the actual embeddings-subset-copy path (getEmbeddingsSubset),
  // not a mock. Run this LAST: it mutates the process-global embeddings store
  // in src/embeddings.ts, which would otherwise leak into every share created
  // by tests that run after it in this file.
  const embeddingsPath = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'embeddings.json');
  const fakeVec = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  fs.writeFileSync(embeddingsPath, JSON.stringify({ a1: fakeVec, a2: fakeVec }));
  const { loadEmbeddings } = await import('../embeddings.js');
  loadEmbeddings();

  const share = await createShare(['alpha'], { name: 'Embedded Share' });
  assert.ok(share.node_count === 2);

  const store = loadSnapshotStore(share.id, 'Embedded Share');
  assert.ok(store?.supportsSemanticSearch, 'snapshot should carry copied embeddings');

  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`);
  const body = await res.text();
  assert.ok(body.includes('semantic_search'), 'semantic_search should be advertised once embeddings exist');

  const searchRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/search?q=alpha&token=${share.token}`);
  assert.equal(searchRes.status, 200, 'HTTP /api/search should now work since embeddings exist');
});

test('share artifacts: in-scope artifact body is copied into the share and served byte-for-byte with the right content-type', async () => {
  const body = '# Skill note\n\nThis is the artifact body that must round-trip.';
  const artifact = await createArtifact({
    title: 'Skill Note', domain: 'artifact-domain', content_type: 'text/markdown', body,
  });

  // A cross-domain artifact must never leak into a same-owner share of a
  // different domain — mirrors the cross-domain edge exclusion test above.
  await createArtifact({
    title: 'Other Domain Note', domain: 'other-artifact-domain', content_type: 'text/markdown', body: 'should not leak',
  });

  const share = await createShare(['artifact-domain'], { name: 'Artifact Share' });
  assert.equal(share.artifact_count, 1, 'share creation response should report the copied artifact count');

  const listRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts?token=${share.token}`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json() as Array<{ id: string; entity_id: string; title: string; content_type: string; size: number; sha256: string }>;
  assert.equal(list.length, 1, 'only the in-scope artifact should be listed');
  const meta = list[0];
  assert.equal(meta.id, artifact.id);
  assert.equal(meta.entity_id, artifact.entity_id);
  assert.equal(meta.title, 'Skill Note');
  assert.equal(meta.content_type, 'text/markdown');
  assert.equal(meta.sha256, artifact.sha256);
  assert.equal(meta.size, artifact.size);
  assert.ok(!list.some(a => a.title === 'Other Domain Note'), 'cross-domain artifact must not appear in this share');

  const rawRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts/${artifact.id}/raw?token=${share.token}`);
  assert.equal(rawRes.status, 200);
  assert.match(rawRes.headers.get('content-type') ?? '', /text\/markdown/);
  const rawBody = await rawRes.text();
  assert.equal(rawBody, body, 'artifact body must round-trip byte-for-byte through the share');
});

test('share artifacts: a share of a domain with no artifacts lists none, and an unknown artifact id 404s', async () => {
  const share = await createShare(['alpha'], { name: 'No Artifacts Share' });
  assert.equal(share.artifact_count, 0);

  const listRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts?token=${share.token}`);
  assert.equal(listRes.status, 200);
  assert.deepEqual(await listRes.json(), []);

  const rawRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts/does-not-exist/raw?token=${share.token}`);
  assert.equal(rawRes.status, 404);
});

test('share artifacts: /refresh transfers an updated artifact body', async () => {
  const artifact = await createArtifact({
    title: 'Refreshable Note', domain: 'artifact-refresh-domain', content_type: 'text/markdown', body: 'version one',
  });
  const share = await createShare(['artifact-refresh-domain'], { name: 'Artifact Refresh Share' });

  const firstRaw = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts/${artifact.id}/raw?token=${share.token}`);
  assert.equal(await firstRaw.text(), 'version one');

  const putRes = await fetch(`${harness.baseUrl}/api/artifacts/${artifact.id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ body: 'version two', content_type: 'text/markdown' }),
  });
  assert.equal(putRes.status, 200, await putRes.text());

  const refreshRes = await fetch(`${harness.baseUrl}/api/shares/${share.id}/refresh`, { method: 'POST', headers: authHeaders() });
  assert.equal(refreshRes.status, 200);
  const refreshBody = await refreshRes.json() as { artifact_count: number };
  assert.equal(refreshBody.artifact_count, 1);

  const secondRaw = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts/${artifact.id}/raw?token=${share.token}`);
  assert.equal(await secondRaw.text(), 'version two', 'refresh must transfer the updated blob into the share');
});

test('share artifacts: a revoked share 410s on both the artifacts list and raw endpoints', async () => {
  const artifact = await createArtifact({
    title: 'Revoked Note', domain: 'artifact-revoke-domain', content_type: 'text/markdown', body: 'about to be revoked',
  });
  const share = await createShare(['artifact-revoke-domain'], { name: 'Artifact Revoke Share' });

  await fetch(`${harness.baseUrl}/api/shares/${share.id}`, { method: 'DELETE', headers: authHeaders() });

  const listRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts?token=${share.token}`);
  assert.equal(listRes.status, 410);

  const rawRes = await fetch(`${harness.baseUrl}/share/${share.id}/api/artifacts/${artifact.id}/raw?token=${share.token}`);
  assert.equal(rawRes.status, 410);
});

test('manifest: advertises artifacts endpoints and capability only when the share carries artifacts', async () => {
  await createArtifact({
    title: 'Manifest Note', domain: 'artifact-manifest-domain', content_type: 'text/markdown', body: 'manifest body',
  });
  const withArtifacts = await createShare(['artifact-manifest-domain'], { name: 'Manifest Artifacts Share' });

  const manifestRes = await fetch(`${harness.baseUrl}/share/${withArtifacts.id}/api?token=${withArtifacts.token}`);
  const manifest = await manifestRes.json();
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'artifacts'));
  assert.ok(manifest.endpoints.some((e: { rel: string }) => e.rel === 'artifact-raw'));
  assert.ok(manifest.capabilities.includes('artifacts'));

  // A share with no artifacts in scope must not claim the capability or
  // advertise endpoints that would just 404/return an empty list.
  const withoutArtifacts = await createShare(['alpha'], { name: 'Manifest No Artifacts Share' });
  const manifest2Res = await fetch(`${harness.baseUrl}/share/${withoutArtifacts.id}/api?token=${withoutArtifacts.token}`);
  const manifest2 = await manifest2Res.json();
  assert.ok(!manifest2.endpoints.some((e: { rel: string }) => e.rel === 'artifacts'));
  assert.ok(!manifest2.capabilities.includes('artifacts'));
});

test("receipt HTML: DATA carries the share's artifacts (id/title/content_type/filename), empty when none", async () => {
  const artifact = await createArtifact({
    title: 'Receipt Skill', domain: 'artifact-receipt-domain', content_type: 'text/markdown',
    body: '# Hi\n\nBody.', filename: 'skills/receipt-skill.md',
  });
  const share = await createShare(['artifact-receipt-domain'], { name: 'Artifact Receipt Share' });

  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  const html = await res.text();
  const data = extractData(html);
  assert.equal(data.artifacts.length, 1);
  assert.equal(data.artifacts[0].id, artifact.id);
  assert.equal(data.artifacts[0].title, 'Receipt Skill');
  assert.equal(data.artifacts[0].content_type, 'text/markdown');
  assert.equal(data.artifacts[0].filename, 'skills/receipt-skill.md');

  const emptyShare = await createShare(['alpha'], { name: 'No Artifacts Receipt Share' });
  const emptyRes = await fetch(`${harness.baseUrl}/share/${emptyShare.id}?token=${emptyShare.token}`, { headers: { Accept: 'text/html' } });
  const emptyHtml = await emptyRes.text();
  assert.deepEqual(extractData(emptyHtml).artifacts, [], 'a share with no in-scope artifacts should carry an empty artifacts array, not omit the field');
});

test('receipt HTML: a Documents section and the inlined markdown renderer appear only when the share has artifacts', async () => {
  await createArtifact({
    title: 'Doc Section Skill', domain: 'artifact-docsection-domain', content_type: 'text/markdown', body: 'content',
  });
  const withDocs = await createShare(['artifact-docsection-domain'], { name: 'Doc Section Share' });
  const withDocsRes = await fetch(`${harness.baseUrl}/share/${withDocs.id}?token=${withDocs.token}`, { headers: { Accept: 'text/html' } });
  const withDocsHtml = await withDocsRes.text();
  assert.ok(withDocsHtml.includes('id="docsSection"'), 'Documents section should be present');
  assert.ok(withDocsHtml.includes('id="docTree"'), 'the document tree container should be present');
  assert.ok(withDocsHtml.includes('Documents (1)'), 'the section heading should count the artifacts');
  assert.ok(withDocsHtml.includes('renderArtifactBody'), 'the tested markdown renderer should be inlined into the client script');

  const noDocs = await createShare(['alpha'], { name: 'No Doc Section Share' });
  const noDocsRes = await fetch(`${harness.baseUrl}/share/${noDocs.id}?token=${noDocs.token}`, { headers: { Accept: 'text/html' } });
  const noDocsHtml = await noDocsRes.text();
  assert.ok(!noDocsHtml.includes('id="docsSection"'), 'a share with no artifacts must not render the Documents section at all');
  assert.ok(!noDocsHtml.includes('id="docTree"'));
});

test('receipt HTML: a selected document renders in the shared #exBody explorer panel, and the full-screen overlay only exists when the share has artifacts', async () => {
  await createArtifact({
    title: 'Overlay Skill', domain: 'artifact-overlay-domain', content_type: 'text/markdown', body: '# Overlay\n\nBody.',
  });
  const withDocs = await createShare(['artifact-overlay-domain'], { name: 'Overlay Share' });
  const withDocsHtml = await (await fetch(`${harness.baseUrl}/share/${withDocs.id}?token=${withDocs.token}`, { headers: { Accept: 'text/html' } })).text();

  // Master-detail: a document opens inside #exBody (the same panel node
  // inspection uses), not a standalone accordion box under the tree leaf —
  // the old accordion insertion point (leaf.insertAdjacentElement) is gone.
  assert.ok(withDocsHtml.includes('function selectDoc'), 'selectDoc should render documents into the explorer panel');
  assert.ok(withDocsHtml.includes('id="docBody"'), 'the doc detail should mount inside the explorer panel via #docBody');
  assert.ok(!withDocsHtml.includes('insertAdjacentElement'), 'the old in-tree accordion insertion should be gone');
  assert.ok(withDocsHtml.includes('id="docOverlay"'), 'the full-screen overlay should exist when the share has artifacts');
  assert.ok(withDocsHtml.includes('id="docFullscreen"'), 'a full-screen toggle should be wired up for the open document');

  const noDocs = await createShare(['alpha'], { name: 'No Overlay Share' });
  const noDocsHtml = await (await fetch(`${harness.baseUrl}/share/${noDocs.id}?token=${noDocs.token}`, { headers: { Accept: 'text/html' } })).text();
  assert.ok(!noDocsHtml.includes('id="docOverlay"'), 'a share with no artifacts must not render the full-screen overlay markup');
});

test('receipt HTML: an artifact title containing "</script>" cannot break out of the embedded DATA blob', async () => {
  const evilTitle = 'Skill </script><script>window.__pwned = true;</script> note';
  await createArtifact({
    title: evilTitle, domain: 'artifact-xss-domain', content_type: 'text/markdown', body: 'body',
  });
  const share = await createShare(['artifact-xss-domain'], { name: 'Artifact XSS Share' });
  const res = await fetch(`${harness.baseUrl}/share/${share.id}?token=${share.token}`, { headers: { Accept: 'text/html' } });
  const html = await res.text();

  const match = html.match(/const DATA = ([\s\S]*?);\s*\nconst TYPE_RAW/);
  assert.ok(match, 'DATA blob should be present');
  assert.ok(!match![1].includes('</script'), 'the raw DATA blob text must never contain a literal "</script" substring');
  assert.ok(match![1].includes('\\u003c/script>'), 'the escaped form ("<" -> "\\u003c") should be present instead, proving the escape actually ran');

  const data = extractData(html);
  assert.ok(data.artifacts.some(a => a.title === evilTitle), 'the full (unmangled) title is recovered once the client JSON.parses it');
});
