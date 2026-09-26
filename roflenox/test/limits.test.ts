// Answers have a size limit, and saying so is part of the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { fact, post, start, tmpDir } from './helpers.ts';

test('an answer longer than the limit is marked cut and the rest is fetched page by page to the same total', async () => {
  const a = await start(tmpDir('limits'), 'node-a');
  try {
    await publish(a.url, a.me, Array.from({ length: 2500 }, (_, i) => fact(`s${i}`, 'r', `t${i}`)), () => a.clock.t);
    type Page = { vars: string[]; rows: { cells: string[] }[]; cut?: boolean; cursor?: string; total?: number };
    const ask = async (body: Record<string, unknown>) => (await post(a.url, '/ask', { query: 'edge(F, S, R, T)', ...body })).body as unknown as Page;

    // The default limit: 1000 rows, and it says it is cut.
    const first = await ask({});
    assert.equal(first.rows.length, 1000);
    assert.equal(first.cut, true);
    assert.equal(first.total, 2500);
    // Page by page to the same total, no row twice, the same rows as one big page.
    const all = [...first.rows];
    let cur = first.cursor;
    let pages = 1;
    while (cur) {
      const p = await ask({ cursor: cur });
      all.push(...p.rows);
      cur = p.cut ? p.cursor : undefined;
      pages++;
    }
    assert.equal(pages, 3);
    assert.equal(all.length, 2500);
    assert.equal(new Set(all.map((r) => r.cells[0])).size, 2500);
    const one = await ask({ limit: 5000 });
    assert.equal(one.cut, undefined, 'under the limit: not cut');
    assert.deepEqual(all, one.rows);
    // Over MCP too: the same parameter, the same mark.
    const mcp = await (await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { query: 'edge(F, S, R, T)', limit: 100 } } }) })).json() as { result: { content: { text: string }[] } };
    const m = JSON.parse(mcp.result.content[0]!.text) as Page;
    assert.equal(m.rows.length, 100);
    assert.equal(m.cut, true);
    // A cursor is for its question on its log: after a new batch it is refused.
    await publish(a.url, a.me, [fact('late', 'r', 'x')], () => a.clock.t);
    const stale = await post(a.url, '/ask', { query: 'edge(F, S, R, T)', cursor: first.cursor });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'cursor_stale');
    const other = await post(a.url, '/ask', { query: 'edge(F, S, "r", T)', cursor: (await ask({})).cursor });
    assert.equal(other.body.error, 'bad_cursor');
  } finally { await a.stop(); }
});
