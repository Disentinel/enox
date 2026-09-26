// Reproduce the rofl-serve panic (docs/engine-panic.md) on synthetic data:
// generate a log, then admit it batch by batch through Engine.stage — one fork,
// load, evaluate and close-of-the-old-session per batch — N times.
//
//   node --experimental-strip-types scripts/engine-panic-repro.ts [runs] [facts]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateLog } from '../test/perf/gen.ts';
import { bookRules, Engine } from '../src/engine.ts';
import { Log } from '../src/log.ts';
import { parseJsonl, toRofl } from '../src/facts.ts';
import { bookOf } from '../src/identity.ts';

const runs = Number(process.argv[2] ?? 3);
const size = Number(process.argv[3] ?? 160_000);
for (let run = 0; run < runs; run++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roflenox-panic-'));
  generateLog(dir, { facts: size, batch: 2000, t0: Date.parse('2026-09-26T12:00:00.000Z') });
  const log = new Log(dir);
  log.open();
  const e = await Engine.fresh();
  const t = performance.now();
  let i = 0;
  let err = '';
  try {
    for (const r of log.receipts) {
      const s = log.read(r);
      const st = await e.stage(toRofl(parseJsonl(s.jsonl!), bookOf(r.identity), i), r.identity, i === 0 ? bookRules(bookOf(r.identity), r.identity) : null);
      await st.commit();
      i++;
    }
  } catch (x) {
    err = (x as Error).message.split('\n')[0]!;
  }
  process.stdout.write(`${JSON.stringify({ run, batches: i, seconds: +((performance.now() - t) / 1000).toFixed(1), panic: err || null })}\n`);
  await e.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
