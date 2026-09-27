#!/usr/bin/env node
// Spec gate for spec/enox.rofl.md. Zero dependencies, Node 22 built-ins only.
//
//   node spec/check.mjs [path/to/spec.rofl.md]
//
// Exits 0 only if every check passes, 1 if a check fails, 2 if ROFL_DIR is unset or not a
// rofl checkout; prints one line per check.
//
//   1. reader    ROFL reader report: unparsed (0), ambiguities (0), used with nowhere to link (0)
//   2. typing    r_typed: ROFL `? R is untyped` is empty, AND textually every requirement that
//                `says` has exactly one `is of` with a kind from the closed list
//   3. balance   r_balanced: restricting (security+reliability+constraint+gate) over enabling
//                (feature+model) lies in [2/3, 3/2], and no kind is empty.
//                ROFL has no count aggregate yet (rofl roadmap 1.1), so r_balanced is counted
//                here, in the script, from the textual `is of` facts — not by a ROFL rule.
//   4. links     plans (`is to be checked by "T"`) matching a test('T') in roflenox/test are
//                reported as linked, unlinked plans are reported only; every `"T" guards r` must
//                have a `"T" lives in "P"`, P must exist and contain a test named exactly T.
//   5. status    counts of ROFL `? R is ready`, `? R is unchecked`, `? R is underspecified`
//                (reported, never failed — unless the query itself errors).
//   6. cases     r_no_orphan_tests: the test files (roflenox/test/**, roflenox/executors/*/test,
//                spec/check.test.mjs) are read twice — by a static scanner, and by the runner
//                itself (spec/test-list: each file imported under a node:test shim that records
//                every test() the module makes) — and the two lists must agree, file by file;
//                a test() whose name is not a static string is unreadable. Every test case
//                guards a requirement (a `guards` fact, or a plan that names it), and every
//                ACCEPTED requirement has at least one verified `guards` fact.
//
// Env: ROFL_DIR   — required: a checkout of the rofl repo on origin/main (needs `npm run read`
//                   and `npm run repl`); there is no default
//      SPEC_ROOT  — repository root that guard paths and roflenox/test resolve against
//                   (default: the parent of this script's directory)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const KINDS = ['feature', 'model', 'security', 'reliability', 'constraint', 'gate'];
export const RESTRICTING = ['security', 'reliability', 'constraint', 'gate'];
export const ENABLING = ['feature', 'model'];

// ---------- textual parsing of the spec ----------

const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const unq = (s) => s.replace(/\\(.)/g, '$1');

// Fact lines of the spec, outside fenced code blocks, with their line numbers.
function factLines(src) {
  const out = [];
  let fenced = false;
  src.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (!fenced && line.startsWith('- ')) out.push({ n: i + 1, line: line.trimEnd() });
  });
  return out;
}

export function parseSpec(src) {
  const says = new Map();      // id -> first line number
  const kinds = new Map();     // id -> [{kind, n}]
  const badKindLines = [];     // `is of` lines not in the `r_x` is of `k`. form
  const plans = [];            // {id, text, n}
  const guards = [];           // {test, id, n}
  const lives = new Map();     // test -> [{file, n}]
  const accepted = new Set();  // ids with an `is accepted at` line
  for (const { n, line } of factLines(src)) {
    let m;
    if ((m = line.match(/^- `(\w+)` says /))) {
      if (!says.has(m[1])) says.set(m[1], n);
    } else if ((m = line.match(/^- `(\w+)` is of (.*)$/))) {
      const k = m[2].match(/^`(\w+)`\.?$/);
      if (!k) { badKindLines.push({ id: m[1], n, text: m[2] }); continue; }
      if (!kinds.has(m[1])) kinds.set(m[1], []);
      kinds.get(m[1]).push({ kind: k[1], n });
    } else if ((m = line.match(new RegExp(`^- \`(\\w+)\` is to be checked by ${STR}\\.?$`)))) {
      plans.push({ id: m[1], text: unq(m[2]), n });
    } else if ((m = line.match(new RegExp(`^- ${STR} guards \`(\\w+)\`\\.?$`)))) {
      guards.push({ test: unq(m[1]), id: m[2], n });
    } else if ((m = line.match(/^- `(\w+)` is accepted at /))) {
      accepted.add(m[1]);
    } else if ((m = line.match(new RegExp(`^- ${STR} lives in ${STR}\\.?$`)))) {
      const t = unq(m[1]);
      if (!lives.has(t)) lives.set(t, []);
      lives.get(t).push({ file: unq(m[2]), n });
    }
  }
  return { says, kinds, badKindLines, plans, guards, lives, accepted };
}

