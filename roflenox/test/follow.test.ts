// Following: a follow is a fact; the pull loop is its executor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import { exportRule, fact, get, start, tmpDir, type Clock } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const wall = () => ({ get t() { return Date.now(); }, set t(_v: number) { /* wall clock */ } }) as Clock;

test('a follower converges to the publisher\'s head after new batches without a manual pull', async () => {
  const p = await start(tmpDir('follow-p'), 'publisher', { clock: wall() });
  const fDir = tmpDir('follow-f');
  const f = await start(fDir, 'follower', { clock: wall() });
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'follow', '--interval_ms', '100', '--data', fDir, '--url', f.url]);
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const head = async (url: string) => ((await get(url, '/health')).body.heads as Record<string, string>).publisher;
  const converged = async () => {
    const want = await head(p.url);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await head(f.url) === want) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  try {
    await publish(p.url, p.me, [fact('p', 'says', '1'), exportRule('*', 'public')]);
    // The follow is a fact of the follower's; nothing else is configured.
    await publish(f.url, f.me, [{ source: 'publisher', relation: 'roflenox:follow', target: p.url, perspective: 'follows', confidence: 1 }]);
    assert.ok(await converged(), `first sync: ${log}`);
    for (const i of [2, 3]) await publish(p.url, p.me, [fact('p', 'says', String(i))]);
    assert.ok(await converged(), `after new batches: ${log}`);
    await publish(p.url, p.me, [fact('p', 'says', '4')]);
    assert.ok(await converged(), `again: ${log}`);
    const rows = (await (await fetch(`${f.url}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'edge(F, "p", "says", N)' }) })).json()) as { rows: unknown[] };
    assert.equal(rows.rows.length, 4, 'the facts arrived, as public reads show');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    await p.stop(); await f.stop();
  }
});
