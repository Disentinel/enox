import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, seedGraph, type TestHarness } from '../test-support/harness.js';
import { queryOne } from '../db/kuzu.js';
import { blobPath } from './blob.js';
import { ENTITY_URI_PREFIX } from '../types.js';

let harness: TestHarness;

before(async () => {
  harness = await startTestServer();
});

after(async () => {
  await harness.stop();
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${harness.authToken}`, 'Content-Type': 'application/json', ...extra };
}

async function postArtifact(payload: Record<string, unknown>) {
  const res = await fetch(`${harness.baseUrl}/api/artifacts`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

test('POST markdown artifact with OKF Relations materializes internal edges with provenance', async () => {
  await seedGraph(
    [
      { id: `${ENTITY_URI_PREFIX}/okf-domain/target-one`, type: 'concept', domain: 'okf-domain', name: 'Target One' },
      { id: `${ENTITY_URI_PREFIX}/okf-domain/target-two`, type: 'concept', domain: 'okf-domain', name: 'Target Two' },
    ],
    [],
  );

  const markdown = [
    'This artifact documents a design decision.',
    '',
    '## Relations',
    '',
    '- depends_on [[target-one]] {confidence: 0.9, by: alice} — needed for context',
    '- references [[target-two]] {confidence: 1}',
  ].join('\n');

  const { status, body } = await postArtifact({
    title: 'OKF Design Note',
    domain: 'okf-domain',
    content_type: 'text/markdown',
    body: markdown,
    parse_okf: true,
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.edges_materialized, 2);
  assert.equal(body.links_created, 0);
  assert.ok(body.entity_id.includes('okf-domain'));

  // Blob landed on disk under data/artifacts/<id>.md
  const filePath = blobPath(body.id, 'text/markdown');
  assert.ok(fs.existsSync(filePath), 'blob should exist on disk');
  assert.equal(fs.readFileSync(filePath, 'utf-8'), markdown);

  // Artifact node exists in the graph as type 'artifact'
  const node = await queryOne<{ id: string; type: string; domain: string; name: string }>(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id, e.type AS type, e.domain AS domain, e.name AS name',
    { id: body.entity_id },
  );
  assert.ok(node, 'artifact entity node should exist');
  assert.equal(node!.type, 'artifact');
  assert.equal(node!.name, 'OKF Design Note');

  // Materialized edges carry this artifact's provenance
  const edges = await import('../db/kuzu.js').then(m => m.queryAll<{ relation: string; target: string; asserted_by: string; context: string }>(
    `MATCH (a:Entity)-[r:Assertion]->(b:Entity) WHERE a.id = $id
     RETURN r.relation AS relation, b.id AS target, r.asserted_by AS asserted_by, r.context AS context`,
    { id: body.entity_id },
  ));
  assert.equal(edges.length, 2);
  assert.ok(edges.every(e => e.asserted_by === `artifact:${body.id}:okf`), 'edges should carry this artifact\'s OKF provenance tag');
  const byRelation = Object.fromEntries(edges.map(e => [e.relation, e]));
  assert.equal(byRelation.depends_on.target, `${ENTITY_URI_PREFIX}/okf-domain/target-one`);
  assert.equal(byRelation.depends_on.context, 'needed for context');
  assert.equal(byRelation.references.target, `${ENTITY_URI_PREFIX}/okf-domain/target-two`);
});

test('POST csv artifact stores the blob and node but performs no auto-extraction, only explicit links', async () => {
  await seedGraph(
    [{ id: `${ENTITY_URI_PREFIX}/csv-domain/linked-entity`, type: 'concept', domain: 'csv-domain', name: 'Linked Entity' }],
    [],
  );

  const csv = 'name,value\nfoo,1\nbar,2\n';
  const { status, body } = await postArtifact({
    title: 'Some Data',
    domain: 'csv-domain',
    content_type: 'text/csv',
    body: csv,
    parse_okf: true, // should be ignored entirely for a non-markdown content type
    links: [{ entity_id: `${ENTITY_URI_PREFIX}/csv-domain/linked-entity`, relation: 'describes' }],
  });

  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.edges_materialized, 0, 'no auto-extraction for csv even with parse_okf: true');
  assert.equal(body.links_created, 1, 'the explicit link should still be created');

  const filePath = blobPath(body.id, 'text/csv');
  assert.ok(fs.existsSync(filePath));
  assert.equal(fs.readFileSync(filePath, 'utf-8'), csv);

  const node = await queryOne<{ type: string }>('MATCH (e:Entity) WHERE e.id = $id RETURN e.type AS type', { id: body.entity_id });
  assert.equal(node!.type, 'artifact');
});

test('GET /api/artifacts/:id/raw returns the exact bytes with the stored Content-Type', async () => {
  const markdown = '# Just a note\n\nNo relations here.\n';
  const { body } = await postArtifact({
    title: 'Raw Fetch Note',
    domain: 'raw-domain',
    content_type: 'text/markdown',
    body: markdown,
  });

  const res = await fetch(`${harness.baseUrl}/api/artifacts/${body.id}/raw`, {
    headers: { Authorization: `Bearer ${harness.authToken}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
  const text = await res.text();
  assert.equal(text, markdown, 'raw body must round-trip byte-for-byte');
});

