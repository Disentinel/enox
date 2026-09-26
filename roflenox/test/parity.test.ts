// Interface parity (r_interface_parity): the three surfaces, each enumerated
// on its own — HTTP by probing, MCP by tools/list, CLI by --help and by trying
// every command word its source compares against — must equal the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isLocal, OPS } from '../src/ops.ts';
import { start, tmpDir } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const network = OPS.filter((o) => !isLocal(o));

function sources(): string {
  return fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
}

test('every operation in the table is reachable with the same name and schema over MCP, CLI and HTTP, and nothing outside the table is', async () => {
  const a = await start(tmpDir('parity'), 'node-a');
  try {
    // ---- HTTP: probe. A route exists unless the router itself says not_found.
    const probe = async (method: 'GET' | 'POST', p: string, body: unknown = {}) => {
      const r = await fetch(a.url + p, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
      const j = await r.json().catch(() => ({})) as { error?: string; message?: string };
      return { exists: !(r.status === 404 && j.error === 'not_found'), status: r.status, j };
    };
    for (const o of OPS) {
      const r = await probe('POST', `/op/${o.name}`);
      assert.equal(r.exists, !isLocal(o), `POST /op/${o.name} ${isLocal(o) ? 'must not' : 'must'} exist`);
    }
    // Candidates the table does not produce: every path-like literal in the source.
    const allowed: RegExp[] = [/^(GET|POST) \/mcp$/];
    for (const o of network) {
      allowed.push(new RegExp(`^POST /op/${o.name}$`));
      if (o.http) allowed.push(new RegExp(`^${o.http.method} ${o.http.path.replace(/[.]/g, '\\.').replace(/:[a-z]+/g, '[^/]+')}$`));
    }
    const literals = new Set([...sources().matchAll(/['"`](\/[a-z.][\w./:-]*)['"`]/g)].map((m) => m[1]!.replace(/:[a-z]+/g, 'x')));
    for (const o of OPS) literals.add(`/op/${o.name}`);
    literals.add('/op/not-an-operation');
    const found: string[] = [];
    for (const p of literals) {
      for (const m of ['GET', 'POST'] as const) {
        if ((await probe(m, p)).exists && !allowed.some((re) => re.test(`${m} ${p}`))) found.push(`${m} ${p}`);
      }
    }
    assert.deepEqual(found, [], 'routes that are not in the table');
    // The HTTP route enforces the op's own schema.
    for (const o of network) {
      const req = o.input.required ?? [];
      const r = await probe('POST', `/op/${o.name}`, req.length ? {} : { __probe: 1 });
      if (r.status === 401 || r.status === 403) continue;
      assert.equal(r.j.error, 'bad_args', `${o.name}: ${JSON.stringify(r.j)}`);
      assert.match(String(r.j.message), req.length ? new RegExp(`needs ${req[0]}`) : /takes no __probe/);
    }

    // ---- MCP: tools/list is the table (network surface), schema for schema.
    const rpc = async (method: string, params: unknown) => (await fetch(`${a.url}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json() as Promise<{ result?: { tools: { name: string; inputSchema: unknown }[] }; error?: { code: number } }>;
    const tools = (await rpc('tools/list', {})).result!.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), network.map((o) => o.name).sort());
    for (const t of tools) assert.deepEqual(t.inputSchema, OPS.find((o) => o.name === t.name)!.input, t.name);
    for (const o of OPS.filter(isLocal)) assert.equal((await rpc('tools/call', { name: o.name, arguments: {} })).error?.code, -32602, o.name);

    // ---- CLI: --help lists the table with the same flags...
    const help = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, '--help'], { encoding: 'utf8' }).stdout;
    const section = help.split('\noperations:\n')[1]!.split('\n\n')[0]!.split('\n');
    const listed = new Map(section.map((l) => {
      const m = /^ {2}([a-z_]+)((?: --[a-z_]+ <[a-z]+>)*)  — /.exec(l);
      assert.ok(m, `unreadable help line: ${l}`);
      return [m[1]!, [...m[2]!.matchAll(/--([a-z_]+) <([a-z]+)>/g)].map((x) => `${x[1]}:${x[2]}`)] as const;
    }));
    assert.deepEqual([...listed.keys()].sort(), OPS.map((o) => o.name).sort());
    for (const o of OPS) {
      assert.deepEqual(listed.get(o.name), Object.entries(o.input.properties).map(([k, p]) => `${k}:${p.type ?? 'json'}`), o.name);
    }
    // ...and every command word the CLI's source compares against is an
    // operation, a transport, or help — anything else must be refused.
    const words = new Set([...fs.readFileSync(CLI, 'utf8').matchAll(/(?:cmd\s*===\s*|case\s+)'([^']+)'/g)].map((m) => m[1]!));
    const known = new Set([...OPS.map((o) => o.name), 'serve', 'stdio', 'help', '--help']);
    for (const w of [...words].filter((x) => !known.has(x))) {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, w, '--data', tmpDir('parity-cli')], { encoding: 'utf8', timeout: 10_000 });
      assert.ok(r.status === 2 && /unknown operation/.test(r.stderr), `the CLI answers "${w}", which is not in the table`);
    }
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'not-an-operation'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  } finally { await a.stop(); }
});
