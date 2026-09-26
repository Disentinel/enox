// Performance checks (npm run perf; the mutation gate runs them too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoflenoxNode } from '../../src/node.ts';
import { T0, tmpDir } from '../helpers.ts';
import { generateLog } from './gen.ts';

test('a node holding 200000 facts reopens from its log within 30 seconds', async (t) => {
  const dir = tmpDir('perf-200k');
  const tg = performance.now();
  const me = generateLog(dir, { facts: 200_000, batch: 2000, t0: T0 });
  const gen = performance.now() - tg;
  const t1 = performance.now();
  // A reopen that runs far past the bound is a failure, not a hang.
  const opening = RoflenoxNode.open({ dataDir: dir, now: () => T0 + 3_600_000 });
  const n = await Promise.race([opening, new Promise<null>((r) => setTimeout(() => r(null), 45_000).unref())]);
  const opened = (performance.now() - t1) / 1000;
  if (n === null) {
    void opening.then((x) => x.close(), () => {});
    assert.fail(`still reopening after ${opened.toFixed(0)} s`);
  }
  try {
    t.diagnostic(`generated in ${(gen / 1000).toFixed(1)} s; reopened in ${opened.toFixed(1)} s`);
    assert.ok(opened < 30, `reopened in ${opened.toFixed(1)} s`);
    // And it answers what it holds.
    const h = n.health() as { facts: number; batches: number };
    assert.equal(h.facts, 200_000);
    assert.equal(h.batches, 100);
    const one = await n.ask(`edge(F, "enox://example.org/graph/main/d${123455 % 111}/e123455", R, T)`, me.name);
    assert.equal(one.rows.length, 1);
  } finally { await n.close(); }
});
