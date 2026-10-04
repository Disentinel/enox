// Heap headroom on a book the size of the owner's (r_heap_headroom): the node
// runs as installed — its #! line caps the heap at 1 GB — while hosted
// sessions call it ten at a time and the embedder polls. 976f7b1 died here:
// three concurrent graph_stats exhausted the heap (prod, 2026-10-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpDir } from '../helpers.ts';
import { operatorTokenOf } from '../../src/node.ts';
import { spawnExecutor } from '../../src/executor.ts';
import { generateEnoxBook } from './gen.ts';
import { embeddingKey, encode, HASH, hashEmbed } from '../../executors/embedder/embed.ts';
import { MAX_CHARS, textsOf } from '../../executors/embedder/embedder.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SHEBANG = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8').split('\n')[0]!.replace(/^#!\/usr\/bin\/env -S node /, '').split(/\s+/);
const EMBEDDER = path.join(ROOT, 'executors', 'embedder', 'embedder.ts');
const ROUNDS = Number(process.env.ROFLENOX_HEADROOM_ROUNDS ?? 4);
const rssOf = (pid: number) => { try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024; } catch { return 0; } };
const mb = (b: number) => (b / 2 ** 20).toFixed(0);

test('on an owner-sized book under a 1 GB heap, ten concurrent graph_stats, recall and ask calls while an embedder polls leave the node alive and answering, and graph_stats answers within 200 ms', async (t) => {
  const heapCap = SHEBANG.map((f) => /^--max-old-space-size=(\d+)$/.exec(f)?.[1]).find(Boolean);
  assert.equal(heapCap, '1024', 'the node runs under a 1 GB heap, as installed');
  const dir = tmpDir('perf-headroom'), exDir = tmpDir('perf-headroom-e');
  // ~22k entities, ~12k edges, ~35k embeddings: ~250k facts, as the owner's book.
  generateEnoxBook(dir, exDir, { entities: 22_000, assertions: 12_000, t0: Date.now() - 3 * 86_400_000,
    embed: { texts: textsOf, key: (x) => embeddingKey(HASH.id, x), vector: (x) => encode(hashEmbed(x.slice(0, MAX_CHARS))), perspective: HASH.id } });
  const node = spawn(process.execPath, [...SHEBANG, path.join(ROOT, 'src', 'cli.ts'), 'serve', '--data', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  node.stderr!.on('data', (d: Buffer) => { log = (log + d).slice(-4000); });
  let died: string | null = null;
  node.once('exit', (code, sig) => { died = `exited ${code ?? sig}: ${log.slice(-600)}`; });
  let embedder: ReturnType<typeof spawnExecutor> | null = null;
  try {
    const url = await new Promise<string>((ok, no) => {
      let out = '';
      const timer = setTimeout(() => no(new Error(`not serving after 120 s: ${out} ${log}`)), 120_000);
      node.stdout!.on('data', (d: Buffer) => { out += d; const m = /serving \S+ at (\S+)/.exec(out); if (m) { clearTimeout(timer); ok(m[1]!); } });
      node.once('exit', () => { clearTimeout(timer); no(new Error(died!)); });
    });
    const token = operatorTokenOf(dir);
    const call = async (name: string, args: Record<string, unknown>) => {
      const s = performance.now();
      let r: Response;
      try {
        r = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      } catch (e) {
        await new Promise((ok) => setTimeout(ok, 1000));                   // let the exit be seen
        throw new Error(`${name}: ${(e as Error).message}; the node: ${died ?? 'still running'}`);
      }
      const text = await r.text();
      const ms = performance.now() - s;
      assert.equal(r.status, 200, `${name}: ${r.status} ${text.slice(0, 300)}`);
      const j = JSON.parse(text) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
      assert.ok(j.result && !j.result.isError, `${name}: ${text.slice(0, 300)}`);
      return ms;
    };
    // The embedder polls (feed and ask) every 200 ms, as it does in production every second.
    embedder = spawnExecutor({ url, dataDir: exDir, script: EMBEDDER, cpuSeconds: 3600, env: { ROFLENOX_EMBED_MODEL: 'hash', ROFLENOX_POLL_MS: '200' } });
    embedder.stdout!.resume(); embedder.stderr!.resume();
    let peakHeap = 0, peakRss = 0, limit = 0;
    const stalls: number[] = [];
    const sampler = setInterval(async () => {
      peakRss = Math.max(peakRss, rssOf(node.pid!));
      try {
        const h = await (await fetch(`${url}/op/health`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' })).json() as { memory?: { heap_used_mb: number; heap_limit_mb: number; stall_ms: number } };
        if (h.memory) { peakHeap = Math.max(peakHeap, h.memory.heap_used_mb); limit = h.memory.heap_limit_mb; if (h.memory.stall_ms > 100) stalls.push(h.memory.stall_ms); }
      } catch { /* the node may be busy or gone: the calls say which */ }
    }, 250);
    try {
      const round = (k: number, stats: number[] | null) => Promise.all([
        ...Array.from({ length: 4 }, () => call('graph_stats', {}).then((ms) => { stats?.push(ms); return ms; })),
        ...['Entity 12', 'graph engine', 'owner review'].map((q) => call('recall', { query: `${q} ${k}` })),
        call('ask', { query: 'edge(F, S, R, T)' }), call('ask', { query: 'live(F, S, "about", T)' }), call('ask', { query: 'conf(F, C)' }),
      ]);
      // Cold, as in production 40 s after a start: the first ten calls come at
      // once, while no view is built and the embedder is catching up.
      const s0 = performance.now();
      await round(-1, null);
      assert.equal(died, null, `the node died under the first calls: ${died}`);
      const first = performance.now() - s0;
      // Then steady: the embedder has caught up once it answers a search.

      const caughtUp = Date.now() + 300_000;
      for (;;) {
        const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'semantic_search', arguments: { query: 'graph engine owner' } } }) });
        const j = JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { index: string };
        if (j.index.startsWith('embedder:')) break;
        assert.ok(Date.now() < caughtUp, 'the embedder answers a search within five minutes');
        await new Promise((ok) => setTimeout(ok, 100));
      }
      const stats: number[] = [];
      for (let k = 0; k < ROUNDS; k++) {
        await round(k, stats);
        assert.equal(died, null, `the node died: ${died}`);
      }
      const sorted = [...stats].sort((x, y) => x - y);
      t.diagnostic(`event-loop stalls over 100 ms: ${stalls.join(', ') || 'none'}`);
      t.diagnostic(`the first ten calls, cold: ${first.toFixed(0)} ms; under load: median ${sorted[sorted.length >> 1]!.toFixed(0)} ms, max ${sorted.at(-1)!.toFixed(0)} ms; peak heap ${peakHeap} of ${limit} MB, peak RSS ${mb(peakRss)} MB`);
      assert.equal(died, null, `the node died: ${died}`);
      for (const ms of stats) assert.ok(ms < 200, `graph_stats under load took ${ms.toFixed(0)} ms`);
      assert.ok(peakHeap > 0 && peakHeap < 0.8 * limit, `peak heap ${peakHeap} MB of ${limit} MB: room to spare`);
    } finally { clearInterval(sampler); }
  } finally {
    embedder?.kill('SIGKILL');
    node.kill('SIGTERM');
    await new Promise((r) => (node.exitCode !== null || node.signalCode !== null ? r(null) : node.once('exit', r)));
  }
});
