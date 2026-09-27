// Tests for spec/check.mjs: the gate must be able to say NO.
// Each case copies the real spec, plants ONE defect, runs the gate CLI against the copy
// and expects a non-zero exit with the specific message. One case runs the real spec.
//
//   node --test spec/check.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, KINDS, RESTRICTING, ENABLING } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC = join(HERE, 'enox.rofl.md');
const CHECK = join(HERE, 'check.mjs');

// ROFL_DIR is required (a rofl checkout on origin/main); the gate has no default for it.
//   ROFL_DIR=~/src/rofl node --test spec/check.test.mjs
const ROFL_DIR = process.env.ROFL_DIR;

// ROFL_DIR is passed explicitly; env values of null remove the variable for the child.
function runCheck(specPath, env = {}) {
  return runCheckAt(specPath, ROOT, env);
}

function runCheckAt(specPath, root, env = {}) {
  const full = { ...process.env, SPEC_ROOT: root, ROFL_DIR, ...env };
  for (const k of Object.keys(full)) if (full[k] == null) delete full[k];
  return new Promise((res) => {
    execFile(process.execPath, [CHECK, specPath], {
      env: full, timeout: 60_000, maxBuffer: 16 << 20,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? -1) : 0, out: stdout + stderr }));
  });
}

async function withDefect(mutate) {
  const src = readFileSync(SPEC, 'utf8');
  const bad = mutate(src);
  assert.notEqual(bad, src, 'the planted defect changed nothing');
  const dir = mkdtempSync(join(tmpdir(), 'spec-defect-'));
  try {
    const p = join(dir, 'enox.rofl.md');
    writeFileSync(p, bad);
    return await runCheck(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A copy of the repository's tests and code (the executors' installed
// packages and models linked, not copied), with test files planted or
// changed, checked against a spec (the real one, or one changed by `mutate`).
async function withTree(plant, mutate = (x) => x) {
  const root = mkdtempSync(join(tmpdir(), 'spec-tree-'));
  try {
    const heavy = (p) => /[\\/](node_modules|\.models)$/.test(p);
    cpSync(join(ROOT, 'roflenox'), join(root, 'roflenox'), { recursive: true, filter: (p) => !heavy(p) });
    for (const ex of readdirSync(join(ROOT, 'roflenox', 'executors'))) {
      for (const h of ['node_modules', '.models']) {
        const from = join(ROOT, 'roflenox', 'executors', ex, h);
        if (existsSync(from)) symlinkSync(from, join(root, 'roflenox', 'executors', ex, h));
      }
    }
    mkdirSync(join(root, 'spec'));
    for (const f of ['check.test.mjs', 'check.mjs']) cpSync(join(HERE, f), join(root, 'spec', f));
    const text = mutate(readFileSync(SPEC, 'utf8'));
    // Every other file a guard lives in (outside roflenox), as it is.
    for (const homes of parseSpec(text).lives.values()) {
      for (const { file } of homes) {
        if (!existsSync(join(root, file)) && existsSync(join(ROOT, file))) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          cpSync(join(ROOT, file), join(root, file));
        }
      }
    }
    for (const [rel, body] of Object.entries(plant)) writeFileSync(join(root, rel), body);
    const spec = join(root, 'spec', 'enox.rofl.md');
    writeFileSync(spec, text);
    return await runCheckAt(spec, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The real spec's own gate run, shared: a planted defect must make things WORSE than this,
// otherwise a check that already fails on the real spec would "pass" a defect test for free.
let baselineRun;
const baseline = () => (baselineRun ??= runCheck(SPEC));
const brokenGuards = (out) => Number((checkLine(out, 4).match(/broken (\d+)\)/) ?? [])[1]);

const checkLine = (out, n) => out.split('\n').find((l) => new RegExp(`^(PASS|FAIL) ${n} `).test(l)) ?? '';

// Remove exactly one line matching re; fails loudly if the spec no longer has it.
function dropLine(src, re) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0, `spec has no line matching ${re}`);
  lines.splice(i, 1);
  return lines.join('\n');
}

// Insert after the first guard fact, inside the list the reader already accepts.
function afterFirstGuard(src, extra) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^- ".*" guards `\w+`\.$/.test(l));
  assert.ok(i >= 0, 'spec has no guard fact');
  lines.splice(i + 1, 0, ...extra);
  return lines.join('\n');
}

function counts(src) {
  const { says, kinds } = parseSpec(src);
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const [id, ks] of kinds) if (says.has(id) && ks.length === 1) c[ks[0].kind]++;
  return { c, r: RESTRICTING.reduce((s, k) => s + c[k], 0), e: ENABLING.reduce((s, k) => s + c[k], 0) };
}

