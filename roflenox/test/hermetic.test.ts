// Zero dependencies, and a suite that needs neither the network nor a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isolated, nestedSuite, orphanEngines, sandboxEnv, suiteFiles, type Nested } from './sandbox.ts';

const ROOT = path.join(import.meta.dirname, '..');

/** Every module specifier a source file imports that is neither a node
 *  built-in nor a relative path. */
function foreignImports(src: string): string[] {
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2]!);
  return specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.'));
}

test('package.json declares no dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[k], undefined, `package.json has ${k}`);
  }
  // And the code agrees with the manifest: nothing outside node: and this tree is imported.
  const files = ['src', 'vendor', 'test', 'scripts'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(ROOT, d, f)));
  assert.ok(files.length >= 10);
  for (const f of files) assert.deepEqual(foreignImports(fs.readFileSync(f, 'utf8')), [], f);
  // Positive control: the scanner does see a package import.
  assert.deepEqual(foreignImports("import x from 'lodash';\nimport { y } from './y.ts';\nconst z = await import('" + "left-pad');"), ['lodash', 'left-pad']);
});

let nested: Nested | null = null;
/** One nested run of the whole suite, shared by the checks below. */
const suite = (): Nested => (nested ??= nestedSuite(suiteFiles()));

test('the full test suite passes with no network and no model files', () => {
  const env = sandboxEnv();
  // Positive control: the isolation really does refuse the network (TEST-NET-1,
  // a documentation address, so an unisolated run would not reach anyone).
  // macOS answers EPERM; an empty Linux namespace has no route: ENETUNREACH.
  const probe = isolated(['-e', `require('net').connect(80,'192.0.2.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(0)})`], env);
  assert.equal(probe.status, 0, `the isolation itself failed to start: ${probe.stderr}${probe.error ?? ''}`);
  assert.match(probe.stdout.trim(), /^(EPERM|ENETUNREACH)$/, `network probe inside isolation: ${probe.stdout}${probe.stderr}`);

  const r = suite();
  assert.equal(r.status, 0, `nested suite failed:\n${r.report}\n${r.stderr}`);
  assert.equal(r.fail, 0);
  assert.ok(r.pass >= 20, `the nested run actually ran the suite (pass ${r.pass})`);
});

test('every test file exits on its own without force-exit, leaving no engine process behind', () => {
  const before = orphanEngines();
  const r = suite();                                             // (run without --test-force-exit)
  assert.equal(r.status, 0, `a file did not finish on its own:\n${r.report}\n${r.stderr}`);
  const left = [...orphanEngines()].filter((p) => !before.has(p));
  assert.deepEqual(left, [], 'engine processes left behind by the suite');
});
