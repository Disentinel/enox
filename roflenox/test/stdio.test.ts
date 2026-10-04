// One agent on one machine: MCP over stdio, then the same directory over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { LocalIdentity } from '../src/identity.ts';
import { isLocal, OPS } from '../src/ops.ts';
import { serveAsIs, tmpDir, type Clock } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

test('the same data directory answers the same over stdio and over HTTP', async () => {
  const dir = tmpDir('stdio');
  LocalIdentity.create(dir, 'solo');
  // --- over stdio: no server, no network ---
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'stdio', '--data', dir]);
  const replies = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (v: any) => void>();
  replies.on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  let id = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((ok) => {
    pending.set(++id, ok);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'roflenox');
  const names = ((await rpc('tools/list', {})).result.tools as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(names, OPS.filter((o) => o.unlisted === undefined).map((o) => o.name).sort(), 'over stdio every listed row, local ones included');
  const asserted = await rpc('tools/call', { name: 'assert', arguments: { facts: [
    { source: 'solo', relation: 'wrote', target: 'notes', perspective: 'local', confidence: 0.8 },
    { source: 'solo', relation: 'rule', target: 'x', perspective: 'local', confidence: 1 }] } });
  assert.equal(asserted.result.isError, undefined, JSON.stringify(asserted));
  const QUESTIONS: [string, Record<string, unknown>][] = [
    ['ask', { query: 'edge(F, "solo", R, T)' }], ['ask', { query: 'conf(F, C)' }], ['ask', { query: 'edge(F, S, R, T)', perspective: 'local' }],
  ];
  const overStdio: string[] = [];
  for (const [name, args] of QUESTIONS) overStdio.push((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  const fid = JSON.parse(overStdio[0]!).rows.find((r: { cells: string[] }) => r.cells[1] === 'wrote').cells[0];
  const whyStdio = (await rpc('tools/call', { name: 'why', arguments: { literal: `edge("${fid}", "solo", "wrote", "notes")` } })).result.content[0].text;
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));

  // --- the same directory, served over HTTP later ---
  const clock = { get t() { return Date.now(); }, set t(_v: number) { /* wall clock */ } } as Clock;
  const n = await serveAsIs(dir, clock);
  try {
    const token = n.node.operatorToken();
    const call = async (name: string, args: unknown) => ((await (await fetch(`${n.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()) as any).result.content[0].text as string;
    const overHttp: string[] = [];
    for (const [name, args] of QUESTIONS) overHttp.push(await call(name, args));
    assert.deepEqual(overHttp, overStdio);
    assert.equal(await call('why', { literal: `edge("${fid}", "solo", "wrote", "notes")` }), whyStdio);
    // ...and HTTP offers no local-only row.
    const listed = ((await (await fetch(`${n.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).json()) as any).result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(listed.sort(), OPS.filter((o) => !isLocal(o) && o.unlisted === undefined).map((o) => o.name).sort());
  } finally { await n.stop(); }
});
