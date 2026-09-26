// MCP over stdio (r_local_stdio): one agent on one machine, no server, no
// network, no account. The node runs in this process on the data directory;
// JSON-RPC messages are read one per line from stdin and answered one per
// line on stdout (MCP's stdio framing). The caller is this machine's own
// identity — whoever can start this process holds its key file — and the
// surface is 'local', so local-only operations are offered too. The same data
// directory served over HTTP later is the same log; nothing converts.
import * as readline from 'node:readline';
import { RoflenoxNode } from './node.ts';
import { LocalIdentity } from './identity.ts';
import { handleRpc } from './mcp.ts';
import { callOp, createIdentity, type Ctx } from './ops.ts';

export async function serveStdio(dataDir: string, input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout): Promise<number> {
  if (!LocalIdentity.load(dataDir)) createIdentity(dataDir);
  const node = await RoflenoxNode.open({ dataDir });
  for (const w of node.warnings) process.stderr.write(`WARNING: ${w}\n`);
  const caller = node.identity?.name ?? null;
  const ctx: Ctx = { node, caller, dataDir, now: () => Date.now(), call: (op, args) => callOp(op, args, ctx, 'local') };
  const rl = readline.createInterface({ input });
  let pending = Promise.resolve();
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    // Answers go out in the order the requests came in.
    pending = pending.then(async () => {
      let reply: unknown;
      try {
        const msg = JSON.parse(line);
        const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map((m) => handleRpc(ctx, m, 'local')))).filter((r) => r !== null);
        reply = replies.length === 0 ? null : Array.isArray(msg) ? replies : replies[0];
      } catch (e) {
        reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: (e as Error).message } };
      }
      if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((r) => rl.once('close', () => r()));
  await pending;
  await node.close();
  return 0;
}
