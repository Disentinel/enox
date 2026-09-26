// Tests for spec/check.mjs: the gate must be able to say NO.
// Each case copies the real spec, plants ONE defect, runs the gate CLI against the copy
// and expects a non-zero exit with the specific message. One case runs the real spec.
//
//   node --test spec/check.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, KINDS, RESTRICTING, ENABLING } from './check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SPEC = join(HERE, 'enox.rofl.md');
const CHECK = join(HERE, 'check.mjs');

function runCheck(specPath) {
  return new Promise((res) => {
    execFile(process.execPath, [CHECK, specPath], {
      env: { ...process.env, SPEC_ROOT: ROOT }, timeout: 60_000, maxBuffer: 16 << 20,
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
  test('the real spec passes', async () => {
    const { code, out } = await runCheck(SPEC);
    assert.equal(code, 0, out);
    for (const n of [1, 2, 3, 4, 5]) assert.match(checkLine(out, n), /^PASS /, out);
  });

  test('a requirement with its `is of` line removed fails typing, in ROFL and textually', async () => {
    const { code, out } = await withDefect((s) => dropLine(s, /^- `r_zero_deps` is of `\w+`\.$/));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 2), /^FAIL 2 typing: .* ROFL untyped 1, textual defects 1/);
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
  });

  test('a guard with no `lives in` fact fails links', async () => {
    const ghost = 'a homeless check zq8';
    const { code, out } = await withDefect((s) => afterFirstGuard(s, [`- "${ghost}" guards \`r_zero_deps\`.`]));
    assert.notEqual(code, 0);
    assert.ok(out.includes(`"${ghost}" has no \`lives in\` fact`), out);
  });

  // The REPL exits 0 and prints "error: ..." for a question it cannot read; that must
  // fail the gate, never be counted as rows or as an empty answer.
  test('a status question the spec cannot answer fails, not counted', async () => {
    const { code, out } = await withDefect((s) => dropLine(s, /^<a id="ready"><\/a>A requirement R is ready if /));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 5), /^FAIL 5 status: ready 0,/);
    assert.match(out, /ROFL \? R is ready errored: error: no sentence in the vocabulary reads: R is ready/);
  });

  test('a sentence the reader cannot parse fails the reader', async () => {
    const { code, out } = await withDefect((s) =>
      afterFirstGuard(s, ['- `r_typed` frobnicates wildly into the purple.']));
    assert.notEqual(code, 0);
    assert.match(checkLine(out, 1), /^FAIL 1 reader: unparsed 1,/);
    assert.match(out, /unparsed: .*`r_typed` frobnicates wildly into the purple/);
  });
});
