// The intent loop: a rule derives an intent, an executor outside the node
// answers it in its own book, and why of the answer reaches the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { spawnExecutor } from '../src/executor.ts';
import { publish } from '../src/client.ts';
import { DAY, fact, grant, identityAt, iso, post, start, tmpDir, vouch, type Clock, type Running } from './helpers.ts';

const SCRIPT = path.join(import.meta.dirname, 'fixtures', 'burn-executor.ts');
const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;

const rule = (name: string, text: string) => ({ source: name, relation: 'roflenox:rule', target: text, perspective: 'rules', confidence: 1 });

/** node-a is alice's node; she asks "embedder" to digest whom each person knows. */
async function setup(tag: string): Promise<{ a: Running; exDir: string }> {
  const a = await start(tmpDir(`${tag}-a`), 'alice', { clock: wall });
  const exDir = tmpDir(`${tag}-e`);
  const ex = identityAt(exDir, 'embedder');
  assert.equal((await post(a.url, '/identities', ex.identityChain())).status, 200);
  await publish(a.url, a.me, [
    fact('alice', 'knows', 'bob'), fact('bob', 'knows', 'carol'), fact('carol', 'likes', 'tea'),
    rule('digest-knows', 'intent(F, "embedder", "digest", S) :- edge(F, S, "knows", T).'),
    grant('embedder', iso(Date.now() + DAY)),
  ]);
  return { a, exDir };
}

function run(o: Parameters<typeof spawnExecutor>[0]) {
  const child = spawnExecutor(o);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, exited, out: () => out };
}

test('an intent derived by a rule is answered by an executor and why of the result reaches the rule', async () => {
  const { a, exDir } = await setup('loop');
  try {
    const intents = (await post(a.url, '/ask', { query: 'intent(K, E, Kind, In)' })).body.rows as { cells: string[] }[];
    assert.deepEqual(intents.map((r) => r.cells.slice(1)).sort(), [['embedder', 'digest', 'alice'], ['embedder', 'digest', 'bob']]);
    assert.deepEqual((await post(a.url, '/ask', { query: 'answered(K, E, V)' })).body.rows, [], 'nothing answered yet');

    const e = run({ url: a.url, dataDir: exDir, script: SCRIPT, cpuSeconds: 5 });
    assert.equal((await e.exited).code, 0, e.out());
    assert.match(e.out(), /answered 2/);

    const ans = (await post(a.url, '/ask', { query: 'answered(K, E, V)' })).body.rows as { identity: string; cells: string[] }[];
    const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    assert.deepEqual(ans.map((r) => [r.identity, r.cells[1], r.cells[2]]).sort(),
      [['alice', 'embedder', sha('alice')], ['alice', 'embedder', sha('bob')]].sort());
    // The results live in the executor's own book, citing the intent's key.
    const results = (await post(a.url, '/ask', { query: 'edge(F, K, "roflenox:result", V)' })).body.rows as { identity: string }[];
    assert.ok(results.length === 2 && results.every((r) => r.identity === 'embedder'));

    // why crosses the boundary: the answer stands on the executor's result AND
    // on the intent, which stands on alice's rule and her fact.
    const k = ans.find((r) => r.cells[2] === sha('alice'))!.cells[0]!;
    const all = (await post(a.url, '/op/why', { literal: `answered("${k}", "embedder", "${sha('alice')}")` })).body as unknown as { identity: string; holds: boolean; text: string }[];
    const why = all.filter((w) => w.holds);
    assert.deepEqual(why.map((w) => w.identity), ['alice'], 'it holds in the asking book only');
    const t = why[0]!.text;
    assert.match(t, /^answered\[sys_roflenox\]/);
    assert.match(t, /intent\[b_[0-9a-f]{16}\]\("[0-9a-f]{64}","embedder","digest","alice"\)\s+<= r[0-9a-f]+/, 'the intent, derived by a rule');
    assert.match(t, /edge\[b_[0-9a-f]{16}\]\("[0-9a-f]{64}","alice","knows","bob"\) \[axiom\]/, 'alice\'s fact the rule read');
    assert.match(t, /edge\[b_[0-9a-f]{16}\]\("[0-9a-f]{64}","[0-9a-f]{64}","roflenox:result","[0-9a-f]{64}"\) \[axiom\]/, 'the executor\'s result');

    // Only the addressed executor answers: a result for the same key from
    // another book is not an answer.
    const mallory = identityAt(tmpDir('loop-m'), 'mallory');
    await vouch(a, mallory);                    // known to the node, and still not the addressed executor
    await publish(a.url, mallory, [{ source: k, relation: 'roflenox:result', target: 'forged', perspective: 'x', confidence: 1 }]);
    const after = (await post(a.url, '/ask', { query: 'answered(K, E, V)' })).body.rows as unknown[];
    assert.equal(after.length, 2);
    // Answered intents are not pulled again.
    const again = run({ url: a.url, dataDir: exDir, script: SCRIPT, cpuSeconds: 5 });
    await again.exited;
    assert.match(again.out(), /answered 0/);
  } finally { await a.stop(); }
});

test('an ask answers within one second while an executor saturates its CPU budget', async () => {
  const { a, exDir } = await setup('busy');
  const e = run({ url: a.url, dataDir: exDir, script: SCRIPT, cpuSeconds: 1, env: { BURN: '1' } });
  let stopped = false;
  const stop = () => { if (e.child.exitCode === null && e.child.signalCode === null) { stopped = true; e.child.kill('SIGKILL'); } };
  try {
    let worst = 0, asks = 0, done = false;
    void e.exited.then(() => { done = true; });
    const deadline = Date.now() + 20_000;   // generous: under a loaded suite nice 10 gets little CPU
    while (!done && Date.now() < deadline) {
      const t0 = performance.now();
      const r = await post(a.url, '/ask', { query: 'edge(F, S, R, T)' });
      worst = Math.max(worst, performance.now() - t0);
      assert.equal(r.status, 200);
      asks++;
    }
    stop();
    const exit = await e.exited;
    assert.ok(asks >= 20, `asked ${asks} times while the executor ran`);
    assert.ok(worst < 1000, `the slowest ask took ${worst.toFixed(0)} ms`);
    assert.equal(stopped, false, `the executor was still running at the deadline: ${e.out()}`);
    assert.equal(exit.signal, 'SIGXCPU', `the kernel ended it at its CPU budget, on Linux as on macOS: ${JSON.stringify(exit)} ${e.out()}`);
    assert.equal(((await post(a.url, '/ask', { query: 'answered(K, E, V)' })).body.rows as unknown[]).length, 2);
  } finally { stop(); await a.stop(); }
});
