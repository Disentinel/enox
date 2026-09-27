// The embedder's learned model (r_semantic_search). Runs a real node and the
// embedder with Xenova/multilingual-e5-small from the local model cache
// (`npm run fetch-model` once; ~130 MB; nothing is fetched afterwards). The
// core's suite never needs this: it runs the embedder with the hash model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnExecutor } from '../../../src/executor.ts';
import { publish } from '../../../src/client.ts';
import type { Fact } from '../../../src/facts.ts';
import { DAY, grant, identityAt, iso, post, start, tmpDir, type Clock } from '../../../test/helpers.ts';
import { DEFAULT_MODEL, MODEL_CACHE } from '../embed.ts';

const EMBEDDER = path.join(import.meta.dirname, '..', 'embedder.ts');
const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;
const E = (id: string) => `enox://example.org/graph/main/example/${id}`;
const f = (source: string, relation: string, target: string): Fact => ({ source, relation, target, perspective: 'enox', confidence: 1 });
const entity = (id: string, label: string, description: string) =>
  [f(E(id), 'enox:label', label), f(E(id), 'enox:description', description), f(E(id), 'enox:type', 'person'), f(E(id), 'enox:domain', 'example')];
const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

test("a meaning search finds a fact that shares none of the query's words", async () => {
  assert.ok(fs.existsSync(path.join(MODEL_CACHE, DEFAULT_MODEL)), `the model is not in ${MODEL_CACHE}: run \`npm run fetch-model\` in executors/embedder once`);
  const a = await start(tmpDir('meaning-a'), 'node-a', { clock: wall });
  try {
    await publish(a.url, a.me, [
      ...entity('jane', 'Jane Doe', 'handles divorces and child custody'),
      ...entity('court', 'Family court', 'hears separations of spouses'),
      ...entity('baker', 'Tom Baker', 'bakes sourdough bread every morning'),
      ...entity('engine', 'Difference Engine', 'a mechanical calculator of polynomial tables'),
      ...entity('tea', 'Earl Grey', 'black tea flavoured with bergamot oil'),
      f(E('jane'), 'represents_clients_at', E('court')),
      f(E('baker'), 'drinks', E('tea')),
      f(E('baker'), 'repairs', E('engine')),
    ]);
    const exDir = tmpDir('meaning-e');
    const ex = identityAt(exDir, 'embedder');
    assert.equal((await post(a.url, '/identities', ex.identityChain())).status, 200);
    await publish(a.url, a.me, [f('embedder', 'roflenox:embedder', 'search'), grant('embedder', iso(Date.now() + DAY))]);

    const token = a.node.operatorToken();
    const search = async (query: string) => {
      const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { query, include_edges: true, top_k: 3 } } }) });
      return JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as {
        index: string; nodes: { name: string; description: string }[]; edges: { source_name: string; relation: string; target_name: string }[] };
    };
    const Q = 'attorney for ending a marriage';
    assert.equal((await search(Q)).index, 'pending');

    const child = spawnExecutor({ url: a.url, dataDir: exDir, script: EMBEDDER, cpuSeconds: 60, env: { ROFLENOX_ONCE: '1' } });
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { out += d; });
    const { code } = await new Promise<{ code: number | null }>((r) => child.once('exit', (code) => r({ code })));
    assert.equal(code, 0, out);

    const r = await search(Q);
    assert.equal(r.index, 'embedder:embedder');
    // The two entities about ending marriages come first, ahead of the
    // baker, the engine and the tea — and share none of the query's words.
    assert.deepEqual(r.nodes.slice(0, 2).map((n) => n.name).sort(), ['Family court', 'Jane Doe'], JSON.stringify(r.nodes.map((n) => n.name)));
    for (const n of r.nodes.slice(0, 2)) assert.deepEqual([...words(`${n.name} ${n.description}`)].filter((w) => words(Q).has(w)), [], n.name);
    // And the FACT found first is the one between them, sharing none either.
    const fact = r.edges[0]!;
    assert.deepEqual([fact.source_name, fact.relation, fact.target_name], ['Jane Doe', 'represents_clients_at', 'Family court'], JSON.stringify(r.edges));
    assert.deepEqual([...words(`${fact.source_name} ${fact.relation.replace(/_/g, ' ')} ${fact.target_name}`)].filter((w) => words(Q).has(w)), []);
  } finally { await a.stop(); }
});
