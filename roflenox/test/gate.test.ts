// The mutation gate must itself be able to say NO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpDir } from './helpers.ts';

const GATE = path.join(import.meta.dirname, '..', 'scripts', 'mutants.ts');

function gate(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', GATE, ...args], { encoding: 'utf8', timeout: 100_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('the mutation gate fails when a listed mutant survives', () => {
  const extra = path.join(tmpDir('gate'), 'extra.json');
  fs.writeFileSync(extra, JSON.stringify({ mutants: [
    // Changes a comment: nothing can go red, so it must be reported as surviving.
    { id: 'NOOP', title: 'a comment changed', file: 'src/jcs.ts',
      edits: [['// RFC 8785 JSON Canonicalization Scheme.', '// RFC 8785 JSON Canonicalization Scheme!']],
      red: ['a batch with one byte changed is rejected'] },
    // Names code that is not there: a stale anchor must fail, not be skipped.
    { id: 'STALE', title: 'anchor gone', file: 'src/jcs.ts', edits: [['text that is nowhere in the file', 'x']],
      red: ['a batch with one byte changed is rejected'] },
  ] }));

  const survived = gate(['--only', 'NOOP,M2', '--extra', extra]);
  assert.equal(survived.status, 1, survived.out);
  assert.match(survived.out, /^SURVIVED NOOP a comment changed: still green: "a batch with one byte changed is rejected"$/m);
  assert.match(survived.out, /^killed {2}M2 /m, 'the real mutant beside it is still killed');

  const stale = gate(['--only', 'STALE', '--extra', extra]);
  assert.equal(stale.status, 1);
  assert.match(stale.out, /^ANCHOR {2}STALE /m);

  // Positive control: a real mutant alone passes the gate, and the tree is left as it was.
  const before = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'node.ts'), 'utf8');
  const clean = gate(['--only', 'M2']);
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /1\/1 mutants killed, 0 survivors by design, 0 failing; [\d.]+ s/);
  assert.equal(fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'node.ts'), 'utf8'), before);
});
