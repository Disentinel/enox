// Zero dependencies, and a suite that needs neither the network nor a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ROFL_BIN } from '../src/engine.ts';
import { tmpDir } from './helpers.ts';

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

// The nested run gets an EMPTY home directory (so no cached model, no
// ~/.config, nothing the suite could lean on without saying so) and an
// environment of PATH, TMPDIR and ROFL_BIN only — no API keys, no proxies.
// The network is cut by the OS, loopback kept:
//   macOS: sandbox-exec denies every outbound connection except to localhost.
//   Linux: unshare --user --map-root-user --net puts the run in a fresh network
//          namespace whose only interface is lo (brought up with `ip`).
// No mechanism is a FAILURE, not a skip: a gate that quietly steps aside on the
// platform it is run on certifies nothing.
const PROFILE = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';

function isolated(args: string[], env: Record<string, string>) {
  const node = process.execPath;
  if (process.platform === 'darwin') {
    return spawnSync('/usr/bin/sandbox-exec', ['-p', PROFILE, node, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 100_000 });
  }
  if (process.platform === 'linux') {
    return spawnSync('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec "$@"', 'sh', node, ...args],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 100_000 });
  }
  throw new Error(`no network isolation for ${process.platform}; this check cannot run here`);
}

test('the full test suite passes with no network and no model files', () => {
  const home = tmpDir('empty-home');
  const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: home, TMPDIR: tmpDir('sandbox-tmp'), ROFL_BIN: DEFAULT_ROFL_BIN };
  const inSandbox = (args: string[]) => isolated(args, env);

  // Positive control: the isolation really does refuse the network (TEST-NET-1,
  // a documentation address, so an unisolated run would not reach anyone).
  // macOS answers EPERM; an empty Linux namespace has no route: ENETUNREACH.
  const probe = inSandbox(['-e', `require('net').connect(80,'192.0.2.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)}).setTimeout(3000,()=>{console.log('TIMEOUT');process.exit(0)})`]);
  assert.equal(probe.status, 0, `the isolation itself failed to start: ${probe.stderr}${probe.error ?? ''}`);
  assert.match(probe.stdout.trim(), /^(EPERM|ENETUNREACH)$/, `network probe inside isolation: ${probe.stdout}${probe.stderr}`);

  const others = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts') && f !== 'hermetic.test.ts').map((f) => `test/${f}`);
  const r = inSandbox(['--experimental-strip-types', '--no-warnings', '--test', '--test-concurrency=4', '--test-timeout=110000', '--test-force-exit', ...others]);
  const pass = Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? -1);
  const fail = Number(/# fail (\d+)/.exec(r.stdout)?.[1] ?? -1);
  assert.equal(r.status, 0, `nested suite failed:\n${r.stdout.split('\n').filter((l) => /^not ok|# (pass|fail)/.test(l)).join('\n')}\n${r.stderr}`);
  assert.equal(fail, 0);
  assert.ok(pass >= 20, `the nested run actually ran the suite (pass ${pass})`);
});
