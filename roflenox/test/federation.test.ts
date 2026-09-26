// Feeds and mirroring between two nodes; the CLI transcript carries no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bookOf, recoveryKeyFromCode } from '../src/identity.ts';
import { mirror, publish } from '../src/client.ts';
import { answers, DAY, fact, get, grant, iso, post, start, T0, tmpDir } from './helpers.ts';

test('two nodes: publish on A, mirror into B, identical ask answers; mirrored batches keep their original signer\'s book on B', async () => {
  const a = await start(tmpDir('fed-a'), 'node-a');
  const b = await start(tmpDir('fed-b'), 'node-b');
  const now = () => a.clock.t;
  try {
    // node-a lets node-b read its whole book for a day.
    await publish(a.url, a.me, [fact('alice', 'knows', 'bob'), fact('alice', 'owns', 'x', 0.3, 'work'),
      grant('node-b', iso(T0 + DAY))], now);
    await publish(a.url, a.me, [fact('bob', 'knows', 'carol', 1)], now);
    assert.deepEqual(await mirror(b.url, a.url, 'node-a', b.me, now), { identity: 'node-a', batches: 2 });
    assert.deepEqual(await answers(b.url), await answers(a.url));

    // Incremental: only what B does not have yet travels.
    await publish(a.url, a.me, [fact('carol', 'knows', 'dave')], now);
    assert.deepEqual(await mirror(b.url, a.url, 'node-a', b.me, now), { identity: 'node-a', batches: 1 });
    assert.deepEqual(await mirror(b.url, a.url, 'node-a', b.me, now), { identity: 'node-a', batches: 0 });
    const onA = await answers(a.url);
    assert.deepEqual(await answers(b.url), onA);
    assert.equal(((onA[0] as { rows: unknown[] }).rows).length, 5);

    // On B, A's facts are in A's book and answer as A's; B's own book has none.
    const inA = await post(b.url, '/ask', { query: `edge[${bookOf('node-a')}](F, S, R, T)` });
    assert.equal((inA.body.rows as { identity: string }[]).length, 5);
    assert.ok((inA.body.rows as { identity: string }[]).every((r) => r.identity === 'node-a'));
    const inB = await post(b.url, '/ask', { query: `edge[${bookOf('node-b')}](F, S, R, T)` });
    assert.equal(inB.status, 404, 'node-b has no book on B until it publishes');

    // B re-serves the feed byte for byte as signed, so a third node can verify it.
    assert.deepEqual((await get(b.url, '/feeds/node-a', { as: b.me })).body, (await get(a.url, '/feeds/node-a', { as: b.me })).body);
    assert.deepEqual((await get(b.url, '/health')).body.heads, (await get(a.url, '/health')).body.heads);
  } finally { await a.stop(); await b.stop(); }
});

// ---------------------------------------------------------------------------
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

