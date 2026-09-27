// The log is truth: rebuild, snapshot-as-cache, crash safety, no silent reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bookOf, type LocalIdentity } from '../src/identity.ts';
import { sha256hex } from '../src/facts.ts';
import { backup } from '../src/backup.ts';
import { answers, batch, DAY, fact, get, grant, identityAt, iso, post, serveAsIs, start, T0, tmpDir, type Running } from './helpers.ts';

/** Publish a few batches from the node's own identity and from a second one. */
/** node-a (the node's operator) and node-b publish; both grant `reader`,
 *  who is introduced to the node and sees all of it without being its operator. */
async function populate(a: Running, tag: string): Promise<LocalIdentity> {
  const b = identityAt(tmpDir(`${tag}-b`), 'node-b');
  const reader = identityAt(tmpDir(`${tag}-r`), 'reader');
  assert.equal((await post(a.url, '/identities', reader.identityDoc())).status, 200);
  const heads = (await get(a.url, '/health')).body.heads as Record<string, string>;
  const b1 = batch(a.me, [fact('alice', 'knows', 'bob'), fact('alice', 'owns', 'x', 0.25, 'work'), grant('reader', iso(T0 + DAY))],
    heads['node-a'] ?? null, iso(a.clock.t));
  const b2 = batch(a.me, [fact('bob', 'knows', 'carol', 1)], b1.manifest.digest, iso(a.clock.t));
  const c1 = batch(b, [fact('alice', 'knows', 'dave', 0.5, 'gossip'), grant('reader', iso(T0 + DAY))], heads['node-b'] ?? null, iso(a.clock.t));
  for (const x of [b1, b2, c1]) assert.equal((await post(a.url, '/batches', x)).status, 201);
  return reader;
}

/** SIGKILL the node's engine — only a live one: a dead engine's pid may
 *  already belong to some other process. */
function killEngine(r: Running): void {
  const pid = r.node.enginePid();
  if (pid === undefined) throw new Error('the engine is not running — refusing to kill a stale pid');
  process.kill(pid, 'SIGKILL');
}

function onlyLog(dir: string): void {
  for (const e of fs.readdirSync(dir)) if (e !== 'log') fs.rmSync(path.join(dir, e), { recursive: true });
}

test('delete everything except the log, restart, and every ask returns the same answers', async () => {
  const dir = tmpDir('rebuild');
  const a = await start(dir, 'node-a');
  const reader = await populate(a, 'rebuild');
  // Asked as a granted reader, since the operator's key will be gone too;
  // and unsigned, which sees nothing (nothing is exported).
  const before = [await answers(a.url, { as: reader }), await answers(a.url, { as: null })];
  assert.equal((before[0]![0] as { rows: unknown[] }).rows.length, 6, 'the reader sees every fact');
  assert.equal((before[1]![0] as { rows: unknown[] }).rows.length, 0);
  await a.stop();
  onlyLog(dir);
  assert.deepEqual(fs.readdirSync(dir), ['log']);
  // Not even the key: answering needs none of it.
  const r = await serveAsIs(dir);
  try {
    assert.deepEqual([await answers(r.url, { as: reader }), await answers(r.url, { as: null })], before);
  } finally { await r.stop(); }
});

test('a key file that is not the identity the log knows stops the node', async () => {
  const dir = tmpDir('rekey');
  let a = await start(dir, 'node-a');
  assert.equal((await post(a.url, '/batches', batch(a.me, [fact('a', 'r', 'b')], null, iso(a.clock.t)))).status, 201);
  await a.stop();
  fs.rmSync(path.join(dir, 'key'), { recursive: true });
  await assert.rejects(start(dir, 'node-a'), /does not follow the identity the log knows \(.*keys changed without a rotation.*\); refusing to start/);
});

test('a committed log file that cannot be read stops the node instead of an empty start', async () => {
  const dir = tmpDir('noreset');
  let a = await start(dir, 'node-a');
  const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
  assert.equal((await post(a.url, '/batches', b1)).status, 201);
  await a.stop();
  const f = path.join(dir, 'log', bookOf('node-a'), `${b1.manifest.digest}.jsonl`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('bob', 'bot'));
  await assert.rejects(start(dir, 'node-a'), /does not match its digest; refusing to start/);
  assert.equal(fs.readFileSync(path.join(dir, 'log', 'index.jsonl'), 'utf8').split('\n').length, 2, 'the log is untouched');
});

