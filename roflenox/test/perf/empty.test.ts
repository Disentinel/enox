// An empty answer's note on a book the size of the owner's (r_empty_explains):
// the names it offers come from what the node keeps, so a miss costs about
// what a hit does. Scanning the relation per miss took ~3 s here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { post, start, tmpDir, type Clock } from '../helpers.ts';
import { generateEnoxBook } from './gen.ts';

const wall = { get t() { return Date.now(); }, set t(_v: number) { /* the wall clock */ } } as Clock;

test('on an owner-sized book a misspelt relation and an unknown constant are answered with their note within one second', async (t) => {
  const dir = tmpDir('perf-empty');
  generateEnoxBook(dir, tmpDir('perf-empty-e'), { entities: 15_000, assertions: 19_700, t0: Date.now() - 3 * 86_400_000 });
  const a = await start(dir, 'owner', { clock: wall });
  try {
    const ask = async (query: string) => {
      const s = performance.now();
      const r = (await post(a.url, '/ask', { query, limit: 10 })).body as { rows: unknown[]; note?: string };
      return { ...r, ms: performance.now() - s };
    };
    const hit = await ask('edge(F, S, "implements", T)');
    assert.ok(hit.rows.length > 0, 'control: the relation holds rows');
    const times: string[] = [`hit ${hit.ms.toFixed(0)} ms`];
    for (const [query, note] of [
      ['edge(F, S, "implementz", T)', /no edge has "implementz" as its relation; the nearest that do: "implements"/],
      ['edge(F, "enox://nowhere/zz", R, T)', /no edge has "enox:\/\/nowhere\/zz" as its source; the nearest that do: /],
      ['edge(F, S, implements, T)', /implements is a bare word/],
      ['edge(F, S, R, "Entity 99999 nowhere")', /no edge has "Entity 99999 nowhere" as its target; the nearest that do: /],
    ] as [string, RegExp][]) {
      const r = await ask(query);
      assert.deepEqual(r.rows, [], query);
      assert.match(r.note ?? '', note, query);
      times.push(`${query} ${r.ms.toFixed(0)} ms`);
      assert.ok(r.ms < 1000, `${query}: answered with its note in ${r.ms.toFixed(0)} ms`);
    }
    // A miss that is the data's, not the question's: no note, and as cheap.
    const quiet = await ask('edge(F, "enox://example.org/graph/main/d0/entity_0", "implements", "enox://example.org/graph/main/d1/entity_1")');
    assert.equal(quiet.note, undefined);
    assert.ok(quiet.ms < 1000, `a quiet miss: ${quiet.ms.toFixed(0)} ms`);
    times.push(`quiet miss ${quiet.ms.toFixed(0)} ms`);
    t.diagnostic(times.join('; '));
  } finally { await a.stop(); }
});
