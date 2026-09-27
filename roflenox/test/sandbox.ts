// The hermetic runner (not a test file): the suite, nested, with no network
// and no home. Shared by test/hermetic.test.ts and test/perf/hermetic.test.ts.
//
// The nested run gets an EMPTY home directory (so no cached model, no
// ~/.config, nothing the suite could lean on without saying so) and an
// environment of PATH, TMPDIR and ROFL_BIN only — no API keys, no proxies.
// The network is cut by the OS, loopback kept:
//   macOS: sandbox-exec denies every outbound connection except to localhost.
//   Linux: unshare --user --map-root-user --net puts the run in a fresh network
//          namespace whose only interface is lo (brought up with `ip`).
// No mechanism is a FAILURE, not a skip: a gate that quietly steps aside on the
// platform it is run on certifies nothing.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ROFL_BIN } from '../src/engine.ts';
import { tmpDir } from './helpers.ts';

export const ROOT = path.join(import.meta.dirname, '..');
const PROFILE = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';

export function isolated(args: string[], env: Record<string, string>, timeout = 100_000) {
  const node = process.execPath;
  if (process.platform === 'darwin') {
    return spawnSync('/usr/bin/sandbox-exec', ['-p', PROFILE, node, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout });
  }
  if (process.platform === 'linux') {
    return spawnSync('unshare', ['--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec "$@"', 'sh', node, ...args],
      { cwd: ROOT, env, encoding: 'utf8', timeout });
  }
  throw new Error(`no network isolation for ${process.platform}; this check cannot run here`);
}

export const sandboxEnv = (): Record<string, string> =>
  ({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: tmpDir('empty-home'), TMPDIR: tmpDir('sandbox-tmp'), ROFL_BIN: DEFAULT_ROFL_BIN });

/** Every test file but the hermetic ones. */
export const suiteFiles = () => fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts') && f !== 'hermetic.test.ts').map((f) => `test/${f}`);

/** Each failing test of a TAP run with its OWN error block, so a nested
 *  failure is read where it happened, not as a bare exit code. */
export function failures(tap: string): string {
  const out: string[] = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d+ - /.test(lines[i]!)) continue;
    out.push(lines[i]!.trim());
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]!) && j < i + 40; j++) out.push(`  ${lines[j]!.trim()}`);
  }
  return out.join('\n');
}

/** The engine binaries now orphaned (parent gone): a test process that died
 *  or exited leaving its engine behind. */
export function orphanEngines(): Set<string> {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return new Set(r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[1] === '1' && (c[2] ?? '').endsWith('rofl-serve')).map((c) => c[0]!));
}

export interface Nested { status: number | null; pass: number; fail: number; report: string; stderr: string; ms: number }

/** Run test files in the sandbox, WITHOUT --test-force-exit: a file that
 *  leaves a handle open never exits, and times out as a failure. */
export function nestedSuite(files: string[], env = sandboxEnv(), timeoutMs = 90_000): Nested {
  const t0 = Date.now();
  const r = isolated(['--experimental-strip-types', '--no-warnings', '--test', '--test-concurrency=2', '--test-timeout=60000', ...files], env, timeoutMs);
  return {
    status: r.status, stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}`, ms: Date.now() - t0,
    pass: Number(/# pass (\d+)/.exec(r.stdout ?? '')?.[1] ?? -1), fail: Number(/# fail (\d+)/.exec(r.stdout ?? '')?.[1] ?? -1),
    report: failures(r.stdout ?? ''),
  };
}