// Flip `is of \`from\`` lines to `to` one by one until stop(r, e) holds.
function flipUntil(src, from, to, stop) {
  let out = src, flipped = 0;
  const re = new RegExp(`^(- \`\\w+\` is of )\`${from}\`(\\.?)$`, 'm');
  while (true) {
    const { r, e, c } = counts(out);
    if (stop(r, e)) return { out, flipped };
    assert.ok(c[from] > 1, `ran out of ${from} lines to flip (would empty the kind)`);
    out = out.replace(re, `$1\`${to}\`$2`);
    flipped++;
  }
}

describe('spec gate', { concurrency: true }, () => {
  test('ROFL_DIR is set for this test run', () => {
    assert.ok(ROFL_DIR, 'set ROFL_DIR to a rofl checkout on origin/main to run these tests');
  });

  test('without ROFL_DIR the gate fails and says where to point it', async () => {
    const { code, out } = await runCheck(SPEC, { ROFL_DIR: null });
    assert.equal(code, 2, out);
    assert.match(out, /set ROFL_DIR to a rofl checkout on origin\/main/);
    assert.doesNotMatch(out, /^PASS /m, 'no check may run without ROFL_DIR');
  });

  test('the real spec passes', async () => {
    const { code, out } = await baseline();
    assert.equal(code, 0, out);
    for (const n of [1, 2, 3, 4, 5, 6]) assert.match(checkLine(out, n), /^PASS /, out);
  });

  test('a requirement with its `is of` line removed fails typing, in ROFL and textually', async () => {
    const { code, out } = await withDefect((s) => dropLine(s, /^- `r_zero_deps` is of `\w+`\.$/));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 2), /^FAIL 2 typing: .* ROFL untyped 1, textual defects 1/, out);
    assert.match(out, /ROFL untyped: `r_zero_deps` is untyped/);
    assert.match(out, /textual: r_zero_deps \(line \d+\) has no `is of` line/);
  });

  test('a requirement with an unknown kind fails typing', async () => {
    const { code, out } = await withDefect((s) =>
      s.replace(/^- `r_zero_deps` is of `\w+`\.$/m, '- `r_zero_deps` is of `widget`.'));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 2), /^FAIL 2 typing/);
    assert.match(out, /textual: r_zero_deps has unknown kind `widget`/);
  });

  test('flipping features to security past 3/2 fails balance', async () => {
    let flipped = 0;
    const { code, out } = await withDefect((s) => {
      const f = flipUntil(s, 'feature', 'security', (r, e) => 2 * r > 3 * e);
      flipped = f.flipped;
      return f.out;
    });
    assert.ok(flipped > 0);
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 3), /^FAIL 3 balance/);
    assert.match(out, /ratio \d+\/\d+ = 1\.\d+ is outside \[0\.667, 1\.5\]/);
    assert.match(checkLine(out, 2), /^PASS 2 /, 'the flip must not look like a typing defect');
  });

  test('flipping security to features below 2/3 fails balance', async () => {
    const { code, out } = await withDefect((s) =>
      flipUntil(s, 'security', 'feature', (r, e) => 2 * e > 3 * r).out);
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 3), /^FAIL 3 balance/);
    assert.match(out, /ratio \d+\/\d+ = 0\.\d+ is outside \[0\.667, 1\.5\]/);
  });

  test('an empty kind fails balance', async () => {
    const { code, out } = await withDefect((s) => s.replace(/^(- `\w+` is of )`gate`/gm, '$1`constraint`'));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 3), /^FAIL 3 balance/);
    assert.match(out, /kind gate is empty/);
  });

  test('a guard naming a test that does not exist fails links', async () => {
    const ghost = 'a test nobody ever wrote zq7';
    const { code, out } = await withDefect((s) => afterFirstGuard(s, [
      `- "${ghost}" guards \`r_zero_deps\`.`,
      `- "${ghost}" lives in "roflenox/test/hermetic.test.ts".`,
    ]));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 4), /^FAIL 4 links/);
    assert.ok(out.includes(`"${ghost}" is not a test in "roflenox/test/hermetic.test.ts"`), out);
    assert.equal(brokenGuards(out), brokenGuards((await baseline()).out) + 1, out);
  });

  test('a guard with no `lives in` fact fails links', async () => {
    const ghost = 'a homeless check zq8';
    const { code, out } = await withDefect((s) => afterFirstGuard(s, [`- "${ghost}" guards \`r_zero_deps\`.`]));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 4), /^FAIL 4 links/);
    assert.ok(out.includes(`"${ghost}" has no \`lives in\` fact`), out);
    assert.equal(brokenGuards(out), brokenGuards((await baseline()).out) + 1, out);
  });

  // The REPL exits 0 and prints "error: ..." for a question it cannot read; that must
  // fail the gate, never be counted as rows or as an empty answer.
  test('a status question the spec cannot answer fails, not counted', async () => {
    const { code, out } = await withDefect((s) => dropLine(s, /^<a id="ready"><\/a>A requirement R is ready if /));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 5), /^FAIL 5 status: ready 0,/);
    assert.match(out, /ROFL \? R is ready errored: error: no sentence in the vocabulary reads: R is ready/);
  });

  // A REPL that never loaded the world answers "(empty)" to everything — which reads exactly
  // like a clean spec. The positive control (`? R is of K` before and after) must catch it.
  test('a REPL that answers empty to everything is not trusted', async () => {
    const fake = mkdtempSync(join(tmpdir(), 'fake-rofl-'));
    try {
      writeFileSync(join(fake, 'package.json'), JSON.stringify({
        name: 'fake-rofl', type: 'module', scripts: { read: 'node read.mjs', repl: 'node repl.mjs' },
      }));
      writeFileSync(join(fake, 'read.mjs'),
        "console.log('used with nowhere to link (0): \\nambiguities (0):\\n\\nunparsed (0):')");
      writeFileSync(join(fake, 'repl.mjs'), [
        "let n = 0; process.stdin.on('data', (d) => { n += String(d).split('\\n').filter(Boolean).length; });",
        "process.stdin.on('end', () => { process.stdout.write('rofl> (empty)\\n'.repeat(n) + 'rofl> '); });",
      ].join('\n'));
      const { code, out } = await runCheck(SPEC, { ROFL_DIR: fake });
      assert.notEqual(code, 0);
      assert.match(checkLine(out, 1), /^PASS 1 /, out);
      assert.match(checkLine(out, 2), /^FAIL 2 typing: .* ROFL untyped 0, textual defects 0/, out);
      assert.match(out, /positive control \? R is of K: 0 rows, text has \d+ — ROFL answers not trusted/);
      assert.match(checkLine(out, 5), /^FAIL 5 status: ready 0, unchecked 0, underspecified 0/);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test('a sentence the reader cannot parse fails the reader', async () => {
    const { code, out } = await withDefect((s) =>
      afterFirstGuard(s, ['- `r_typed` frobnicates wildly into the purple.']));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 1), /^FAIL 1 reader: unparsed 1,/);
    assert.match(out, /unparsed: .*`r_typed` frobnicates wildly into the purple/);
  });

  test('a test that guards no requirement fails the spec gate, and linking it passes', async () => {
    const orphan = { 'roflenox/test/zz-orphan.test.ts': "import { test } from 'node:test';\ntest('an orphan case zq9', () => {});\n" };
    const bad = await withTree(orphan);
    assert.notEqual(bad.code, 0);
    assert.match(checkLine(bad.out, 6), /^FAIL 6 cases: .* orphans 1,/, bad.out);
    assert.ok(bad.out.includes('orphan: "an orphan case zq9" in roflenox/test/zz-orphan.test.ts guards no requirement'), bad.out);
    // Linked by a guard that lives in that file: the same tree passes.
    const good = await withTree(orphan, (src) => afterFirstGuard(src, [
      '- "an orphan case zq9" guards `r_zero_deps`.', '- "an orphan case zq9" lives in "roflenox/test/zz-orphan.test.ts".']));
    assert.match(checkLine(good.out, 6), /^PASS 6 cases: .* orphans 0,/, good.out);
    assert.equal(good.code, 0, good.out);
  });

  test('a test the scanner cannot read, or one the runner lists and the scanner does not, fails the spec gate', async () => {
    const head = "import { test } from 'node:test';\n";
    // A generated name the scanner cannot read.
    const tpl = await withTree({ 'roflenox/test/zz-tpl.test.ts': `${head}for (const n of [1, 2]) {\n  test(\`generated case \${n}\`, () => {});\n}\n` });
    assert.notEqual(tpl.code, 0);
    assert.match(checkLine(tpl.out, 6), /^FAIL 6 cases: .* unreadable 1,/, tpl.out);
    assert.ok(tpl.out.includes('roflenox/test/zz-tpl.test.ts: test `generated case ${n}` has no static name'), tpl.out);
    // A name only the runner sees: the case exists, the scanner is blind to it.
    const hid = await withTree({ 'roflenox/test/zz-hidden.test.ts': `${head}const name = 'a hidden case zq10';\ntest(name, () => {});\n` });
    assert.notEqual(hid.code, 0);
    assert.match(checkLine(hid.out, 6), /^FAIL 6 cases: .* runner-only 1,/, hid.out);
    assert.ok(hid.out.includes('roflenox/test/zz-hidden.test.ts: the runner lists "a hidden case zq10", the scanner does not'), hid.out);
  });

  test('an accepted requirement whose checks guard no existing test fails the spec gate', async () => {
    // A requirement that says something but has no guard at all, marked accepted.
    const src = readFileSync(SPEC, 'utf8');
    const { says, guards } = parseSpec(src);
    const id = [...says.keys()].find((r) => !guards.some((g) => g.id === r));
    assert.ok(id, 'the spec has a requirement without guards to plant this on');
    const { code, out } = await withDefect((s) => afterFirstGuard(s, [`- \`${id}\` is accepted at "deadbeef".`]));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 6), /^FAIL 6 cases: .* accepted unguarded 1$/, out);
    assert.ok(out.includes(`accepted ${id} has no guard naming an existing test`), out);
  });
});
