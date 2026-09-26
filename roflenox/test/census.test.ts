// r_minimal_parts: one log, one engine, one wire format, one proof of who.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compare, scan, sources, type Allowed } from '../scripts/census.ts';

const ROOT = path.join(import.meta.dirname, '..');

test('a census of the source finds no second store, queue, wire format or proof of who', () => {
  const allowed = (JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'census.json'), 'utf8')) as { allowed: Allowed[] }).allowed;
  assert.ok(allowed.every((a) => a.why && a.why.length > 10), 'every allowed place says why');
  const found = scan(sources(ROOT));
  const { extra, stale } = compare(found, allowed);
  assert.deepEqual(extra, [], 'places that are not in the census');
  assert.deepEqual(stale, [], 'census entries no longer found');
  // The census can say no: one plant of each kind is found.
  const plants = scan({
    'src/plant-store.ts': "(await import('node:fs')).writeFileSync('cache.json', JSON.stringify(x));",
    'src/plant-queue.ts': 'setInterval(() => drain(jobs), 100);',
    'src/plant-wire.ts': "res.writeHead(200, { 'content-type': 'application/x-msgpack' });",
    'src/plant-who.ts': "if (req.headers['x-api-key'] !== KEY) throw new Error('no');",
  });
  assert.deepEqual([...new Set(plants.map((p) => p.kind))].sort(), ['queue', 'store', 'who', 'wire']);
  assert.equal(compare([...found, ...plants], allowed).extra.length, plants.length);
});
