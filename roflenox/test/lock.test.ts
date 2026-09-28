// One process per data directory (r_single_writer): serve, stdio and every
// local operation that signs own it through <data>/lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lockPath } from '../src/lock.ts';
import { tmpDir } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const LOCK = path.join(import.meta.dirname, '..', 'src', 'lock.ts');
const NODE = [process.execPath, '--experimental-strip-types', '--no-warnings'] as const;

/** Every file under a directory: its bytes and its mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    const st = fs.statSync(p);
    out[path.relative(dir, p)] = st.isFile() ? `${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${st.mtimeMs}` : 'dir';
  }
  return out;
}

/** A second process on the directory: it must exit 1, and say who holds it. */
function refused(dir: string, argv: string[], holder: RegExp, why: string): Promise<void> {
  return new Promise((done, fail) => {
    const c = spawn(NODE[0], [...NODE.slice(1), CLI, ...argv, '--data', dir]);
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.stdin.end();
    // One that did not refuse would run on: it is stopped, and fails the check.
    const t = setTimeout(() => c.kill('SIGKILL'), 20_000);
    c.once('exit', (code, signal) => {
      clearTimeout(t);
      try {
        assert.equal(code, 1, `${why}: exit ${code} ${signal ?? ''}\n${out}\n${err}`);
        assert.match(err, holder, `${why}: names the holder`);
        done();
      } catch (e) { fail(e); }
    });
  });
}

function serve(dir: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(NODE[0], [...NODE.slice(1), CLI, 'serve', '--port', '0', '--data', dir]);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  return new Promise((ok, no) => {
    child.stdout!.on('data', () => { const m = /serving \S+ at (http:\S+)/.exec(out); if (m) ok({ child, url: m[1]! }); });
    child.on('exit', (c) => no(new Error(`serve exited ${c}: ${out}`)));
  });
}