// A process killed at any point of a write leaves the previous state readable.
const POINTS: [string, boolean][] = [
  // [fault point, whether the batch is committed when the process dies there]
  ['identity:temp-written', false], ['identity:renamed', false],
  ['jsonl:temp-written', false], ['jsonl:renamed', false],
  ['manifest:temp-written', false], ['manifest:renamed', false],
  ['index:half-written', false], ['index:committed', true],
];

for (const [point, committed] of POINTS) {
  test(`killed at ${point}: the node restarts ${committed ? 'with the batch' : 'at the previous state'} and stays writable`, async () => {
    const dir = tmpDir('crash');
    const first = point.startsWith('identity:');
    let a = await start(dir, 'node-a');
    let prev: string | null = null;
    if (!first) {
      const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
      assert.equal((await post(a.url, '/batches', b1)).status, 201);
      prev = b1.manifest.digest;
    }
    const before = await answers(a.url);
    const headBefore = (await get(a.url, '/health')).body.heads;
    const t = a.clock.t;
    await a.stop();

    const b2 = batch(a.me, [fact('alice', 'knows', 'crash')], prev, iso(t));
    const bodyPath = path.join(tmpDir('crash-body'), 'b.json');
    fs.writeFileSync(bodyPath, JSON.stringify(b2));
    const child = spawnSync(process.execPath,
      ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'crash-child.ts'), dir, point, bodyPath, String(t)],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.signal, 'SIGKILL', `the child died at ${point} (stdout ${child.stdout}, stderr ${child.stderr})`);
    assert.ok(!child.stdout.includes('survived'));

    a = await start(dir, 'node-a');
    try {
      const h = (await get(a.url, '/health')).body;
      if (committed) {
        assert.equal((h.heads as Record<string, string>)['node-a'], b2.manifest.digest);
        const b3 = batch(a.me, [fact('alice', 'knows', 'after')], b2.manifest.digest, iso(t));
        assert.equal((await post(a.url, '/batches', b3)).status, 201);
      } else {
        assert.deepEqual(h.heads, headBefore);
        assert.deepEqual(await answers(a.url), before);
        // Still writable: the same batch is admitted now.
        assert.equal((await post(a.url, '/batches', b2)).status, 201);
      }
      if (point.endsWith('temp-written') || point === 'index:half-written') {
        assert.ok((h.recovered as string[]).length > 0, 'the torn write was reported, not silently dropped');
      }
      const rows = (await post(a.url, '/ask', { query: 'edge(F, "alice", "knows", "crash")' })).body.rows as unknown[];
      assert.equal(rows.length, 1);
    } finally { await a.stop(); }
  });
}

