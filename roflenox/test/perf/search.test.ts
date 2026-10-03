// Search latency on a book shaped like the owner's (r_search_latency): ~35 000
// texts already embedded, the embedder running as its own process. On
// 2026-10-03 the owner waited 113 s for an answer with five new items to
// embed: the embedder rebuilt its index and re-read the whole book from the
// log for every search. A running embedder keeps both and reads only what
// was written since. The model is the hash one (no network, no model files):
// what is measured is the reading, the index and the answering around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { publish } from '../../src/client.ts';
import { spawnExecutor } from '../../src/executor.ts';
import type { Fact } from '../../src/facts.ts';
import { embeddingKey, encode, HASH, hashEmbed } from '../../executors/embedder/embed.ts';
import { MAX_CHARS, POLL_MS, textsOf } from '../../executors/embedder/embedder.ts';
import { start, tmpDir, type Clock } from '../helpers.ts';
import { generateEnoxBook } from './gen.ts';

const EMBEDDER = path.join(import.meta.dirname, '..', '..', 'executors', 'embedder', 'embedder.ts');
const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;
const BOUND_MS = 10_000;
const TICK_MS = 50;                       // the embedder's poll here, and how often the test asks again
/** Resident memory the embedder process may reach with the hash model. The
 *  learned model adds its own (measured: 0.85 GB at most with PAD_BUDGET);
 *  the two stay inside the 2 GB the unit gives it. */
const RSS_BUDGET = 1024 ** 3;

const rssOf = (pid: number) => {
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024; } catch { return 0; }
};

test('a second search on an unchanged book is answered within ten seconds, and a search after five new facts within ten seconds too', async (t) => {
  const dir = tmpDir('perf-search');
  const exDir = tmpDir('perf-search-e');
  const t0 = performance.now();
  const { embedder } = generateEnoxBook(dir, exDir, { entities: 15_000, assertions: 19_700, t0: Date.now() - 3 * 86_400_000,
    embed: { texts: textsOf, key: (x) => embeddingKey(HASH.id, x), vector: (x) => encode(hashEmbed(x.slice(0, MAX_CHARS))), perspective: HASH.id } });
  const generated = (performance.now() - t0) / 1000;
  const a = await start(dir, 'owner', { clock: wall });
  const child = spawnExecutor({ url: a.url, dataDir: exDir, script: EMBEDDER, cpuSeconds: 600,
    env: { ROFLENOX_EMBED_MODEL: 'hash', ROFLENOX_POLL_MS: String(TICK_MS) } });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, rssOf(child.pid!)); }, 100);
  try {
    const held = (a.node.health() as { facts: number }).facts;
    t.diagnostic(`generated ${held} facts in ${generated.toFixed(1)} s`);
    const token = a.node.operatorToken();
    const search = async (query: string) => {
      const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { query } } }) });
      return JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { index: string; nodes: { name: string }[] };
    };
    /** Ask, then ask again every tick until answered: the time the asker waits. */
    const answered = async (query: string, most: number) => {
      const s = performance.now();
      let r = await search(query);
      assert.equal(r.index, 'pending', 'the first ask only asks');
      while (r.index === 'pending' && performance.now() - s < most) {
        await new Promise((ok) => setTimeout(ok, TICK_MS));
        r = await search(query);
      }
      assert.equal(r.index, `embedder:${embedder.name}`, `${query}: ${r.index} after ${((performance.now() - s) / 1000).toFixed(1)} s\n${out}`);
      return { r, ms: performance.now() - s };
    };

    // The first search after the embedder starts reads its index and the
    // book from the log, once.
    const warm = await answered('signed log memory', 180_000);
    assert.ok(held > 200_000, `${held} facts held`);
    assert.match(out, /answered 1 searches; index: 3\d{4} from the log, 0 embedded now/, 'every text was embedded ahead: ~35 000 from the log');
    // The asker waits at most one poll more than measured here (the embedder polls every POLL_MS in production).
    const within = BOUND_MS - POLL_MS + TICK_MS;
    const again = await answered('owner review policy', within);
    assert.ok(again.ms <= within, `a second search: ${again.ms.toFixed(0)} ms`);
    assert.match(out, /answered 1 searches; index: 3\d{4} in memory, 0 from the log, 0 embedded now; [0-2] batches of its own and [0-2] of the books searched read/,
      'the index and the book stayed in memory: only what was written since was read');

    // Five new facts: one entity (four) and an assertion about it.
    const E = 'enox://example.org/graph/main/d7/entity_new';
    const f = (source: string, relation: string, target: string): Fact => ({ source, relation, target, perspective: 'enox', confidence: 1 });
    await publish(a.url, a.me, [f(E, 'enox:type', 'concept'), f(E, 'enox:domain', 'd7'), f(E, 'enox:label', 'Zeppelin hangar'),
      f(E, 'enox:description', 'an airship shed of riveted girders'), f(E, 'supersedes', 'enox://example.org/graph/main/d7/entity_7')]);
    const after = await answered('airship shed girders', within);
    assert.ok(after.ms <= within, `a search after five new facts: ${after.ms.toFixed(0)} ms`);
    assert.equal(after.r.nodes[0]?.name, 'Zeppelin hangar', 'the new entity is found');
    assert.match(out, /answered 1 searches; index: 3\d{4} in memory, \d+ from the log, 2 embedded now; [0-3] batches of its own and [0-3] of the books searched read/,
      'only the two new texts were embedded, from the batches written since');
    t.diagnostic(`first search ${(warm.ms / 1000).toFixed(1)} s (index and book from the log); second ${again.ms.toFixed(0)} ms; after five facts ${after.ms.toFixed(0)} ms; embedder peak ${(peak / 1024 ** 2).toFixed(0)} MB`);
    assert.ok(peak > 0 && peak < RSS_BUDGET, `embedder peak resident ${(peak / 1024 ** 2).toFixed(0)} MB`);
  } finally {
    clearInterval(sampler);
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 10_000).unref(); });
    await a.stop();
  }
});
