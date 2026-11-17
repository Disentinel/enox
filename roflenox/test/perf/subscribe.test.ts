// A subscriber learns a changed conclusion in time proportional to the
// batch's delta, not to the relation (r_subscribe; npm run perf).
//
// red(P, X) holds N rows (N pages show a superseded version); one batch of
// one fact adds one more. Measured: the batch's admission, and the time from
// sending it to the delta frame arriving over SSE — against a fresh ask of
// the same literal, which is the cost of answering it whole. Then 100
// subscribers of the one literal: what the node holds for them, and one
// batch's frame to all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoflenoxNode } from '../../src/node.ts';
import { createServer, listen } from '../../src/http.ts';
import { LocalIdentity } from '../../src/identity.ts';
import type { Fact } from '../../src/facts.ts';
import type { Frame } from '../../src/subscribe.ts';
import { DAY, T0, tmpDir } from '../helpers.ts';

const SAMPLES = 5;
const median = (xs: number[]) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
const f = (source: string, relation: string, target: string, perspective = 'scanner'): Fact => ({ source, relation, target, perspective, confidence: 1 });
const RULES = [
  'stale(X) :- edge(F, Y, "supersedes", X).',
  'broken(P, X) :- edge(F, P, "shows", X), stale(X).',
  'accepted(P, X) :- edge(F, P, "accepts_stale", X).',
  'red(P, X) :- broken(P, X), not accepted(P, X).',
].map((r, i) => f(`r${i}`, 'roflenox:rule', r, 'invariant'));

/** An SSE reader: resolves `wait(k)` once k frames have come. */
async function stream(url: string, token: string): Promise<{ frames: { at: number; f: Frame }[]; wait(k: number, ms?: number): Promise<void>; close(): void }> {
  const ac = new AbortController();
  const res = await fetch(`${url}/subscribe?query=${encodeURIComponent('red(P, X)')}`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(res.status, 200);
  const frames: { at: number; f: Frame }[] = [];
  void (async () => {
    const rd = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const d = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (d) frames.push({ at: performance.now(), f: JSON.parse(d.slice(6)) as Frame });
        }
      }
    } catch { /* closed */ }
  })();
  return {
    frames,
    async wait(k, ms = 60_000) {
      const t0 = Date.now();
      while (frames.length < k) { if (Date.now() - t0 > ms) throw new Error(`frame ${k} not within ${ms} ms`); await new Promise((r) => setTimeout(r, 1)); }
    },
    close: () => ac.abort(),
  };
}

test('one fact\'s batch reaches a subscriber of a literal of N rows in time flat in N; 100 subscribers share one watch', async () => {
  const say = (l: string) => process.stdout.write(`${l}\n`);
  const latency: Record<number, number> = {};
  for (const N of [10, 10_000, 100_000]) {
    const dir = tmpDir(`perf-sub-${N}`);
    LocalIdentity.create(dir, 'home.node', new Date(T0 - DAY));
    const clock = { t: T0 };
    // The default rule budget (50 000 steps) stops these rules near 25 000 rows.
    const node = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t, ruleBudget: 10_000_000 });
    const server = createServer(node);
    const url = await listen(server, 0);
    try {
      await node.assertAsSelf(RULES);
      for (let i = 0; i < N; i += 20_000) {
        await node.assertAsSelf(Array.from({ length: Math.min(20_000, N - i) }, (_, j) => f(`page${i + j}`, 'shows', 'login@v1')));
      }
      await node.assertAsSelf([f('login@v2', 'supersedes', 'login@v1')]);
      const t0 = performance.now();
      const whole = await node.ask('red(P, X)', node.identity!.name);
      const askMs = performance.now() - t0;
      assert.equal(whole.rows.length, N, JSON.stringify(whole.unknown));
      const s = await stream(url, node.operatorToken());
      await s.wait(1);
      assert.equal(s.frames[0]!.f.rows!.length, N);
      const admit: number[] = [], toFrame: number[] = [];
      for (let k = 0; k < SAMPLES; k++) {
        const a = performance.now();
        await node.assertAsSelf([f(`new${k}`, 'shows', 'login@v1')]);
        admit.push(performance.now() - a);
        await s.wait(2 + k);
        const fr = s.frames[1 + k]!;
        assert.equal(fr.f.kind, 'delta');
        assert.deepEqual(fr.f.added!.map((r) => r.cells), [[`new${k}`, 'login@v1']]);
        assert.equal(fr.f.by, 'delta');
        toFrame.push(fr.at - a);
      }
      latency[N] = median(toFrame);
      say(`N=${N}: batch→SSE frame median ${median(toFrame).toFixed(1)} ms (admission ${median(admit).toFixed(1)} ms); a fresh ask of red(P, X) ${askMs.toFixed(1)} ms`);

      if (N === 10_000) {
        // 100 subscribers of the one literal, in the node itself (no HTTP, so
        // the heap measured is the node's): what they hold once their full
        // frames are sent, and one batch's frame to all of them.
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.(); gc?.();
        const before = process.memoryUsage().heapUsed;
        const got: number[] = [];
        const ends = [];
        for (let i = 0; i < 100; i++) ends.push(await node.subscribe('red(P, X)', node.identity!.name, (fr) => { if (fr.kind === 'delta') got.push(performance.now()); }));
        gc?.(); gc?.();
        const held = process.memoryUsage().heapUsed - before;
        const a = performance.now();
        await node.assertAsSelf([f('newer', 'shows', 'login@v1')]);
        assert.equal(got.length, 100);
        say(`100 subscribers of red(P, X) at N=${N}: node heap held after their full frames ${(held / 1024).toFixed(0)} KiB${gc ? '' : ' (no --expose-gc: not collected)'}, ${(held / 100 / 1024).toFixed(1)} KiB each; one batch to all 100 in ${(Math.max(...got) - a).toFixed(1)} ms`);
        for (const e of ends) await e();
      }
      s.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close();
    }
  }
  // Flat in N: four orders of magnitude of rows cost the frame well under one.
  assert.ok(latency[100_000]! < 10 * Math.max(latency[10]!, 5), `latency grew with N: ${JSON.stringify(latency)}`);
});
