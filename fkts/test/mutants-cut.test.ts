// THE CUT OF THE MUTANT GATE (scripts/shard-cut.ts), on fixed costs. A shard runs its mutants one after another
// under a budget; the cut is planned by what each mutant cost last time. Measured 2026-11-18: four mutants of one
// file at ~21 s and a pods mutant at ~24 s in one shard ran 139 s against 120. The planted fault is mutant MS5 (the
// units taken in the order of their files, not heaviest first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cut, type Unit } from '../scripts/shard-cut.ts';

const one = (id: string, ms: number): Unit => ({ key: id, ids: [id], ms: [ms] });
const planned = (c: ReturnType<typeof cut>, of: Map<string, number>) => c.shards.map((s) => s.reduce((a, id) => a + of.get(id)!, 0));

test('mutant cut: two shards asked cannot hold 120 s of mutants under 45 s each; three are cut, heaviest first, each under it', () => {
  // Any cut of 120 s into the two shards asked has one of at least 60 s: over the cap of 45.
  const units = [one('a', 10), one('b', 10), one('c', 10), one('d', 10), one('e', 40), one('f', 40)];
  const of = new Map(units.map((u) => [u.ids[0]!, u.ms[0]!]));
  const c = cut(units, 2, 45);
  assert.equal(c.shards.length, 3, `${JSON.stringify(c.shards)}`);
  assert.deepEqual(planned(c, of), c.ms);
  assert.ok(c.ms.every((w) => w <= 45), `planned ${c.ms.join(' ')}`);
  assert.deepEqual(c.over, []);
  assert.deepEqual(c.shards.flat().sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('mutant cut: a file whose mutants weigh more than the cap is dealt out; one mutant over the cap is named', () => {
  const units: Unit[] = [{ key: 'rules', ids: ['MB1', 'MB2', 'MB3', 'MB4'], ms: [21, 21, 21, 21] }, one('P13', 24), one('M66', 1)];
  const c = cut(units, 1, 60);
  assert.ok(c.ms.every((w) => w <= 60), `planned ${c.ms.join(' ')}`);
  assert.ok(!c.shards.some((s) => ['MB1', 'MB2', 'MB3', 'MB4'].every((id) => s.includes(id))), 'the four are not kept together');
  const big = cut([one('slow', 70), one('a', 5)], 1, 60);
  assert.deepEqual(big.over, ['slow'], 'a mutant alone over the cap is named');
  assert.deepEqual(big.shards.flat().sort(), ['a', 'slow']);
});
