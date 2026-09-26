// Executors (r_executors_off_read_path): work such as embedding runs in a
// SEPARATE process, never in the one that answers reads. The node derives
// intents with ROFL rules; an executor, under its own identity, pulls the
// intents it may see (GET /intents, signed), does the work, and publishes the
// results as ordinary signed batches into its OWN book through normal
// admission. A busy executor can only use its own CPU budget:
//
//   nice -n <n>      it yields to the node when they compete for a core
//   ulimit -t <sec>  the kernel stops it (SIGXCPU) when its CPU seconds run out
//
// Zero dependencies: the real embedder is a separate package speaking the
// same three calls (intents, publish, and its own identity).
import { spawn, type ChildProcess } from 'node:child_process';
import type { LocalIdentity } from './identity.ts';
import { publish } from './client.ts';
import { signRequest } from './httpsig.ts';

export interface Intent { identity: string; fact_id: string; text: string }

export interface ExecutorOptions {
  /** The node to pull from and publish to. */
  url: string;
  /** The executor's own data dir (its identity lives there). */
  dataDir: string;
  /** The script to run: a module that uses pullIntents/publishResults. */
  script: string;
  /** CPU seconds the executor may use before the kernel stops it. */
  cpuSeconds: number;
  /** Scheduling niceness (0–19); default 10. */
  nice?: number;
}

/** Start an executor as a separate, CPU-limited, lower-priority process. */
export function spawnExecutor(o: ExecutorOptions): ChildProcess {
  const cpu = Math.max(1, Math.floor(o.cpuSeconds));
  const argv = ['-n', String(o.nice ?? 10), '/bin/sh', '-c', `ulimit -t ${cpu}; exec "$0" "$@"`,
    process.execPath, '--experimental-strip-types', '--no-warnings', o.script];
  return spawn('nice', argv, { env: { ...process.env, ROFLENOX_URL: o.url, ROFLENOX_DATA: o.dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Intents this executor may work on (signed as the executor). */
export async function pullIntents(url: string, me: LocalIdentity, kind: string, limit = 100): Promise<Intent[]> {
  const u = `${url}/intents?kind=${encodeURIComponent(kind)}&limit=${limit}`;
  const res = await fetch(u, { headers: signRequest(me, 'GET', u, null, Date.now()) });
  if (!res.ok) throw new Error(`intents refused: ${res.status} ${await res.text()}`);
  return (await res.json()) as Intent[];
}

/** Publish embeddings as the executor's own facts: {source: fact_id,
 *  relation: "roflenox:embedding", target: <vector or digest>}. */
export async function publishEmbeddings(url: string, me: LocalIdentity, results: { fact_id: string; value: string }[]): Promise<void> {
  if (results.length === 0) return;
  await publish(url, me, results.map((r) => ({
    source: r.fact_id, relation: 'roflenox:embedding', target: r.value, perspective: 'executor', confidence: 1,
  })));
}
