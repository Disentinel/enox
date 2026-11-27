// CODE (src/code.ts): the owner's questions over a directory of code, under the JS model and the owner's own rules,
// in ONE engine; after the load and after each edit, every question's published rows equal the whole world's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodeWorld } from '../src/code.ts';
import type { Fact } from '../src/facts.ts';
import { SOURCE, wholeWorld } from './pods-harness.ts';
import { tmpDir } from './helpers.ts';

const CORPUS: Record<string, string> = {
  'lib/a.ts': 'export function f() { return 1; }\nexport function g() { return 2; }\n',
  'lib/b.ts': "export * from './a';\nexport function hb() { return 3; }\n",
  'app/d.ts': "import { f } from '../lib/b';\nexport default function main() { return f(); }\n",
};

test('code: one engine keeps the owner\'s questions answered, its own rules over the JS model\'s, as files change', async () => {
  const root = tmpDir('code-corpus');
  for (const [f, t] of Object.entries(CORPUS)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  const rules = path.join(tmpDir('code-rules'), 'mine.rofl');
  fs.writeFileSync(rules, 'api(Name) :- exports_name[code](F, Name, "lib/b.ts").\n');
  // (what is published, as the node would hold it: a row comes at confidence 1 and goes at 0)
  const held = new Map<string, Map<string, string[]>>();
  const publish = async (facts: Fact[]) => {
    for (const f of facts) {
      if (f.relation === 'fkts:rule') continue;
      const [rel, at] = f.relation.slice('row:'.length).split('#');
      const rows = held.get(rel!) ?? new Map<string, string[]>();
      held.set(rel!, rows);
      const row = rows.get(f.source) ?? [];
      row[Number(at) - 1] = f.target;
      if (f.confidence > 0) rows.set(f.source, row); else rows.delete(f.source);
    }
  };
  const rows = (rel: string) => new Set([...(held.get(rel)?.values() ?? [])].map((r) => JSON.stringify(r)));
  const { world, published } = await CodeWorld.start(root, { asks: ['api(Name)', 'exports_name(F, Name, File)'], rules: [rules], publish, book: 'b_0000000000000000', source: SOURCE });
  try {
    assert.equal(world.pods.length, 0, 'one engine');
    assert.deepEqual(published.map((p) => p.by), ['anew', 'anew']);
    const check = async () => {
      assert.deepEqual(rows('exports_name'), (await wholeWorld(root)).rows);
      const names = [...rows('exports_name')].map((r) => JSON.parse(r) as string[]).filter((r) => r[2] === 'lib/b.ts').map((r) => JSON.stringify([r[1]]));
      assert.deepEqual(rows('api'), new Set(names));
    };
    await check();
    assert.ok(rows('api').has('["g"]'));

    fs.writeFileSync(path.join(root, 'lib/a.ts'), 'export function f() { return 1; }\nexport function h() { return 2; }\n');
    let e = await world.edit('lib/a.ts');
    assert.deepEqual(e.published.map((p) => p.by), ['levels', 'levels']);
    assert.equal(e.published[0]!.added, 1);
    assert.equal(e.published[0]!.removed, 1);
    await check();
    assert.ok(rows('api').has('["h"]') && !rows('api').has('["g"]'));

    fs.writeFileSync(path.join(root, 'lib/n.ts'), "export * from './b';\n");
    e = await world.edit('lib/n.ts');
    assert.deepEqual(e.published.map((p) => p.by), ['anew', 'anew']);
    await check();
  } finally { await world.close(); }
});
