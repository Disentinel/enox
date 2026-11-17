// A batch that carries a RULE reaches a subscriber in time proportional to
// the rows the rule moves, not to the rule world (r_subscribe; npm run perf).
//
// red(P, X) holds N rows in the owner's rule world. Measured, from sending
// the batch to the frame over SSE: a rule added that widens red by one row,
// the same rule retired, and a grant given to another reader (a batch that
// moves access, and no row). Until 2026-11-18 each rebuilt the rule world
// whole and sent the answer whole.
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

test('a rule added, a rule retired, a grant given: the frame costs the rows that moved, flat in the rule world\'s N', async () => {
  const say = (l: string) => process.stdout.write(`${l}\n`);
  const cost: Record<number, number> = {};
  const by: Record<number, string[]> = {};
  for (const N of [10, 10_000, 100_000]) {
    const dir = tmpDir(`perf-subr-${N}`);
    LocalIdentity.create(dir, 'home.node', new Date(T0 - DAY));
    const clock = { t: T0 };
    const node = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t, ruleBudget: 10_000_000 });
    const server = createServer(node);
    const url = await listen(server, 0);
    try {
      await node.assertAsSelf(RULES);
      for (let i = 0; i < N; i += 20_000) {
        await node.assertAsSelf(Array.from({ length: Math.min(20_000, N - i) }, (_, j) => f(`page${i + j}`, 'shows', 'login@v1')));
      }
      await node.assertAsSelf([f('login@v2', 'supersedes', 'login@v1'), f('pinned', 'pins', 'login@v1')]);
      const s = await stream(url, node.operatorToken());
      await s.wait(1);
      assert.equal(s.frames[0]!.f.rows!.length, N);
      const widen = 'red(P, X) :- edge(F, P, "pins", X).';
      const steps: [string, Fact[]][] = [
        ['rule added', [f('widen', 'roflenox:rule', widen, 'invariant')]],
        ['rule retired', [{ ...f('widen', 'roflenox:rule', widen, 'invariant'), confidence: 0 }]],
        ['rule on again', [f('widen', 'roflenox:rule', widen, 'invariant')]],
      ];
      const kinds: string[] = [];
      const times: number[] = [];
      for (const [what, facts] of steps) {
        const k = s.frames.length;
        const a = performance.now();
        await node.assertAsSelf(facts);
        await s.wait(k + 1);
        const fr = s.frames[k]!;
        times.push(fr.at - a);
        kinds.push(`${fr.f.kind}/${fr.f.by ?? '-'}`);
        say(`N=${N}: ${what} → ${fr.f.kind} frame (by ${fr.f.by ?? '-'}, ${fr.f.kind === 'full' ? fr.f.rows!.length : fr.f.added!.length + fr.f.removed!.length} rows) in ${(fr.at - a).toFixed(1)} ms`);
      }
      const a = performance.now();
      await node.assertAsSelf([f('eve', 'roflenox:grant', new Date(T0 + DAY).toISOString(), 'access')]);
      const g = performance.now() - a;
      await new Promise((r) => setTimeout(r, 100));
      say(`N=${N}: a grant to another reader admitted in ${g.toFixed(1)} ms; frames after it: ${s.frames.length - 1 - steps.length}`);
      cost[N] = median(times);
      by[N] = kinds;
      const ask = performance.now();
      assert.equal((await node.ask('red(P, X)', node.identity!.name)).rows.length, N + 1);
      say(`N=${N}: a fresh ask of red(P, X) ${(performance.now() - ask).toFixed(1)} ms`);
      s.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close();
    }
  }
  for (const N of Object.keys(by)) assert.deepEqual(by[Number(N)], ['delta/delta', 'delta/delta', 'delta/delta'], `N=${N}: each by the engine's delta`);
  assert.ok(cost[100_000]! < 10 * Math.max(cost[10]!, 5), `a rule batch's frame grew with N: ${JSON.stringify(cost)}`);
});
