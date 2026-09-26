// Executors (r_intent_loop, r_executors_off_read_path).
//
// An intent is a fact DERIVED by a rule — anyone's rule, in their own book:
//
//   intent(Key, Executor, Kind, Input) :- ...          (in the author's book)
//
// addressed to an executor by its identity NAME. The executor is an ordinary
// identity with its own process: it reads the intents addressed to it like any
// reader (a signed ask; the author grants it the book), does the work OUTSIDE
// the node, and publishes each result as an ordinary signed batch in its OWN
// book, citing the intent by key:
//
//   {source: Key, relation: "roflenox:result", target: Value}
//
// The node joins the two (answered[sys], engine.bookRules), so why of an
// answer crosses from the executor's result back to the rule that asked, and
// only the addressed executor's own book can answer.
//
// A busy executor can only use its own CPU budget: `nice` yields to the node,
// and `ulimit -t` has the kernel stop it (SIGXCPU) when its seconds run out.
import { spawn, type ChildProcess } from 'node:child_process';
import type { LocalIdentity } from './identity.ts';
import { ask, publish } from './client.ts';

export const RESULT = 'roflenox:result';

export interface Intent { author: string; key: string; kind: string; input: string | number }

export interface ExecutorOptions {
  url: string;
  /** The executor's own data dir (its identity lives there). */
  dataDir: string;
  script: string;
  cpuSeconds: number;
  nice?: number;
  env?: Record<string, string>;
}

/** Start an executor as a separate, CPU-limited, lower-priority process. */
export function spawnExecutor(o: ExecutorOptions): ChildProcess {
  const cpu = Math.max(1, Math.floor(o.cpuSeconds));
  const argv = ['-n', String(o.nice ?? 10), '/bin/sh', '-c', `ulimit -t ${cpu}; exec "$0" "$@"`,
    process.execPath, '--experimental-strip-types', '--no-warnings', o.script];
  return spawn('nice', argv, { env: { ...process.env, ...o.env, ROFLENOX_URL: o.url, ROFLENOX_DATA: o.dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The intents addressed to `me` that it has not answered yet — two asks,
 *  as any reader would make them. */
export async function pullIntents(url: string, me: LocalIdentity): Promise<Intent[]> {
  const q = await ask(url, { query: `intent(K, ${JSON.stringify(me.name)}, Kind, In)` }, me);
  const done = await ask(url, { query: `edge(F, K, ${JSON.stringify(RESULT)}, V)` }, me);
  const answered = new Set((done.rows as { identity: string; cells: string[] }[]).filter((r) => r.identity === me.name).map((r) => r.cells[1]));
  return (q.rows as { identity: string; cells: (string | number)[] }[])
    .filter((r) => !answered.has(String(r.cells[0])))
    .map((r) => ({ author: r.identity, key: String(r.cells[0]), kind: String(r.cells[1]), input: r.cells[2]! }));
}

/** Publish results, each citing its intent's key, into the executor's book. */
export async function publishResults(url: string, me: LocalIdentity, results: { key: string; value: string }[]): Promise<void> {
  if (results.length === 0) return;
  await publish(url, me, results.map((r) => ({ source: r.key, relation: RESULT, target: r.value, perspective: 'executor', confidence: 1 })));
}

/** THE FOLLOW EXECUTOR (r_follow): every `intervalMs`, the intents addressed
 *  to `me` of kind "follow" — one per followed publisher, derived from its
 *  roflenox:follow facts — are pulled with the same checks as a single mirror.
 *  Runs until `signal` aborts. A failing peer is reported and retried. */
export async function followLoop(local: import('./client.ts').OpCaller, me: LocalIdentity, intervalMs: number,
  signal: AbortSignal, log: (s: string) => void = () => {}): Promise<void> {
  const { mirrorVia } = await import('./client.ts');
  while (!signal.aborted) {
    const rows = ((await local('ask', { query: `intent(P, ${JSON.stringify(me.name)}, "follow", U)` })) as { rows: { cells: string[] }[] }).rows;
    for (const { cells: [publisher, peer] } of rows) {
      try {
        const r = await mirrorVia(local, String(peer), String(publisher), me);
        if (r.batches) log(`followed ${r.batches} batches of ${publisher}`);
      } catch (e) {
        log(`follow ${publisher} at ${peer}: ${(e as Error).message}`);
      }
    }
    await new Promise((r) => { const t = setTimeout(r, intervalMs); signal.addEventListener('abort', () => { clearTimeout(t); r(null); }, { once: true }); });
  }
}
