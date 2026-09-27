// The hermetic suite, repeated: a gate that flakes is switched off, so it is
// run five times in a row here (npm run hermetic5, its own gate), and its
// failures must say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpDir } from '../helpers.ts';
import { nestedSuite, suiteFiles } from '../sandbox.ts';

test('the hermetic suite passes five runs in a row, and a nested failure prints the failing test\'s own error', () => {
  // First the failure path: a planted failing test's own message reaches the report.
  const planted = path.join(tmpDir('planted'), 'planted.test.ts');
  fs.writeFileSync(planted, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('a planted failure', () => { assert.equal(1, 2, 'planted-error-7f3a'); });\n");
  const bad = nestedSuite([planted]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.report, /not ok \d+ - a planted failure/);
  assert.match(bad.report, /planted-error-7f3a/, 'the nested failure carries its own error');
  // Then five whole runs, each green.
  const runs = Array.from({ length: 5 }, () => nestedSuite(suiteFiles()));
  runs.forEach((r, i) => assert.equal(r.status, 0, `run ${i + 1} of 5 failed after ${r.ms} ms:\n${r.report}\n${r.stderr}`));
  assert.ok(runs.every((r) => r.fail === 0 && r.pass >= 20), runs.map((r) => `${r.pass}/${r.fail}`).join(' '));
});
