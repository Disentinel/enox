// Executors run off the read path: a separate process, its own CPU budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnExecutor } from '../src/executor.ts';
import { publish } from '../src/client.ts';
import { DAY, fact, grant, identityAt, iso, post, start, tmpDir, type Clock } from './helpers.ts';

const SCRIPT = path.join(import.meta.dirname, 'fixtures', 'burn-executor.ts');

test('an ask answers within one second while an executor saturates its CPU budget', async () => {
  // Real time here: the executor is another process with its own clock.
  const clock = { get t() { return Date.now(); }, set t(_v: number) { /* fixed to the wall clock */ } } as Clock;
  const a = await start(tmpDir('exec-a'), 'node-a', { clock });
  const exDir = tmpDir('exec-e');
  const ex = identityAt(exDir, 'embedder');
  let stop = () => {};
  try {
    assert.equal((await post(a.url, '/identities', ex.identityChain())).status, 200);
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), fact('bob', 'knows', 'carol'), fact('carol', 'knows', 'dave'),
      grant('embedder', iso(Date.now() + DAY))]);
    // A book the executor was NOT granted: its facts get no intents for it.
    await publish(a.url, identityAt(tmpDir('exec-b'), 'node-b'), [fact('private', 'note', 'x')]);
    assert.equal(((await post(a.url, '/ask', { query: 'edge(F, S, R, T)' })).body.rows as unknown[]).length, 5);

    const child = spawnExecutor({ url: a.url, dataDir: exDir, script: SCRIPT, cpuSeconds: 1 });
    stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    let out = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { out += d; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));

    // Ask continuously while it works and then burns its whole budget.
    let worst = 0, asks = 0, done = false;
    void exited.then(() => { done = true; });
    const deadline = Date.now() + 20_000;   // generous: under a loaded suite nice 10 gets little CPU
    while (!done && Date.now() < deadline) {
      const t0 = performance.now();
      const r = await post(a.url, '/ask', { query: 'edge(F, S, R, T)' });
      worst = Math.max(worst, performance.now() - t0);
      assert.equal(r.status, 200);
      asks++;
    }
    stop();
    const exit = await exited;
    assert.ok(asks >= 20, `asked ${asks} times while the executor ran`);
    assert.ok(worst < 1000, `the slowest ask took ${worst.toFixed(0)} ms`);
    // The kernel, not the executor, ended it: the CPU budget is real.
    assert.equal(exit.signal, 'SIGXCPU', `executor exit ${JSON.stringify(exit)}: ${out}`);
    assert.match(out, /embedded 4/);

    // Its results came back through admission into its own book, and the intents are gone.
    const emb = (await post(a.url, '/ask', { query: 'edge(E, F, "roflenox:embedding", V)' })).body.rows as { identity: string }[];
    assert.equal(emb.length, 4);
    assert.ok(emb.every((r) => r.identity === 'embedder'));
    assert.ok(!JSON.stringify((await post(a.url, '/ask', { query: 'edge(F, "private", R, T)' })).body.rows).includes('embedding'));
    const left = await fetch(`${a.url}/health`).then((r) => r.json()) as { heads: Record<string, string> };
    assert.ok(left.heads.embedder, 'the executor has a chain of its own');
  } finally { stop(); await a.stop(); }
});