test('a node killed at each write step reopens with the whole batch or none of it', async () => {
  // The write steps are not listed here but found: every fault point one
  // admission passes on disk, so a step added later is covered by this test.
  // (The engine's staging is not a write: it lives in a process that dies too.)
  const steps: string[] = [];
  const probe = await start(tmpDir('whole-probe'), 'node-a', { fault: (p) => { if (!p.startsWith('engine:')) steps.push(p); } });
  const facts = [fact('alice', 'knows', 'bob'), fact('alice', 'owns', 'x'), fact('alice', 'likes', 'tea')];
  try {
    assert.equal((await post(probe.url, '/batches', batch(probe.me, facts, null, iso(probe.clock.t)))).status, 201);
  } finally { await probe.stop(); }
  assert.ok(steps.length >= 8 && steps.includes('index:half-written'), steps.join(' '));

  const seen: boolean[] = [];
  for (const step of steps) {
    const dir = tmpDir('whole');
    let a = await start(dir, 'node-a');
    const t = a.clock.t;
    await a.stop();
    const b1 = batch(a.me, facts, null, iso(t));   // the first batch: it also pins the identity
    const bodyPath = path.join(tmpDir('whole-body'), 'b.json');
    fs.writeFileSync(bodyPath, JSON.stringify(b1));
    const child = spawnSync(process.execPath,
      ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'crash-child.ts'), dir, step, bodyPath, String(t)],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.signal, 'SIGKILL', `the child died at ${step} (stderr ${child.stderr})`);

    a = await start(dir, 'node-a');
    try {
      const head = ((await get(a.url, '/health')).body.heads as Record<string, string>)['node-a'];
      const held = ((await post(a.url, '/ask', { query: 'edge(F, "alice", R, T)' })).body.rows as unknown[]).length;
      const whole = head === b1.manifest.digest;
      assert.equal(held, whole ? facts.length : 0, `killed at ${step}: ${held} of ${facts.length} facts, head ${head ?? 'none'}`);
      if (!whole) {
        assert.equal(head, undefined, `killed at ${step}: the head is the previous one`);
        assert.equal((await post(a.url, '/batches', b1)).status, 201, `killed at ${step}: the same batch is admitted after the restart`);
        assert.equal(((await post(a.url, '/ask', { query: 'edge(F, "alice", R, T)' })).body.rows as unknown[]).length, facts.length);
      }
      seen.push(whole);
    } finally { await a.stop(); }
  }
  // Both outcomes occur: dying before the commit loses the batch, after it keeps it.
  assert.ok(seen.includes(false) && seen[seen.length - 1] === true, seen.join(' '));
});

test('a node rebuilt from its latest backup answers every question the same as the node up to that backup', async () => {
  const dir = tmpDir('backup');
  const to = tmpDir('backup-to');
  const a = await start(dir, 'node-a');
  try {
    const reader = await populate(a, 'backup');
    const upToBackup = await answers(a.url, { as: reader });
    // The node keeps admitting while the backup runs: three batches land
    // after the backup has read the index and before it copies anything.
    let head = ((await get(a.url, '/health')).body.heads as Record<string, string>)['node-a']!;
    const r = await backup(dir, to, {
      now: () => a.clock.t,
      afterIndexRead: async () => {
        for (let i = 0; i < 3; i++) {
          const b = batch(a.me, [fact('late', 'fact', String(i))], head, iso(a.clock.t));
          head = b.manifest.digest;
          assert.equal((await post(a.url, '/batches', b)).status, 201);
        }
      },
    });
    assert.equal(r.receipts, 4, 'the backup is the log as of its receipt: 1 identity + 3 batches');
    const meta = JSON.parse(fs.readFileSync(path.join(to, 'latest', 'backup.json'), 'utf8')) as { receipts: number; log_head: string };
    assert.deepEqual(meta.receipts, r.receipts);

    // The oracle for "the node up to that backup": the node's OWN log cut at
    // the backup's receipt, rebuilt independently of the backup's copy.
    const cut = tmpDir('backup-cut');
    fs.cpSync(path.join(dir, 'log'), path.join(cut, 'log'), { recursive: true });
    const idx = fs.readFileSync(path.join(cut, 'log', 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.ok(idx.length >= r.receipts);
    fs.writeFileSync(path.join(cut, 'log', 'index.jsonl'), idx.slice(0, r.receipts).map((l) => `${l}\n`).join(''));
    const oracle = await serveAsIs(cut);
    const restored = await serveAsIs(path.join(to, 'latest'));
    try {
      const want = await answers(oracle.url, { as: reader });
      assert.deepEqual(await answers(restored.url, { as: reader }), want);
      assert.equal(restored.node.health().log_head, r.log_head);
      assert.equal(oracle.node.health().log_head, r.log_head);
      assert.deepEqual(want, upToBackup, 'the oracle is the node up to the backup');
    } finally { await restored.stop(); await oracle.stop(); }
    // Control: after the backup the node moved on; its backup did not.
    const after = await answers(a.url, { as: reader });
    assert.notDeepEqual(after, upToBackup);

    // A fresh backup now includes everything, and rebuilds to the same answers.
    await backup(dir, to, { now: () => a.clock.t });
    const again = await serveAsIs(path.join(to, 'latest'));
    try { assert.deepEqual(await answers(again.url, { as: reader }), after); } finally { await again.stop(); }
  } finally { await a.stop(); }
});

test('a backup killed between any two of its steps leaves a readable backup at the latest path', async () => {
  const dir = tmpDir('bk-kill');
  const a = await start(dir, 'node-a');
  const base = tmpDir('bk-kill-base');
  let before: string, after: string;
  try {
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    before = (await backup(dir, base, { now: () => a.clock.t })).log_head;
    assert.equal((await post(a.url, '/batches', batch(a.me, [fact('alice', 'knows', 'carol')], b1.manifest.digest, iso(a.clock.t)))).status, 201);
    after = (await get(a.url, '/health')).body.log_head as string;
  } finally { await a.stop(); }
  assert.notEqual(after, before);
  const withPrevious = () => { const to = tmpDir('bk-kill-to'); fs.cpSync(base, to, { recursive: true, verbatimSymlinks: true }); return to; };

  // The steps are found, not listed: every fault point a backup passes when
  // a previous one is in place.
  const steps: string[] = [];
  await backup(dir, withPrevious(), { now: () => T0, fault: (p) => { steps.push(p); } });
  assert.deepEqual(steps, ['backup:staged', 'backup:link-written', 'backup:swapped', 'backup:old-removed']);

  const heads: string[] = [];
  for (const step of steps) {
    const to = withPrevious();
    const child = spawnSync(process.execPath,
      ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'backup-child.ts'), dir, to, step, String(T0)],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.signal, 'SIGKILL', `the backup died at ${step} (stderr ${child.stderr})`);
    // Whatever latest names is a whole backup that a node opens: the previous one or the new one.
    const meta = JSON.parse(fs.readFileSync(path.join(to, 'latest', 'backup.json'), 'utf8')) as { log_head: string };
    const restored = await serveAsIs(path.join(to, 'latest'));
    try {
      const head = restored.node.health().log_head as string;
      assert.equal(head, meta.log_head, `killed at ${step}: latest rebuilds to what it says it is`);
      assert.ok(head === before || head === after, `killed at ${step}: latest is a backup of this log`);
      heads.push(head);
    } finally { await restored.stop(); }
    // And the next scheduled run installs the new one over what the kill left.
    assert.equal((await backup(dir, to, { now: () => T0 })).log_head, after, `after a kill at ${step}`);
  }
  // Both outcomes occur: killed before the swap keeps the previous, after it the new.
  assert.deepEqual(heads, [before, before, after, after]);
});

