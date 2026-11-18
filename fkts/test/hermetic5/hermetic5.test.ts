// The whole suite, nested, with no network and no model files, WITHOUT
// force-exit — and five times in a row, since a gate that flakes is switched
// off. Its own gate (npm run hermetic5), so npm test never runs the suite twice.
// The five runs are shared: the first one also answers the two checks below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpDir } from '../helpers.ts';
import { isolated, nestedSuite, orphanEngines, sandboxEnv, suiteFiles, type Nested } from '../sandbox.ts';

const runs: Nested[] = [];
/** The i-th nested run of the whole suite, made once. */
const nth = (i: number): Nested => (runs[i] ??= nestedSuite(suiteFiles()));
/** Engine processes already orphaned before any run here. */
const orphansBefore = orphanEngines();

test('the full test suite passes with no network and no model files', () => {
  // Positive control: the isolation really does refuse the network (TEST-NET-1,
  // a documentation address, so an unisolated run would not reach anyone).
  // macOS answers EPERM; an empty Linux namespace has no route: ENETUNREACH.
  const probe = isolated(['-e', `require('net').connect(80,'192.0.2.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(0)})`], sandboxEnv());
  assert.equal(probe.status, 0, `the isolation itself failed to start: ${probe.stderr}${probe.error ?? ''}`);
  assert.match(probe.stdout.trim(), /^(EPERM|ENETUNREACH)$/, `network probe inside isolation: ${probe.stdout}${probe.stderr}`);
  const r = nth(0);
  assert.equal(r.status, 0, `nested suite failed:\n${r.report}\n${r.stderr}`);
  assert.equal(r.fail, 0);
  assert.ok(r.pass >= 20, `the nested run actually ran the suite (pass ${r.pass})`);
});

test('every test file exits on its own without force-exit, leaving no engine process behind', () => {
  const r = nth(0);                                              // (run without --test-force-exit)
  assert.equal(r.status, 0, `a file did not finish on its own:\n${r.report}\n${r.stderr}`);
  const left = [...orphanEngines()].filter((p) => !orphansBefore.has(p));
  assert.deepEqual(left, [], 'engine processes left behind by the suite');
});

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
  const five = Array.from({ length: 5 }, (_, i) => nth(i));
  five.forEach((r, i) => assert.equal(r.status, 0, `run ${i + 1} of 5 failed after ${r.ms} ms:\n${r.report}\n${r.stderr}`));
  assert.ok(five.every((r) => r.fail === 0 && r.pass >= 20), five.map((r) => `${r.pass}/${r.fail}`).join(' '));
});