function cli(dir: string, args: string[], url?: string): string {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args, '--data', dir, ...(url ? ['--url', url] : [])],
    { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, `roflenox ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout + r.stderr;
}

function serve(dir: string): Promise<{ child: ChildProcess; url: string; out: () => string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'serve', '--port', '0', '--data', dir]);
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  child.stderr!.on('data', (d) => { out += d; });
  return new Promise((ok, no) => {
    child.stdout!.on('data', () => {
      const m = /serving \S+ at (http:\S+)/.exec(out);
      if (m) ok({ child, url: m[1]!, out: () => out });
    });
    child.on('exit', (c) => no(new Error(`serve exited ${c}: ${out}`)));
  });
}

test('an end-to-end pull between two nodes whose transcript contains no key material', async () => {
  const da = tmpDir('e2e-a');
  const db = tmpDir('e2e-b');
  // Setup is the one moment key material is shown: the recovery code, once
  // (r_recovery). It is kept apart and must not recur in normal operation.
  const setup = [cli(da, ['init', '--name', 'alice-laptop']), cli(db, ['init', '--name', 'bob-server'])];
  const codes = setup.map((o) => /^ {2}([A-Z2-7]{4}(?:-[A-Z2-7]{1,4}){12})$/m.exec(o)?.[1]);
  assert.ok(codes.every((c) => c !== undefined), 'init hands over a recovery code');
  let transcript = '';
  const A = await serve(da);
  const B = await serve(db);
  try {
    const file = path.join(tmpDir('e2e-f'), 'facts.jsonl');
    fs.writeFileSync(file, '{"source":"alice","relation":"knows","target":"bob","perspective":"social","confidence":0.8}\n'
      + '{ "target": "enox", "source": "alice", "relation": "works_on", "confidence": 1, "perspective": "work" }\n'
      + '{"source":"*","relation":"roflenox:export","target":"public","perspective":"policy","confidence":1}\n');
    transcript += cli(da, ['publish', file], A.url);
    transcript += cli(db, ['mirror', A.url, 'alice-laptop'], B.url);
    const askA = cli(da, ['ask', 'edge(F, S, R, T)'], A.url);
    const askB = cli(db, ['ask', 'edge(F, S, R, T)'], B.url);
    transcript += askA + askB;
    assert.equal(askA, askB);
    assert.match(askB, /3 rows/);
    assert.match(transcript, /mirrored 1 batches of alice-laptop/);

    // What would count as key material, read from the nodes themselves.
    const secrets: string[] = [];
    for (const [d, url] of [[da, A.url], [db, B.url]] as const) {
      const chain = (await get(url, '/.well-known/roflenox/identity')).body as unknown as { doc: { keys: { key_id: string; public_key: string }[]; recovery: { public_key: string } }; sig: string }[];
      const doc = chain[chain.length - 1]!;
      secrets.push(doc.doc.recovery.public_key);
      secrets.push(doc.sig, doc.doc.keys[0]!.key_id, doc.doc.keys[0]!.public_key);
      secrets.push(JSON.parse(fs.readFileSync(path.join(d, 'key', 'identity.json'), 'utf8')).private_key);
    }
    const feed = (await get(A.url, '/feeds/alice-laptop')).body as { batches: { manifest: { sig: string } }[] };
    secrets.push(feed.batches[0]!.manifest.sig);
    transcript += A.out() + B.out();
    secrets.push(...codes as string[]);
    for (const s of secrets) assert.ok(s.length > 20 && !transcript.includes(s), 'a key, key id, signature or recovery code appeared in the transcript');
    // The code is stored nowhere on the node.
    for (const d of [da, db]) {
      const onDisk = fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, String(f))).filter((f) => fs.statSync(f).isFile());
      for (const c of codes) {
        // In any of its encodings: the code, the seed in hex and base64, the private key's DER.
        const der = recoveryKeyFromCode(c!).export({ format: 'der', type: 'pkcs8' });
        const seed = der.subarray(-32);
        const forms = [c!, seed.toString('hex'), seed.toString('base64'), seed.toString('base64url'), der.toString('base64')];
        for (const f of onDisk) {
          const text = fs.readFileSync(f, 'latin1');
          for (const x of forms) assert.ok(!text.includes(x), `recovery key found in ${f}`);
          assert.ok(!fs.readFileSync(f).includes(seed), `raw recovery seed found in ${f}`);
        }
      }
    }
    // Nothing key-shaped either: a base64url run of 43+ chars (an Ed25519 key is
    // 43, a signature 86). Fact ids are 64 hex and are content, not keys, so a
    // run made only of hex digits is not counted.
    const keyShaped = /(?=[A-Za-z0-9_-]*[g-zG-Z_-])[A-Za-z0-9_-]{43,}/;
    assert.doesNotMatch(transcript, keyShaped, 'nothing key-shaped in the transcript');
    // Positive control: the same pattern does fire on the identity document.
    assert.match(JSON.stringify((await get(A.url, '/.well-known/roflenox/identity')).body), keyShaped);
  } finally {
    for (const n of [A, B]) {
      const exited = new Promise((r) => n.child.once('exit', r));
      n.child.kill('SIGTERM');
      await exited;
    }
  }
});