test('killing the engine during an admission leaves the log consistent, refuses that batch, and the node answers after it rebuilds', async () => {
  const dir = tmpDir('enginekill');
  let armed = false;
  let node: Running | null = null;
  const a = node = await start(dir, 'node-a', {
    fault: (p) => { if (p === 'engine:staged' && armed) { armed = false; killEngine(node!); } },
  });
  try {
    const reader = await populate(a, 'enginekill');
    const before = await answers(a.url, { as: reader });
    const indexBefore = fs.readFileSync(path.join(dir, 'log', 'index.jsonl'), 'utf8');
    const head = ((await get(a.url, '/health')).body.heads as Record<string, string>)['node-a']!;

    // The engine is SIGKILLed after it took the batch and before it evaluated.
    armed = true;
    const b = batch(a.me, [fact('during', 'the', 'crash')], head, iso(a.clock.t));
    const r = await post(a.url, '/batches', b);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'engine_down');
    assert.equal(fs.readFileSync(path.join(dir, 'log', 'index.jsonl'), 'utf8'), indexBefore, 'the log is exactly as it was');

    // The next question rebuilds the engine from what the node holds, and answers as before.
    assert.deepEqual(await answers(a.url, { as: reader }), before);
    const h = (await get(a.url, '/health')).body;
    assert.deepEqual(h.engine, { up: true, restarts: 1 });
    assert.deepEqual((h.heads as Record<string, string>)['node-a'], head);
    // The refused batch can simply be sent again.
    assert.equal((await post(a.url, '/batches', b)).status, 201);
    assert.equal(((await post(a.url, '/ask', { query: 'edge(F, "during", R, T)' })).body.rows as unknown[]).length, 1);
    // An engine that dies while idle is replaced the same way: the ask that
    // meets the death (if one does) is refused, never answered plainly.
    killEngine(a);
    let r2 = await post(a.url, '/ask', { query: 'edge(F, "during", R, T)' });
    if (r2.status !== 200) {
      assert.equal(r2.body.error, 'engine_down');
      r2 = await post(a.url, '/ask', { query: 'edge(F, "during", R, T)' });
    }
    assert.equal((r2.body.rows as unknown[]).length, 1);
    assert.equal(((await get(a.url, '/health')).body.engine as { restarts: number }).restarts, 2);
  } finally { await a.stop(); }
});

