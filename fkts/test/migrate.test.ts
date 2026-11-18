// Migration from a node written before the rename (r_migrate_roflenox). The
// fixture test/fixtures/roflenox-v1 was written by the code at 2007bb6: an
// owner, two OAuth sessions, an owner rule and access facts, and a second
// identity (its key in helper/) writing a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { migrate } from '../scripts/migrate.ts';
import { FktsNode } from '../src/node.ts';
import { tmpDir } from './helpers.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'roflenox-v1');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8'));

function copy(): string {
  const d = tmpDir('migrate');
  fs.cpSync(FIXTURE, d, { recursive: true });
  for (const k of ['node/key/identity.json', 'node/key/operator-token', 'helper/key/identity.json', 'node/oauth/state.json']) fs.chmodSync(path.join(d, k), 0o600);
  return d;
}

test('an old node migrates into a fresh FKTS node: every batch signed again, the same facts under the new names, sessions renamed with their grants, the old directory untouched', async () => {
  const d = copy();
  const before = fs.readFileSync(path.join(d, 'node', 'log', 'index.jsonl'), 'utf8');
  const r = await migrate(path.join(d, 'node'), path.join(d, 'new'), [{ from: path.join(d, 'helper'), to: path.join(d, 'helper-new') }]);
  assert.equal(r.health.facts, expected.health.facts, 'as many facts as the old node held');
  assert.equal(r.batches, expected.health.batches);
  assert.equal(r.health.batches, expected.health.batches);
  assert.equal(fs.readFileSync(path.join(d, 'node', 'log', 'index.jsonl'), 'utf8'), before, 'the old log is only read');
  const renamed = Object.keys(r.identities);
  assert.equal(renamed.length, 2, 'both sessions renamed');
  assert.ok(renamed.includes(expected.session_a));
  const text = fs.readdirSync(path.join(d, 'new', 'log'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(d, 'new', 'log', String(f)), 'utf8')).join('');
  assert.doesNotMatch(text, /roflenox/);
  for (const old of renamed) assert.ok(!text.includes(old), `${old} is named nowhere`);
  assert.match(text, /"relation":"fkts:rule"/);

  const n = await FktsNode.open({ dataDir: path.join(d, 'new'), now: () => Date.parse('2026-09-27T12:00:00.000Z') });
  try {
    for (const [q, rows] of Object.entries(expected.answers as Record<string, [string, string[]][]>)) {
      const got = (await n.ask(q, 'node-a')).rows.map((x) => [x.identity, x.cells]);
      const want = rows.map(([id, cells]) => [r.identities[id] ?? id, cells]);
      assert.deepEqual(got.map((x) => JSON.stringify(x)).sort(), want.map((x) => JSON.stringify(x)).sort(), q);
    }
    const grants = n.oauth.grants().map((g) => n.sessionName(g.grant)).sort();
    assert.deepEqual(grants, Object.values(r.identities).sort(), 'each grant writes as its migrated session');
    assert.equal(n.identity!.name, 'node-a');
  } finally { await n.close(); }
});

test('a migration that meets a batch it cannot sign again writes nothing', async () => {
  const d = copy();
  await assert.rejects(migrate(path.join(d, 'node'), path.join(d, 'new')), /helper\.example\.org: no key for it here/);
  assert.equal(fs.existsSync(path.join(d, 'new')), false);
  assert.deepEqual(fs.readdirSync(d).sort(), ['expected.json', 'helper', 'node']);
});