test('creating an artifact does not touch an unrelated pre-existing small node', async () => {
  await seedGraph(
    [{ id: `${ENTITY_URI_PREFIX}/untouched-domain/small`, type: 'concept', domain: 'untouched-domain', name: 'Small Untouched Node', description: 'original description' }],
    [],
  );

  const before = await queryOne<{ name: string; description: string; updated_at: string }>(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.name AS name, e.description AS description, e.updated_at AS updated_at',
    { id: `${ENTITY_URI_PREFIX}/untouched-domain/small` },
  );

  await postArtifact({
    title: 'Unrelated Artifact',
    domain: 'untouched-domain',
    content_type: 'text/plain',
    body: 'just some text, no relation to the small node',
  });

  const after = await queryOne<{ name: string; description: string; updated_at: string }>(
    'MATCH (e:Entity) WHERE e.id = $id RETURN e.name AS name, e.description AS description, e.updated_at AS updated_at',
    { id: `${ENTITY_URI_PREFIX}/untouched-domain/small` },
  );
  assert.deepEqual(after, before, 'the pre-existing small node must be byte-for-byte unchanged');
});

test('DELETE removes the blob, the artifact node, and its edges — graph stays clean', async () => {
  await seedGraph(
    [{ id: `${ENTITY_URI_PREFIX}/del-domain/target`, type: 'concept', domain: 'del-domain', name: 'Delete Target' }],
    [],
  );

  const markdown = ['## Relations', '', '- describes [[target]] {confidence: 1}'].join('\n');
  const { body } = await postArtifact({
    title: 'To Be Deleted',
    domain: 'del-domain',
    content_type: 'text/markdown',
    body: markdown,
    parse_okf: true,
  });
  assert.equal(body.edges_materialized, 1);

  const filePath = blobPath(body.id, 'text/markdown');
  assert.ok(fs.existsSync(filePath));

  const delRes = await fetch(`${harness.baseUrl}/api/artifacts/${body.id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  assert.equal(delRes.status, 204);

  assert.ok(!fs.existsSync(filePath), 'blob file should be gone');

  const node = await queryOne('MATCH (e:Entity) WHERE e.id = $id RETURN e.id AS id', { id: body.entity_id });
  assert.equal(node, null, 'artifact node should be gone');

  const edges = await import('../db/kuzu.js').then(m => m.queryAll(
    'MATCH ()-[r:Assertion]->() WHERE r.asserted_by = $prov RETURN r.fact_id AS fact_id',
    { prov: `artifact:${body.id}:okf` },
  ));
  assert.equal(edges.length, 0, 'materialized edges should be gone too');

  const getRes = await fetch(`${harness.baseUrl}/api/artifacts/${body.id}`, { headers: authHeaders() });
  assert.equal(getRes.status, 404);
});
