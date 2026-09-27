// Memory (r_bounded_memory): a served node — the node process and its engine,
// everything it spawned — measured from outside by resident set size while
// idle. Before it idles it has reopened a log, admitted writes over the
// network with Enox reads between them (so the record of recent admissions
// and the Enox view are both in use), and answered a native ask. The idle
// window and the sampling period are injectable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { T0, tmpDir } from '../helpers.ts';
import { operatorTokenOf } from '../../src/node.ts';
import { bookOf } from '../../src/identity.ts';
import { httpCaller, publishVia } from '../../src/client.ts';
import { generateLog } from './gen.ts';

const BUDGET = 1.5 * 1024 ** 3;
const HELD = 200_000;
const WRITTEN = 40_000;                    // of which admitted over the network, 2000 at a time
const IDLE_MS = Number(process.env.ROFLENOX_IDLE_MS ?? 10_000);
const SAMPLE_MS = Number(process.env.ROFLENOX_SAMPLE_MS ?? 500);
const ROOT = path.join(import.meta.dirname, '..', '..');
// The node is started exactly as installed: with the flags on the CLI's
// #! line, the declared heap budget among them; `npm run roflenox` must match.
const SHEBANG = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8').split('\n')[0]!.replace(/^#!\/usr\/bin\/env -S node /, '').split(/\s+/);
const NPM = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.roflenox!.split(/\s+/);

/** The process and all its descendants. */
function tree(pid: number): number[] {
  let kids: number[] = [];
  try { kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { /* none */ }
  return [pid, ...kids.flatMap(tree)];
}

/** Resident bytes of a process tree, and how many processes were measured. */
function rss(pid: number): { bytes: number; procs: number; each: string } {
  const pids = tree(pid);
  const out = execFileSync('ps', ['-o', 'rss=,comm=', '-p', pids.join(',')], { encoding: 'utf8' }).split('\n').filter((l) => l.trim())
    .map((l) => { const [kb, ...cmd] = l.trim().split(/\s+/); return { bytes: Number(kb) * 1024, cmd: path.basename(cmd.join(' ')) }; });
  return { bytes: out.reduce((s, p) => s + p.bytes, 0), procs: out.length, each: out.map((p) => `${p.cmd} ${(p.bytes / 1024 ** 2).toFixed(0)} MB`).join(', ') };
}

test('a node holding 200000 facts stays under 1.5 GB of resident memory while idle', async (t) => {
  assert.deepEqual(NPM, ['node', ...SHEBANG, 'src/cli.ts'], 'npm run roflenox starts the node as the #! line does');
  // The budget is declared: the node's heap is capped, at no more than 1 GB.
  const heap = SHEBANG.map((f) => /^--max-old-space-size=(\d+)$/.exec(f)?.[1]).find(Boolean);
  assert.ok(heap !== undefined && Number(heap) <= 1024, `declared heap budget: ${heap ?? 'none'}`);
  const dir = tmpDir('perf-mem');
  const me = generateLog(dir, { facts: HELD - WRITTEN, batch: 2000, t0: T0, labels: true });
  const child = spawn(process.execPath, [...SHEBANG, path.join(ROOT, 'src', 'cli.ts'), 'serve', '--data', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise<string>((ok, no) => {
      let out = '';
      const timer = setTimeout(() => no(new Error(`not serving after 60 s: ${out}`)), 60_000);
      child.stdout!.on('data', (d: Buffer) => {
        out += d;
        const m = /serving \S+ at (\S+)/.exec(out);
        if (m) { clearTimeout(timer); ok(m[1]!); }
      });
      child.on('exit', (c) => no(new Error(`exited ${c}: ${out}`)));
    });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${operatorTokenOf(dir)}` };
    const enoxStats = async () => {
      const r = await fetch(`${url}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'graph_stats', arguments: {} } }) });
      return JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as { total_nodes: number; total_edges: number };
    };
    await enoxStats();
    const node = httpCaller(url, me);
    for (let b = 0; b < WRITTEN / 2000; b++) {
      const base = HELD - WRITTEN + b * 2000;
      const e = (k: number) => `enox://example.org/graph/main/w/e${k}`;
      await publishVia(node, me, Array.from({ length: 2000 }, (_, i) => i % 4 === 0
        ? { source: e(base + i), relation: 'enox:label', target: `Written ${base + i}`, perspective: 'perf', confidence: 1 }
        : { source: e(base + i - (i % 4)), relation: `rel${i % 85}`, target: e(base + ((i * 13) % 2000) - (((i * 13) % 2000) % 4)), perspective: 'perf', confidence: 0.5 }));
      await enoxStats();
    }
    // A write the disk refuses (here: the book is read-only) is aborted after
    // the engine took it; the node rebuilds the engine — and the one it
    // replaced must not stay behind.
    const book = path.join(dir, 'log', bookOf(me.name));
    fs.chmodSync(book, 0o555);
    try {
      await assert.rejects(publishVia(node, me, [{ source: 'x', relation: 'rel1', target: 'y', perspective: 'perf', confidence: 1 }]));
    } finally { fs.chmodSync(book, 0o755); }
    const ask = await fetch(`${url}/op/ask`, { method: 'POST', headers: auth, body: JSON.stringify({ query: 'edge(F, S, "rel7", T)', limit: 10 }) });
    assert.equal(ask.status, 200, await ask.clone().text());
    const health = (await (await fetch(`${url}/health`)).json()) as { facts: number; engine: { restarts: number }; recent_facts_remembered: number };
    assert.equal(health.facts, HELD);
    assert.equal(health.engine.restarts, 1, 'the aborted write made the node rebuild its engine');
    // What it remembers of recent admissions is bounded in facts, not batches.
    assert.ok(health.recent_facts_remembered > 0 && health.recent_facts_remembered <= 50_000, `remembers ${health.recent_facts_remembered} recent facts`);
    const s = await enoxStats();
    assert.equal(s.total_nodes, HELD / 4, 'the Enox view holds every labelled entity');
    assert.ok(s.total_edges > 0, 'and the edges between them');
    t.diagnostic(`Enox view: ${s.total_nodes} entities, ${s.total_edges} edges`);

    const samples: ReturnType<typeof rss>[] = [];
    for (let at = 0; at <= IDLE_MS; at += SAMPLE_MS) {
      samples.push(rss(child.pid!));
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
    const mb = (b: number) => (b / 1024 ** 2).toFixed(0);
    const peak = Math.max(...samples.map((x) => x.bytes));
    t.diagnostic(`idle ${IDLE_MS} ms, ${samples.length} samples of ${samples[0]!.procs} processes: first ${mb(samples[0]!.bytes)} MB, peak ${mb(peak)} MB, last ${mb(samples.at(-1)!.bytes)} MB (${samples.at(-1)!.each})`);
    // The measurement saw the node AND its engine, not just the node.
    // The node and ONE engine: measured together, and nothing else left running.
    assert.ok(samples.every((x) => x.procs === 2), `processes: ${samples.at(-1)!.each}`);
    assert.ok(peak < BUDGET, `peak ${mb(peak)} MB`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 10_000).unref(); });
  }
});
