// One dependency, the ROFL engine, and a suite that needs neither the network nor a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

/** Every module specifier a source file imports that is neither a node
 *  built-in nor a relative path. */
function foreignImports(src: string): string[] {
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2]!);
  return specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.'));
}

test('package.json declares one dependency, the ROFL engine', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(pkg.dependencies as object), ['@grafema/rofl']);
  for (const k of ['devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[k], undefined, `package.json has ${k}`);
  }
  // And the code agrees with the manifest: nothing outside node:, this tree and the engine's port is imported.
  const files = ['src', 'test', 'scripts'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(ROOT, d, f)));
  assert.ok(files.length >= 10);
  for (const f of files) assert.deepEqual(foreignImports(fs.readFileSync(f, 'utf8')).filter((s) => s !== '@grafema/rofl/port'), [], f);
  // Positive control: the scanner does see a package import.
  assert.deepEqual(foreignImports("import x from 'lodash';\nimport { y } from './y.ts';\nconst z = await import('" + "left-pad');"), ['lodash', 'left-pad']);
});

// The whole-suite nested runs (no network, no force-exit, five in a row) are
// the hermetic5 gate's: test/hermetic5/hermetic5.test.ts.