// ---------- test names in a test file ----------

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A JS string literal's content, unescaped as JS does (\uXXXX, \u{…}, \xXX, \n, \', …). */
export function jsUnescape(body) {
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return body.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|.)/gs, (_, all, cp, u4, x2) =>
    cp ? String.fromCodePoint(parseInt(cp, 16)) : u4 ? String.fromCharCode(parseInt(u4, 16)) : x2 ? String.fromCharCode(parseInt(x2, 16))
      : /^\r?\n$/.test(all) ? '' : simple[all] ?? all);
}

// Returns [{name, match(text) -> bool, template}] for test('...') / it('...') calls.
// A template literal with ${...} becomes a pattern where each substitution matches any text.
export function testNames(code) {
  const out = [];
  const re = /(?<![.\w])(?:test|it)(?:\.(?:only|skip|todo))?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[3] !== undefined && m[3].includes('${')) {
      const parts = m[3].split(/\$\{[^}]*\}/).map((p) => escRe(jsUnescape(p)));
      const rx = new RegExp(`^${parts.join('.+?')}$`, 's');
      out.push({ name: m[3], template: true, match: (t) => rx.test(t) });
    } else {
      const name = jsUnescape(m[1] ?? m[2] ?? m[3]);
      out.push({ name, template: false, match: (t) => t === name });
    }
  }
  return out;
}

// ---------- the test cases of the repository ----------

/** The test CASES of a file as the scanner reads them: test()/it() calls that
 *  open a line (a test() inside a string or an expression is code the file
 *  writes, not a case of its own). {name, template}: a template name with
 *  \${…} cannot be read statically. */
export function scanCases(code) {
  return testNames(code.split('\n').filter((l) => /^\s*(?:test|it)(?:\.(?:only|skip|todo))?\(/.test(l)).join('\n'))
    .map(({ name, template }) => ({ name, template }));
}

/** Every test file the gate knows of, relative to root, sorted. */
export function testFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'fixtures') walk(join(rel, e.name));
      else if (e.isFile() && /\.test\.(ts|mjs)$/.test(e.name)) out.push(join(rel, e.name));
    }
  };
  walk(join('roflenox', 'test'));
  const ex = join(root, 'roflenox', 'executors');
  if (existsSync(ex)) for (const d of readdirSync(ex)) walk(join('roflenox', 'executors', d, 'test'));
  if (existsSync(join(root, 'spec', 'check.test.mjs'))) out.push(join('spec', 'check.test.mjs'));
  return out.sort();
}

/** The runner's own list: {file: [names]} or {file: {error}} (spec/test-list). */
export function runnerList(root, files) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', join(HERE, 'test-list', 'register.mjs'),
    join(HERE, 'test-list', 'list.mjs'), ...files], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 << 20 });
  try { return JSON.parse(r.stdout); } catch { return { error: `the lister did not answer (exit ${r.status}): ${(r.stderr ?? '').split('\n')[0]}` }; }
}

// ---------- ROFL tooling ----------

