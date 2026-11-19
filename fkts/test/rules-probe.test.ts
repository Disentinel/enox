// RULE BATCHES BY DELTA, attacked from outside subscribe-rules.test.ts: one rule text under two names (one retired, the other stands), the rule read under not retired and restored, a batch retiring one rule and adding another with facts. Held to a fresh ask, to a node rebuilt from the log (test/helpers.ts, rebuilt) and to row counts fixed by hand: a fresh ask reads the same kept rule world, so alone it cannot see a fault of that world (MB2 passes it); the rebuilt node has no kept world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import type { Fact } from '../src/facts.ts';
import { fact, post, rebuilt, rowKeyOf, start, subscribe, tmpDir, type Running, type Stream } from './helpers.ts';

const TOY = path.join(import.meta.dirname, 'fixtures/invariants');
const toy = (f: string): Fact[] => fs.readFileSync(path.join(TOY, `${f}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Fact);
const rule = (name: string, text: string, confidence = 1): Fact => ({ source: name, relation: 'fkts:rule', target: text, perspective: 'invariant', confidence });
const subPath = (q: string) => `/subscribe?query=${encodeURIComponent(q)}`;

const EXPECT: Record<string, number> = { '0': 2, '1a': 3, '1b': 3, '2a': 2, '2b': 3, '2c': 2, '3': 2 };
const red: string[] = [];
async function check(name: string, n: Running, s: Stream, q: string) {
  let want: string[] = [], got: string[] = [];
  for (let i = 0; i < 30; i++) {
    try { await s.next(200); } catch { /* no frame within 200 ms */ }
    want = ((await post(n.url, '/ask', { query: q })).body.rows as { identity: string; cells: unknown[] }[]).map(rowKeyOf).sort();
    got = [...s.rows.keys()].sort();
    if (JSON.stringify(want) === JSON.stringify(got)) break;
  }
  const whole = (await rebuilt(n, q)).map(rowKeyOf).sort();
  const exp = EXPECT[name.split(' ')[0]!];
  const ok = JSON.stringify(want) === JSON.stringify(got) && JSON.stringify(whole) === JSON.stringify(got) && (exp === undefined || got.length === exp);
  console.log(`${ok ? 'ok ' : 'RED'} ${name}: ask ${want.length} rebuilt ${whole.length} stream ${got.length}${ok ? '' : ' ask=' + want.join(' ') + ' rebuilt=' + whole.join(' ') + ' got=' + got.join(' ')}`);
  if (!ok) red.push(name);
}

test('probe: twin rule texts, a retired rule under negation, a mixed batch', async () => {
  const n = await start(tmpDir('rprobe'), 'home.node');
  const pub = (f: Fact[]) => publish(n.url, n.me, f, () => n.clock.t);
  const q = 'red(P, X)';
  try {
    await pub([...toy('rules'), ...toy('scan'), ...toy('update')]);
    const s = await subscribe(n.url, subPath(q), { authorization: `Bearer ${n.node.operatorToken()}` });
    assert.equal(s.status, 200);
    await s.next();
    await check('0 start', n, s, q);
    // 1: the same rule text under two names; retiring one name must not stop the other.
    const T = 'red(P, X) :- edge(F, P, "bad", X).';
    await pub([rule('twinA', T), rule('twinB', T), fact('blog', 'bad', 'login@v1')]);
    await check('1a twin rules on', n, s, q);
    await pub([rule('twinA', T, 0)]);
    await check('1b one twin retired, the other still stands', n, s, q);
    const holds = [...s.rows.keys()].some((k) => k.includes('blog'));
    console.log(`${holds ? 'ok ' : 'RED'} 1c blog still red through twinB`); if (!holds) red.push('1c');
    // 2: retire the rule read under `not` (accepted): red widens; then back.
    const acc = toy('rules').find((f) => f.source === 'accepted')!;
    await pub([fact('home', 'accepts_stale', 'login@v1')]);
    await check('2a home accepted', n, s, q);
    await pub([{ ...acc, confidence: 0 }]);
    await check('2b accepted rule retired -> red widens', n, s, q);
    await pub([acc]);
    await check('2c accepted rule back -> narrows', n, s, q);
    // 3: one batch retires one rule, adds another and facts that only the new one reads.
    await pub([rule('twinB', T, 0), rule('third', 'red(P, X) :- edge(F, P, "worse", X).'), fact('wiki', 'worse', 'signup@v1'), fact('blog2', 'bad', 'x')]);
    await check('3 mixed batch: retire + new rule + facts', n, s, q);
    assert.deepEqual(red, [], 'every step held');
  } finally { await n.stop(); }
});
