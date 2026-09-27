#!/usr/bin/env -S node --experimental-strip-types --no-warnings --max-old-space-size=1024
// roflenox — the CLI, GENERATED from the operation table (src/ops.ts):
//
//   roflenox <operation> [--<property> <value>]... [positional...]
//
// every operation is a subcommand and its flags are its schema's properties.
// Operations that are not local-only are sent to the node at --url as
// POST /op/<name>, signed as this machine's identity; local-only operations
// run here. Beside the operations there are two TRANSPORTS, which are ways to
// run a node, not operations:
//
//   roflenox serve [--port P] [--host H] [--public-url U] [--freshness S]
//                  [--checkpoint-window S] [--backup-to DIR --backup-every S]
//   roflenox stdio                             MCP over stdin/stdout, no server
//
// The recovery code printed ONCE when the identity is created is the only key
// material the CLI ever shows, and `recover` the only operation that takes
// any (r_recovery). --data DIR (ROFLENOX_DATA, default ~/.roflenox) is the
// data directory; --url U (ROFLENOX_URL, default http://127.0.0.1:7380) the node.
//
// The memory budget is declared on the #! line (and in `npm run roflenox`):
// the node's JavaScript heap is capped at 1 GB, so V8 collects instead of
// growing, and a node past it fails loudly rather than swelling. The engine
// is a separate process; together a node holding 200000 facts stays under
// 1.5 GB resident while idle (r_bounded_memory, test/perf/memory.test.ts).
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalIdentity } from './identity.ts';
import { RoflenoxNode } from './node.ts';
import { backup } from './backup.ts';
import { createServer, listen } from './http.ts';
import { httpCaller } from './client.ts';
import { callOp, createIdentity, isLocal, OP, OPS, type Op } from './ops.ts';
import { serveStdio } from './stdio.ts';

const GLOBAL = new Set(['data', 'url']);
const SERVE = ['port', 'host', 'public-url', 'freshness', 'checkpoint-window', 'backup-to', 'backup-every', 'name'];

function parse(argv: string[]): { pos: string[]; f: Record<string, string> } {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) f[a.slice(2)] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, f };
}

/** A flag's text as the value its schema property wants. */
function coerce(op: Op, key: string, v: string): unknown {
  const p = op.input.properties[key];
  if (!p) throw new Error(`${op.name} takes no --${key}`);
  if (p.type === 'string') return v;
  if (p.type === 'number') return Number(v);
  if (p.type === 'boolean') return v === 'true';
  try { return JSON.parse(v); } catch { return v; }
}

export function usage(): string {
  const lines = ['usage: roflenox <operation> [--flag value]... [--data DIR] [--url URL]', '', 'operations:'];
  for (const o of OPS) {
    const flags = Object.entries(o.input.properties).map(([k, p]) => ` --${k} <${p.type ?? 'json'}>`).join('');
    const where = isLocal(o) ? ` [local: ${(o.access as { local: string }).local}]` : '';
    lines.push(`  ${o.name}${flags}  — ${o.description}${where}`);
  }
  lines.push('', 'transports:', `  serve${SERVE.map((k) => ` [--${k}]`).join('')}`, '  stdio');
  return lines.join('\n');
}

async function serve(data: string, f: Record<string, string>): Promise<number> {
  if (!LocalIdentity.load(data)) createIdentity(data, f.name);
  const node = await RoflenoxNode.open({
    dataDir: data,
    freshnessSec: f.freshness ? Number(f.freshness) : undefined,
    publicUrl: f['public-url'] ?? process.env.ROFLENOX_PUBLIC_URL,
    checkpointWindowSec: f['checkpoint-window'] ? Number(f['checkpoint-window']) : undefined,
  });
  for (const r of node.log.recovered) process.stderr.write(`recovered: ${r}\n`);
  for (const w of node.warnings) process.stderr.write(`WARNING: ${w}\n`);
  const server = createServer(node);
  const at = await listen(server, Number(f.port ?? 7380), f.host ?? '127.0.0.1');
  process.stdout.write(`serving ${node.identity!.name} at ${at}\n`);
  if (f['backup-to']) {
    // A backup on a schedule (r_backup): at most one period of writes is lost.
    const every = Number(f['backup-every'] ?? 3600) * 1000;
    const run = () => backup(data, f['backup-to']!).then(
      (r) => process.stderr.write(`backup: ${r.receipts} receipts to ${r.dir}\n`),
      (e: Error) => process.stderr.write(`backup failed: ${e.message}\n`));
    void run();
    setInterval(run, every).unref();
  }
  const stop = async () => {
    server.close();
    await node.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return new Promise(() => {}); // runs until signalled
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, f } = parse(rest);
  const data = f.data ?? process.env.ROFLENOX_DATA ?? path.join(os.homedir(), '.roflenox');
  const url = (f.url ?? process.env.ROFLENOX_URL ?? 'http://127.0.0.1:7380').replace(/\/$/, '');
  if (cmd === undefined || cmd === '--help' || cmd === 'help') { process.stdout.write(`${usage()}\n`); return 0; }
  if (cmd === 'serve') return serve(data, f);
  if (cmd === 'stdio') return serveStdio(data);

  const op = OP.get(cmd);
  if (!op) { process.stderr.write(`roflenox: unknown operation ${cmd}\n${usage()}\n`); return 2; }
  if (f.help !== undefined || pos[0] === '--help') { process.stdout.write(`${usage()}\n`); return 0; }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (!GLOBAL.has(k)) args[k] = coerce(op, k, v);
  (op.positional ?? []).forEach((k, i) => { if (pos[i] !== undefined && args[k] === undefined) args[k] = coerce(op, k, pos[i]!); });

  const me = LocalIdentity.load(data) ?? undefined;
  const remote = httpCaller(url, me);
  const result = isLocal(op)
    ? await callOp(op.name, args, { node: null, caller: me?.name ?? null, dataDir: data, now: Date.now, call: remote }, 'local')
    : await remote(op.name, args);
  process.stdout.write(`${op.say ? op.say(result) : op.text ? op.text(result) : JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
  process.stderr.write(`roflenox: ${e.message}\n`);
  process.exit(1);
});
