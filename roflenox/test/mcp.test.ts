// The MCP adapter: a thin JSON-RPC layer over the same admission and access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookOf } from '../src/identity.ts';
import { get, identityAt, post, start, tmpDir } from './helpers.ts';

test('an MCP client lists the tools, asserts a fact, and asks it back with why, all under the node\'s access rules', async () => {
  const a = await start(tmpDir('mcp'), 'node-a');
  const carol = identityAt(tmpDir('mcp-carol'), 'carol');
  try {
    const token = a.node.operatorToken();
    let id = 0;
    const rpc = async (method: string, params: unknown, auth: { bearer?: string; as?: typeof carol | null } = { bearer: token }) => {
      const body = { jsonrpc: '2.0', id: ++id, method, params };
      if (auth.bearer) {
        const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.bearer}` }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as Record<string, any> };
      }
      return post(a.url, '/mcp', body, { as: auth.as ?? null });
    };
    const tool = (r: { body: Record<string, any> }) => JSON.parse(r.body.result.content[0].text);

    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.body.result.protocolVersion, '2025-03-26');
    assert.ok(init.body.result.capabilities.tools);
    const note = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
    const list = await rpc('tools/list', {});
    const names = list.body.result.tools.map((t: { name: string }) => t.name) as string[];
    for (const n of ['ask', 'why', 'whynot', 'assert']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('recover') && !names.includes('init'), 'local-only operations are not offered over HTTP');

    // assert: a signed batch through normal admission, as the node's identity.
    const asserted = await rpc('tools/call', { name: 'assert', arguments: { facts: [
      { source: 'alice', relation: 'knows', target: 'bob', perspective: 'mcp', confidence: 0.8 }] } });
    assert.deepEqual(tool(asserted), { admitted: true, identity: 'node-a', facts: 1 });
    const feed = (await get(a.url, '/feeds/node-a')).body.batches as { manifest: { key_id: string; sig: string } }[];
    assert.equal(feed.length, 1);
    assert.equal(feed[0]!.manifest.key_id, a.me.keyId, 'signed by the node\'s key');

    // ask it back, and why.
    const rows = tool(await rpc('tools/call', { name: 'ask', arguments: { query: 'edge(F, S, R, T)' } })).rows as { identity: string; cells: string[] }[];
    assert.deepEqual(rows.map((r) => [r.identity, ...r.cells.slice(1)]), [['node-a', 'alice', 'knows', 'bob']]);
    const fid = rows[0]!.cells[0];
    const why = tool(await rpc('tools/call', { name: 'why', arguments: { literal: `edge("${fid}", "alice", "knows", "bob")` } })) as { holds: boolean; text: string }[];
    assert.deepEqual(why.map((w) => w.holds), [true]);
    assert.match(why[0]!.text, /\[axiom\]/);
    const byPersp = tool(await rpc('tools/call', { name: 'ask', arguments: { query: 'edge(F, S, R, T)', perspective: 'mcp' } }));
    assert.equal(byPersp.rows.length, 1);

    // The same access rules: carol (signed, no grant) sees nothing of node-a
    // and is refused a named book with the engine's whynot; nobody but the
    // operator asserts.
    assert.equal((await post(a.url, '/identities', carol.identityChain())).status, 200);
    const cAsk = await rpc('tools/call', { name: 'ask', arguments: { query: 'edge(F, S, R, T)' } }, { as: carol });
    assert.deepEqual(tool(cAsk).rows, []);
    const cBook = await rpc('tools/call', { name: 'ask', arguments: { query: `edge[${bookOf('node-a')}](F, S, R, T)` } }, { as: carol });
    assert.equal(cBook.body.result.isError, true);
    assert.equal(tool(cBook).error, 'no_grant');
    assert.match(tool(cBook).whynot, /failed premise: grant\[/);
    for (const who of [{ as: carol }, { as: null }]) {
      const r = await rpc('tools/call', { name: 'assert', arguments: { facts: [{ source: 'x', relation: 'y', target: 'z', perspective: 'p', confidence: 1 }] } }, who);
      assert.equal(tool(r).error, 'not_operator');
    }
    const bad = await rpc('tools/list', {}, { bearer: 'not-the-token' });
    assert.equal(bad.status, 401);
    assert.equal((await rpc('no/such', {})).body.error.code, -32601);
    assert.equal((await fetch(`${a.url}/mcp`)).status, 405);
    assert.equal((await get(a.url, '/health')).body.facts, 1, 'nothing else was admitted');
  } finally { await a.stop(); }
});