test('killing the engine during an ask never yields a plain answer: the asker gets an error or unknown, and the next ask is answered', async () => {
  let armed: string | null = null;
  let node: Running | null = null;
  const a = node = await start(tmpDir('askkill'), 'alice', {
    ruleBudget: 20_000,                            // the runaway rule stops at its budget in milliseconds
    fault: (p) => { if (p === armed) { armed = null; killEngine(node!); } },
  });
  try {
    const rule = (name: string, text: string) => ({ source: name, relation: 'roflenox:rule', target: text, perspective: 'rules', confidence: 1 });
    const b1 = batch(a.me, [fact('alice', 'knows', 'bob'), rule('base', 'n(0) :- edge(F, S, "knows", T).'), rule('grow', 'n(M) :- n(N), M is N + 1.')], null, iso(a.clock.t));
    assert.equal((await post(a.url, '/batches', b1)).status, 201);
    const plain = (r: { status: number; body: Record<string, unknown> }) => r.status === 200 && r.body.unknown === undefined;
    const answered = async (p: string, body: unknown) => {
      const r = await post(a.url, p, body);
      assert.equal(r.status, 200, `the next ask is answered: ${JSON.stringify(r.body)}`);
      return r;
    };

    // 1. The main world: killed as the question reaches it.
    armed = 'engine:ask';
    const m = await post(a.url, '/ask', { query: 'edge(F, S, R, T)' });
    assert.ok(!plain(m), `main-world ask under a kill: ${m.status} ${JSON.stringify(m.body)}`);
    assert.equal(m.body.error, 'engine_down');
    assert.equal(((await answered('/ask', { query: 'edge(F, S, R, T)' })).body.rows as unknown[]).length, 3);

    // 2. A rule world, killed as it starts to evaluate the runaway rule (a
    // new batch makes the next question build the world afresh).
    assert.equal((await post(a.url, '/batches', batch(a.me, [fact('bob', 'knows', 'carol')], b1.manifest.digest, iso(a.clock.t)))).status, 201);
    armed = 'engine:world';
    const w = await post(a.url, '/ask', { query: 'n(X)', limit: 5 });
    assert.ok(!plain(w), `rule-world ask under a kill: ${w.status} ${JSON.stringify(w.body)}`);
    const next = await answered('/ask', { query: 'n(X)', limit: 5 });
    assert.ok((next.body.rows as unknown[]).length > 0);
    // ...and a built world, killed as the question reaches it.
    armed = 'engine:world-ask';
    const wa = await post(a.url, '/ask', { query: 'n(X)', limit: 5 });
    assert.ok(!plain(wa), `built-world ask under a kill: ${wa.status} ${JSON.stringify(wa.body)}`);
    await answered('/ask', { query: 'n(X)', limit: 5 });

    // 3. why and whynot.
    for (const op of ['why', 'whynot'] as const) {
      armed = 'engine:explain';
      const e = await post(a.url, `/op/${op}`, { literal: 'n(0)' });
      assert.ok(!plain(e), `${op} under a kill: ${e.status} ${JSON.stringify(e.body)}`);
      await answered(`/op/${op}`, { literal: 'n(0)' });
    }
    assert.ok(((await get(a.url, '/health')).body.engine as { restarts: number }).restarts >= 4);
  } finally { await a.stop(); }
});
