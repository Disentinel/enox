// THE COST OF PODS on a real corpus (src/federation.ts, test/pods-harness.ts):
//
//   node --experimental-strip-types --no-warnings scripts/pods-cost.ts DIR [PODS] [--each]
//
// DIR is copied to a throwaway directory first (the run edits files). The
// files, in path order, are cut into the pods' blocks (whole leaves of the
// engine, as few pods as hold them). It prints, as one JSON object: the whole
// world (scan and evaluation in one engine: ms, engine RSS, facts, rows); the
// federation's start (ms until the subscriber equals the whole world, each
// pod's files and engine RSS, the root's); then edits of a file of pod 0 — one
// that moves only its own rows, one that adds a string (the core moves), a file
// added beside it (the listing moves) and, where the corpus has one, one that
// moves a conclusion about another pod's file — each with how the engines took
// it (levels or anew), the engines' and the publishing ms, the rows that came
// and went and the ms until the coordinator's subscriber is sent the frame. The
// subscriber is held to the whole world, row for row, at the end (with --each,
// after every step). Needs ROFL_BIN, a `rofl` with `volumes`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Federation, rssOf, wholeWorld } from '../test/pods-harness.ts';
import { filePrefix } from '../src/federation.ts';
import { tmpDir } from '../test/helpers.ts';

const each = process.argv.includes('--each');
const [src, n = '2'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!src) { console.error('usage: scripts/pods-cost.ts DIR [PODS]'); process.exit(1); }
const pods = Number(n);
const root = tmpDir('pods-cost');
fs.cpSync(src, root, { recursive: true });

const mb = (x: number) => Math.round(x);
const ms = (x: number) => Math.round(x);

const whole = await wholeWorld(root);
const out: Record<string, unknown> = { corpus: src, whole: { ms: ms(whole.ms), engine_mb: mb(whole.rss), facts: whole.facts, rows: whole.rows.size } };

const t0 = performance.now();
const started = await Federation.start(root, pods);
const f = started.fed;
try {
  await f.sub.next(100_000);
  const c0 = await f.converge(whole.rows, t0, 100_000);
  out.start = {
    ms_to_subscriber_equal: ms(c0.ms),
    engines_ms: ms(started.initial.pod.ms.engine), publish_ms: ms(started.initial.pod.ms.publish), published_rows: started.initial.pod.added,
    root_engine_mb: mb(rssOf(f.top.pid)),
    corpus_core_facts: f.core.size,
    pods: f.pods.map((p) => ({ files: p.files.length, engine_mb: mb(rssOf(p.engine.pid)) })),
  };

  // An edit of a file on pod 0 that adds an export: its own rows move.
  const local = f.pods[0]!.files.find((x) => !x.endsWith('.js')) ?? f.pods[0]!.files[0]!;
  const edits: unknown[] = [];
  const step = async (file: string, kind: string, change: (text: string) => string) => {
    const text = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : '';
    const e = await f.edit(file, change(text));
    // The frame the edit causes; with --each the whole world is asked again after it, else once at the end.
    // An edit whose rows net to nothing on the coordinator sends no frame: it is said, not waited for.
    const frame = await f.sub.next(15_000).catch(() => ({ added: [], removed: [], none: true }) as { added?: { cells: unknown[] }[]; removed?: { cells: unknown[] }[]; none?: boolean });
    const ms_ = frame.none ? NaN : performance.now() - e.t0;
    if (each) await f.converge((await wholeWorld(root)).rows, e.t0, 100_000);
    edits.push({ kind, file, by: e.pod.by, engines_ms: ms(e.pod.ms.engine), publish_ms: ms(e.pod.ms.publish), rows_published_added: e.pod.added, rows_published_removed: e.pod.removed,
      core_facts_moved: e.core, ms_to_frame: ms(ms_),
      frame: { added: frame.added?.length ?? 0, removed: frame.removed?.length ?? 0, about_other_pods_files: [...(frame.added ?? []), ...(frame.removed ?? [])].filter((r) => !(f.pods.find((p) => p.files.includes(file)) ?? f.pods[0]!).files.includes(String(r.cells[2]))).length } });
  };
  await step(local, 'local', (t) => `${t}\nexport function podsCostProbe() { return 0; }\n`);
  // Edits that move the core: a string no other file holds, and a file new to the listing beside the edited one.
  await step(local, 'core: a string added', (t) => `${t}\nexport const podsCostString = "pods-cost-probe";\n`);
  await step(path.join(path.dirname(local), 'podsCostNew.ts'), 'core: a file added', () => 'export function podsCostNew() { return 1; }\n');
  const podOf = new Map(f.pods.flatMap((p, i) => p.files.map((x) => [filePrefix(x), [x, i] as const])));
  // A function one pod's file declares and another pod's file offers: renaming it moves a conclusion about the other pod's file.
  const own = new Set<string>();
  const rows = [...f.rows()].map((r) => JSON.parse(r) as string[]);
  for (const [node, name, file] of rows) if (filePrefix(file!) === node!.slice(0, 18)) own.add(`${node}\0${name}`);
  let cross: { file: string; name: string } | undefined;
  let crossing = 0;
  for (const [node, name, file] of rows) {
    const from = podOf.get(node!.slice(0, 18));
    const to = podOf.get(filePrefix(file!));
    if (!from || !to || from[1] === to[1]) continue;
    crossing++;
    if (own.has(`${node}\0${name}`)) cross ??= { file: from[0], name: name! };
  }
  out.rows_across_pods = crossing;
  if (cross) await step(cross.file, `cross-file: function ${cross.name} renamed`, (t) => t.replace(new RegExp(`function ${cross.name}\\b`), `function ${cross.name}Renamed`));
  else edits.push({ kind: 'cross-file', none: 'no function one pod declares is offered by another pod\'s file in this corpus' });
  out.edits = edits;
  if (!each) {
    const w = await wholeWorld(root);
    await f.converge(w.rows, performance.now(), 100_000);
    out.oracle_at_end = { rows: w.rows.size, equal: true };
  }
  out.root_engine_mb_after = mb(rssOf(f.top.pid));
} finally { await f.close(); }
console.log(JSON.stringify(out, null, 1));
