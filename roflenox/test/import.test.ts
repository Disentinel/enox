// Importing an Enox node's graph: repeatable, and every assertion keeps its author.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpCaller } from '../src/client.ts';
import { importEnox } from '../src/import.ts';
import { get, post, start, tmpDir } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'enox-snapshot.jsonl');

test('importing an Enox snapshot twice gives the same log head and every imported assertion answers by ask with its original author', async () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const dir = tmpDir('import-a');
  const a = await start(dir, 'importer');
  const twinDir = tmpDir('import-b');
  fs.cpSync(path.join(dir, 'key'), path.join(twinDir, 'key'), { recursive: true });
  const b = await start(twinDir, 'importer');
  try {
    const node = httpCaller(a.url, a.me, () => a.clock.t);
    const first = await importEnox(node, a.me, text, { batchSize: 5, now: () => a.clock.t });
    assert.deepEqual({ ...first }, { entities: 3, assertions: 4, facts: first.facts, collapsed: 2, batches: first.batches, admitted: first.batches, skipped: 0 });
    const h1 = (await get(a.url, '/health')).body;

    // Twice: nothing new, the log exactly as it was.
    a.clock.t += 60_000;
    const second = await importEnox(node, a.me, text, { batchSize: 5, now: () => a.clock.t });
    assert.equal(second.admitted, 0);
    assert.equal(second.skipped, first.batches);
    const h2 = (await get(a.url, '/health')).body;
    assert.equal(h2.log_head, h1.log_head);
    assert.deepEqual(h2.heads, h1.heads);
    // And on another node with the same key, the same batches digest for digest.
    await importEnox(httpCaller(b.url, b.me, () => b.clock.t), b.me, text, { batchSize: 5, now: () => b.clock.t + 5_000 });
    const chain = async (url: string) => ((await post(url, '/op/chain', { identity: 'importer' })).body.digests as string[]);
    assert.deepEqual(await chain(b.url), await chain(a.url));

    // Every assertion answers, as the importer's, with its original author(s).
    for (const r of text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x._type === 'edge')) {
      const rows = (await post(a.url, '/ask', { query: `edge(F, ${JSON.stringify(r.from)}, ${JSON.stringify(r.rel)}, ${JSON.stringify(r.to)})` })).body.rows as { identity: string; cells: string[] }[];
      assert.equal(rows.length, 1, `${r.from} ${r.rel} ${r.to}`);
      assert.equal(rows[0]!.identity, 'importer');
      const authors = ((await post(a.url, '/ask', { query: `edge(M, ${JSON.stringify(rows[0]!.cells[0])}, "enox:asserted_by", A)` })).body.rows as { cells: string[] }[])
        .map((x) => x.cells[1]);
      assert.ok(authors.includes(r.asserted_by), `${r.fact_id}: authors ${authors}`);
      const ids = ((await post(a.url, '/ask', { query: `edge(M, ${JSON.stringify(rows[0]!.cells[0])}, "enox:fact_id", I)` })).body.rows as { cells: string[] }[]).map((x) => x.cells[1]);
      assert.ok(ids.includes(r.fact_id));
    }
    // The fact asserted by two Enox authors keeps both, and its first confidence.
    const conf = (await post(a.url, '/ask', { query: 'conf(F, C)' })).body.rows as { cells: [string, number] }[];
    assert.ok(conf.some((c) => c.cells[1] === 700));
    // Entity attributes are facts too.
    const label = (await post(a.url, '/ask', { query: 'edge(F, "enox://example/entity/ada", "enox:alias", A)' })).body.rows as { cells: string[] }[];
    assert.deepEqual(label.map((x) => x.cells[1]).sort(), ['A. L.', 'Countess']);
  } finally { await a.stop(); await b.stop(); }
});

test('a node whose imported ids sit under another URI prefix says so at startup', async () => {
  const dir = tmpDir('prefix');
  const a = await start(dir, 'importer');
  const saved = process.env.NODE_URI_PREFIX;
  try {
    await importEnox(httpCaller(a.url, a.me, () => a.clock.t), a.me, fs.readFileSync(FIXTURE, 'utf8'), { now: () => a.clock.t });
  } finally { await a.stop(); }
  try {
    // Configured prefix (the neutral default) ≠ the imported ids' prefix: loud.
    delete process.env.NODE_URI_PREFIX;
    let n = await start(dir, 'importer');
    const w = (await get(n.url, '/health')).body.warnings as string[];
    assert.equal(w.length, 1);
    assert.match(w[0]!, /URI PREFIX MISMATCH: 3 of 3 entity ids .* not under the configured prefix enox:\/\/example\.org\/graph\/main \(e\.g\. enox:\/\/example\)/);
    await n.stop();
    // Configured to match: quiet.
    process.env.NODE_URI_PREFIX = 'enox://example';
    n = await start(dir, 'importer');
    assert.deepEqual((await get(n.url, '/health')).body.warnings, []);
    await n.stop();
  } finally {
    if (saved === undefined) delete process.env.NODE_URI_PREFIX; else process.env.NODE_URI_PREFIX = saved;
  }
});