// Each call gets a private TMPDIR: rofl's repl compiles X.rofl.md to $TMPDIR/rofl-md/X.rofl,
// keyed by basename only, so two concurrent runs on same-named files read each other's world.
function runRofl(roflDir, args, input) {
  const tmp = mkdtempSync(join(tmpdir(), 'spec-check-'));
  try {
    const stdout = execFileSync('npm', ['run', '-s', ...args.map((a) => (a.startsWith('$TMP/') ? join(tmp, a.slice(5)) : a))], {
      cwd: roflDir, input: input ?? '', encoding: 'utf8', timeout: 45_000,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, env: { ...process.env, TMPDIR: tmp },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, err: e.message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function readerReport(roflDir, specPath) {
  const r = runRofl(roflDir, ['read', '--', specPath, '--out', join('$TMP', 'out.rofl')]);
  {
    const num = (label) => {
      const m = r.out.match(new RegExp(`^${escRe(label)} \\((\\d+)\\):`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const section = (label) => {
      const m = r.out.match(new RegExp(`^${escRe(label)} \\(\\d+\\):[^\\n]*\\n((?:  .*\\n?)*)`, 'm'));
      return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : [];
    };
    return {
      code: r.code,
      unparsed: num('unparsed'), ambiguities: num('ambiguities'), nowhere: num('used with nowhere to link'),
      unparsedLines: section('unparsed'), raw: r.out,
    };
  }
}

// Runs queries in one REPL session. Returns [{query, rows:[string], error?}].
// "(empty)" is zero rows; anything that is neither a row nor "(empty)" is an error — an
// empty answer is only trusted when the REPL literally said "(empty)".
export function replAsk(roflDir, specPath, queries) {
  const r = runRofl(roflDir, ['repl', '--', specPath], queries.map((q) => `? ${q}\n`).join(''));
  const segs = r.out.split('rofl> ').slice(1);
  return queries.map((query, i) => {
    if (r.code !== 0) return { query, rows: [], error: `repl exited ${r.code}: ${r.err ?? ''}`.trim() };
    const seg = segs[i];
    if (seg === undefined) return { query, rows: [], error: 'no answer in repl output' };
    const lines = seg.split('\n').map((s) => s.trimEnd()).filter(Boolean);
    if (lines.length === 1 && lines[0] === '(empty)') return { query, rows: [] };
    if (lines.length === 0) return { query, rows: [], error: 'blank answer (neither rows nor "(empty)")' };
    const bad = lines.filter((l) => !/ {2}\[\w+ = [^\]]*\]$/.test(l));
    if (bad.length) return { query, rows: [], error: bad.join(' | ') };
    return { query, rows: lines };
  });
}

// ---------- the checks ----------

export function check(specPath, { roflDir, root } = {}) {
  roflDir = roflDir ?? process.env.ROFL_DIR;
  root = root ?? process.env.SPEC_ROOT ?? resolve(HERE, '..');
  const lines = [];
  const results = [];
  const record = (ok, head, details = []) => {
    results.push(ok);
    lines.push(`${ok ? 'PASS' : 'FAIL'} ${head}`);
    for (const d of details) lines.push(`     ${d}`);
  };

  if (!roflDir) {
    lines.push('FAIL rofl: ROFL_DIR is not set — set ROFL_DIR to a rofl checkout on origin/main, e.g. ROFL_DIR=~/src/rofl node spec/check.mjs');
    return { ok: false, lines, usage: true };
  }
  if (!existsSync(join(roflDir, 'package.json'))) {
    lines.push(`FAIL rofl: ROFL_DIR=${roflDir} is not a rofl checkout — set ROFL_DIR to a rofl checkout on origin/main`);
    return { ok: false, lines, usage: true };
  }
  const src = readFileSync(specPath, 'utf8');
  const spec = parseSpec(src);

  // 1. reader
  const rd = readerReport(roflDir, specPath);
  {
    const missing = ['unparsed', 'ambiguities', 'nowhere'].filter((k) => rd[k] === null);
    const ok = rd.code === 0 && missing.length === 0 && rd.unparsed === 0 && rd.ambiguities === 0 && rd.nowhere === 0;
    const det = [];
    if (rd.code !== 0) det.push(`reader exited ${rd.code}`);
    if (missing.length) det.push(`reader report lacks: ${missing.join(', ')} (tool output not understood, not a clean result)`);
    for (const u of rd.unparsedLines) det.push(`unparsed: ${u}`);
    record(ok, `1 reader: unparsed ${rd.unparsed}, ambiguities ${rd.ambiguities}, used with nowhere to link ${rd.nowhere}`, det);
  }

  // One REPL session for checks 2 and 5, bracketed by a positive control: `? R is of K` must
  // return exactly the kind facts the text has, before and after. An empty answer from a REPL
  // that never loaded the world looks the same as a clean one; the control tells them apart.
  const expectedKinds = new Set([...spec.kinds].flatMap(([id, ks]) => ks.map((k) => `${id}/${k.kind}`))).size;
  const [pre, untyped, ready, unchecked, underspec, post] = replAsk(roflDir, specPath,
    ['R is of K', 'R is untyped', 'R is ready', 'R is unchecked', 'R is underspecified', 'R is of K']);
  const controlBad = [pre, post].filter((c) => c.error || c.rows.length !== expectedKinds || expectedKinds === 0)
    .map((c) => `positive control ? R is of K: ${c.error ? `errored: ${c.error}` : `${c.rows.length} rows, text has ${expectedKinds}`} — ROFL answers not trusted`);

  // 2. typing
  {
    const det = [...controlBad];
    if (untyped.error) det.push(`ROFL ? R is untyped errored: ${untyped.error}`);
    for (const row of untyped.rows) det.push(`ROFL untyped: ${row.replace(/ {2}\[.*$/, '')}`);
    const textual = [];
    for (const [id, n] of spec.says) {
      const ks = spec.kinds.get(id) ?? [];
      if (ks.length === 0) textual.push(`${id} (line ${n}) has no \`is of\` line`);
      if (ks.length > 1) textual.push(`${id} has ${ks.length} \`is of\` lines (${ks.map((k) => `${k.kind}@${k.n}`).join(', ')})`);
      for (const k of ks) if (!KINDS.includes(k.kind)) textual.push(`${id} has unknown kind \`${k.kind}\` (line ${k.n})`);
    }
    for (const [id, ks] of spec.kinds) if (!spec.says.has(id)) textual.push(`${id} has a kind (line ${ks[0].n}) but no requirement says anything`);
    for (const b of spec.badKindLines) textual.push(`${b.id} \`is of\` line ${b.n} is not of the form \`kind\`: ${b.text}`);
    det.push(...textual.map((t) => `textual: ${t}`));
    const ok = controlBad.length === 0 && !untyped.error && untyped.rows.length === 0 && textual.length === 0;
    record(ok, `2 typing: ${spec.says.size} requirements, ROFL untyped ${untyped.error ? 'ERROR' : untyped.rows.length}, textual defects ${textual.length}`, det);
  }

  // 3. balance (computed here: ROFL has no count aggregate yet, rofl roadmap 1.1)
  {
    const count = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const [id, ks] of spec.kinds) if (spec.says.has(id) && ks.length === 1 && KINDS.includes(ks[0].kind)) count[ks[0].kind]++;
    const restricting = RESTRICTING.reduce((s, k) => s + count[k], 0);
    const enabling = ENABLING.reduce((s, k) => s + count[k], 0);
    const empty = KINDS.filter((k) => count[k] === 0);
    // 2/3 <= r/e <= 3/2, in integers: 2e <= 3r and 2r <= 3e
    const inBand = enabling > 0 && 2 * enabling <= 3 * restricting && 2 * restricting <= 3 * enabling;
    const ratio = enabling > 0 ? (restricting / enabling).toFixed(3) : 'inf';
    const det = [];
    if (!inBand) det.push(`ratio ${restricting}/${enabling} = ${ratio} is outside [0.667, 1.5]`);
    for (const k of empty) det.push(`kind ${k} is empty`);
    record(inBand && empty.length === 0,
      `3 balance: ${KINDS.map((k) => `${k} ${count[k]}`).join(', ')}; restricting ${restricting} / enabling ${enabling} = ${ratio} (band 0.667..1.5)`, det);
  }

  // 4. links
  {
    const det = [];
    const suite = testFiles(root).flatMap((f) => testNames(readFileSync(join(root, f), 'utf8')).map((t) => ({ ...t, file: f })));
    if (suite.length === 0) det.push(`no test names found under ${root} (cannot link anything)`);
    const linked = [], unlinked = [];
    for (const p of spec.plans) (suite.some((t) => t.match(p.text)) ? linked : unlinked).push(p);
    for (const p of unlinked) det.push(`unlinked plan (reported): ${p.id}: "${p.text}"`);

    const cache = new Map();
    const namesIn = (file) => {
      if (!cache.has(file)) {
        const abs = join(root, file);
        cache.set(file, existsSync(abs) ? testNames(readFileSync(abs, 'utf8')) : null);
      }
      return cache.get(file);
    };
    // Counted once per guard fact: a guard is verified when its requirement exists, it has at
    // least one `lives in`, and every file it lives in exists and has a test of exactly that name.
    let broken = 0, good = 0;
    for (const g of spec.guards) {
      const problems = [];
      const homes = [...new Set((spec.lives.get(g.test) ?? []).map((h) => h.file))];
      if (!spec.says.has(g.id)) problems.push(`guard line ${g.n} names unknown requirement ${g.id}`);
      if (homes.length === 0) problems.push(`guard line ${g.n} "${g.test}" has no \`lives in\` fact`);
      for (const file of homes) {
        const names = namesIn(file);
        if (names === null) problems.push(`"${g.test}" lives in "${file}" which does not exist (guard line ${g.n})`);
        else if (!names.some((t) => t.match(g.test))) problems.push(`"${g.test}" is not a test in "${file}" (guard line ${g.n}) — guard names a test that does not exist`);
      }
      if (problems.length) { broken++; det.push(...problems); } else good++;
    }
    record(broken === 0 && suite.length > 0,
      `4 links: plans ${spec.plans.length} (linked ${linked.length}, unlinked ${unlinked.length}); guards ${spec.guards.length} (verified ${good}, broken ${broken}); suite tests ${suite.length}`, det);
  }

  // 5. status
  {
    const errs = [ready, unchecked, underspec].filter((a) => a.error);
    record(errs.length === 0 && controlBad.length === 0,
      `5 status: ready ${ready.rows.length}, unchecked ${unchecked.rows.length}, underspecified ${underspec.rows.length} (control: ${pre.rows.length}/${post.rows.length} of ${expectedKinds} kind facts)`,
      [...controlBad, ...errs.map((a) => `ROFL ? ${a.query} errored: ${a.error}`)]);
  }

  // 6. cases
  {
    const det = [];
    const files = testFiles(root);
    const listed = runnerList(root, files);
    let unreadable = 0, runnerOnly = 0, scannerOnly = 0, orphans = 0, scanned = 0, ran = 0;
    // Linked by a guards fact whose test lives in this file — or, while its
    // requirement is in review (not yet accepted), by a planned check naming
    // it. Once accepted, a plan links nothing: it needs its own guards line.
    const guarded = (name, file) => spec.guards.some((g) => g.test === name && (spec.lives.get(name) ?? []).some((h) => h.file === file))
      || spec.plans.some((p) => p.text === name && !spec.accepted.has(p.id));
    if (listed.error) det.push(`runner list: ${listed.error}`);
    for (const f of files) {
      const found = scanCases(readFileSync(join(root, f), 'utf8'));
      for (const t of found.filter((x) => x.template)) { unreadable++; det.push(`${f}: test \`${t.name}\` has no static name (the scanner cannot read it; make it one static test with t.test subtests)`); }
      const statics = found.filter((x) => !x.template).map((x) => x.name);
      scanned += statics.length;
      const run = listed.error ? null : listed[f];
      if (run === undefined || run === null || !Array.isArray(run)) {
        det.push(`${f}: the runner could not list it${run?.error ? `: ${run.error}` : ''}`);
        runnerOnly++;
        continue;
      }
      ran += run.length;
      const left = [...statics];
      for (const n of run) {
        const i = left.indexOf(n);
        if (i >= 0) left.splice(i, 1);
        else { runnerOnly++; det.push(`${f}: the runner lists "${n}", the scanner does not`); }
      }
      for (const n of left) { scannerOnly++; det.push(`${f}: the scanner reads "${n}", the runner does not list it`); }
      for (const n of new Set(statics)) if (!guarded(n, f)) { orphans++; det.push(`orphan: "${n}" in ${f} guards no requirement`); }
    }
    // An accepted requirement: every one of its planned checks guarded, by an
    // existing test — and at least one guard at all.
    const exists = (test) => (spec.lives.get(test) ?? []).some((h) => existsSync(join(root, h.file))
      && testNames(readFileSync(join(root, h.file), 'utf8')).some((t) => t.match(test)));
    const guardedFor = (id, test) => spec.guards.some((g) => g.id === id && g.test === test) && exists(test);
    const unguarded = [];
    for (const id of spec.accepted) {
      const plans = spec.plans.filter((p) => p.id === id);
      for (const p of plans) if (!guardedFor(id, p.text)) unguarded.push(`accepted ${id}: planned check "${p.text}" is not guarded by an existing test`);
      if (!spec.guards.some((g) => g.id === id && exists(g.test))) unguarded.push(`accepted ${id} has no guard naming an existing test`);
    }
    det.push(...unguarded);
    record(!listed.error && unreadable + runnerOnly + scannerOnly + orphans + unguarded.length === 0 && scanned > 0,
      `6 cases: files ${files.length}, tests ${scanned} (runner ${ran}); unreadable ${unreadable}, runner-only ${runnerOnly}, scanner-only ${scannerOnly}, orphans ${orphans}, accepted unguarded ${unguarded.length}`, det);
  }

  return { ok: results.every(Boolean) && results.length === 6, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const specPath = resolve(process.argv[2] ?? join(HERE, 'enox.rofl.md'));
  const { ok, lines, usage } = check(specPath);
  for (const l of lines) console.log(l);
  console.log(`${ok ? 'OK' : 'FAILED'} ${specPath} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // 0 all checks pass, 1 a check failed, 2 the gate could not run (no usable ROFL_DIR)
  process.exit(ok ? 0 : usage ? 2 : 1);
}