test('a second serve or stdio on a data directory another process holds refuses to start, names the holder and changes nothing', async () => {
  // 1. Held by a process that is not a node at all (this test), on an empty
  // directory: a second owner may not even make a key before it refuses.
  const empty = tmpDir('lock-empty');
  fs.writeFileSync(lockPath(empty), JSON.stringify({ pid: process.pid, host: os.hostname(), role: 'a test holder', since: '2026-01-01T00:00:00.000Z', token: 't0' }));
  const bare = snapshot(empty);
  // (All at once: each is a second process on the same held directory.)
  await Promise.all([
    refused(empty, ['serve', '--port', '0'], new RegExp(`a test holder \\(pid ${process.pid} on `), 'serve on a held empty directory'),
    refused(empty, ['stdio'], new RegExp(`a test holder \\(pid ${process.pid} on `), 'stdio on a held empty directory'),
    refused(empty, ['init', '--name', 'node.example.org'], /a test holder/, 'init on a held empty directory'),
  ]);
  assert.deepEqual(snapshot(empty), bare, 'no key, no log: nothing was written');

  // 2. Held by a running serve, with a log.
  const dir = tmpDir('lock');
  const A = await serve(dir);
  let killed = false;
  try {
    const facts = path.join(tmpDir('lock-f'), 'f.jsonl');
    fs.writeFileSync(facts, '{"source":"ada","relation":"wrote","target":"notes","perspective":"p","confidence":1}\n');
    // A local op that signs, at the holder's own URL, goes through it.
    const pub = spawnSync(NODE[0], [...NODE.slice(1), CLI, 'publish', facts, '--data', dir, '--url', A.url], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(pub.status, 0, pub.stderr);
    // An unfinished temp file of the holder's, as mid-write: a second
    // process that opened the log would move it to quarantine.
    const sub = fs.readdirSync(path.join(dir, 'log'), { withFileTypes: true }).find((e) => e.isDirectory())!.name;
    fs.writeFileSync(path.join(dir, 'log', sub, 'x.jsonl.tmp-1'), 'mid-write');
    const held = snapshot(dir);
    const byA = new RegExp(`serve \\(pid ${A.child.pid} on [^,]+, since [^,]+, at ${A.url.replace(/[.]/g, '\\.')}\\)`);
    await Promise.all([
      refused(dir, ['serve', '--port', '0'], byA, 'a second serve'),
      refused(dir, ['stdio'], byA, 'stdio beside serve (the forked-chain repro)'),
      refused(dir, ['publish', facts, '--url', 'http://127.0.0.1:9'], byA, 'publish signing for another node'),
      // What the holder does not sign for us waits for it to stop: a key change, a checkpoint.
      refused(dir, ['rotate', '--url', A.url], byA, 'rotate beside the serve'),
      refused(dir, ['checkpoint', '--out', tmpDir('lock-out'), '--url', A.url], byA, 'checkpoint beside the serve'),
    ]);
    assert.deepEqual(snapshot(dir), held, 'the refusals changed nothing in the directory');

    // 3. The holder dies without letting go: its lock is stale.
    const gone = new Promise((r) => A.child.once('exit', r));
    A.child.kill('SIGKILL');
    await gone;
    killed = true;
    assert.ok(fs.existsSync(lockPath(dir)), 'a killed holder leaves its lock');
    fs.rmSync(path.join(dir, 'log', sub, 'x.jsonl.tmp-1'));

    // 4. Six processes take the stale lock over at once: exactly one wins.
    const racer = `import { DataLock } from ${JSON.stringify(LOCK)};
      try { DataLock.acquire(${JSON.stringify(dir)}, 'racer'); console.log('won'); process.stdin.resume(); }
      catch (e) { console.log('refused ' + e.message); }`;
    const racers = Array.from({ length: 6 }, () => {
      const c = spawn(NODE[0], [...NODE.slice(1), '--input-type=module', '-e', racer]);
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      return { c, said: new Promise<string>((r) => c.stdout.on('data', () => { if (out.includes('\n')) r(out.trim()); })), exit: new Promise((r) => c.once('exit', r)) };
    });
    try {
      const said = await Promise.all(racers.map((r) => r.said));
      assert.equal(said.filter((s) => s === 'won').length, 1, said.join('\n'));
      for (const s of said.filter((x) => x !== 'won')) assert.match(s, /^refused .*held by racer \(pid \d+ on /);
    } finally {
      for (const r of racers) r.c.stdin.end();
      await Promise.all(racers.map((r) => r.exit));
    }
    assert.ok(!fs.existsSync(lockPath(dir)), 'the winner let go when it exited');

    // 5. After a holder died, stdio starts, answers, and lets go.
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: A.child.pid, host: os.hostname(), role: 'serve', since: '2026-01-01T00:00:00.000Z', token: 'dead' }));
    const s = spawnSync(NODE[0], [...NODE.slice(1), CLI, 'stdio', '--data', dir], { encoding: 'utf8', timeout: 30_000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { query: 'edge(F, "ada", "wrote", T)' } } })}\n` });
    assert.equal(s.status, 0, s.stderr);
    assert.match(JSON.parse(s.stdout).result.content[0].text, /notes/);
    assert.ok(!fs.existsSync(lockPath(dir)), 'stdio let go when it exited');
  } finally {
    if (!killed) {
      const gone = new Promise((r) => A.child.once('exit', r));
      A.child.kill('SIGTERM');
      await gone;
    }
  }
});

test('eight concurrent local publishes through one serve are all admitted, in one chain, and the node records no fork of its own identity', async () => {
  const dir = tmpDir('lock-eight');
  let A = await serve(dir);
  const cli = (args: string[], url: string) => new Promise<{ code: number | null; out: string }>((ok) => {
    const c = spawn(NODE[0], [...NODE.slice(1), CLI, ...args, '--data', dir, '--url', url]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.once('exit', (code) => ok({ code, out }));
  });
  try {
    // Each publish reads its facts from a named pipe: all eight processes are
    // started and blocked on their reads, then released at once — so their
    // writes overlap, whatever each process's start-up time.
    const fdir = tmpDir('lock-eight-f');
    const fifos = Array.from({ length: 8 }, (_, i) => path.join(fdir, `f${i}.jsonl`));
    for (const p of fifos) assert.equal(spawnSync('mkfifo', [p]).status, 0, 'mkfifo');
    const running = fifos.map((f) => cli(['publish', f], A.url));
    const ends = await Promise.all(fifos.map((p) => fs.promises.open(p, 'w')));   // each opens once its reader has
    await Promise.all(ends.map((h, i) => h.writeFile(`{"source":"ada","relation":"wrote","target":"note ${i}","perspective":"p","confidence":1}\n`).then(() => h.close())));
    const runs = await Promise.all(running);
    for (const r of runs) assert.equal(r.code, 0, r.out);
    const health = JSON.parse((await cli(['health'], A.url)).out) as { identity: string; batches: number; forks: number; heads: Record<string, string> };
    assert.equal(health.forks, 0, 'no fork recorded');
    assert.equal(health.batches, 8, 'eight batches');
    const chain = JSON.parse((await cli(['chain', '--identity', health.identity], A.url)).out) as { digests: string[] };
    assert.equal(chain.digests.length, 8, 'one chain of eight');
    assert.equal(chain.digests[7], health.heads[health.identity]);
    assert.match((await cli(['ask', 'edge(F, "ada", "wrote", T)'], A.url)).out, /^8 rows$/m);
    // And the node starts again on it.
    const gone = new Promise((r) => A.child.once('exit', r));
    A.child.kill('SIGTERM');
    await gone;
    A = await serve(dir);
    assert.match((await cli(['ask', 'edge(F, "ada", "wrote", T)'], A.url)).out, /^8 rows$/m);
  } finally {
    const gone = new Promise((r) => A.child.once('exit', r));
    A.child.kill('SIGTERM');
    await gone;
  }
});
