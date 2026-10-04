// The owner's claude.ai retest of the deployed node, 2026-10-04: one name per
// edge, a live view, writes that answer what they wrote, a schema to learn the
// query language from, consistent errors and bounded reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { DAY, grant, identityAt, iso, post, start, T0, tmpDir, vouch, type Running } from './helpers.ts';

type Text = { text: string; isError: boolean };

/** Call an MCP tool on `a` as its operator (the owner, through claude.ai). */
function tools(a: Running) {
  let id = 0;
  return async (name: string, args: Record<string, unknown> = {}): Promise<Text> => {
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j = await r.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (j.error) return { text: j.error.message, isError: true };
    return { text: j.result!.content[0]!.text, isError: j.result!.isError === true };
  };
}
const json = <T>(t: Text): T => { assert.equal(t.isError, false, t.text); return JSON.parse(t.text) as T; };
type Rows = { vars: string[]; rows: { identity: string; cells: (string | number)[] }[]; note?: string };
const ask = async (a: Running, query: string, perspective?: string) =>
  (await post(a.url, '/ask', { query, ...(perspective ? { perspective } : {}) })).body as unknown as Rows;

test('update_assertion, delete_assertion and why accept either the Enox fact_id or the fact id ask returns, and add_assertion returns both', async () => {
  const a = await start(tmpDir('one-id'), 'node-a');
  try {
    const call = tools(a);
    type Added = { fact_id: string; edge_id: string; source: string; target: string };
    const ab = json<Added>(await call('add_assertion', { source: 'Alpha', target: 'Beta', relation: 'uses', context: 'c1' }));
    const bc = json<Added>(await call('add_assertion', { source: 'Beta', target: 'Gamma', relation: 'uses' }));
    // Both names, and each is what the other side calls the edge.
    const asked = await ask(a, `edge(F, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`);
    assert.deepEqual(asked.rows.map((r) => r.cells[0]), [ab.edge_id]);
    assert.deepEqual((await ask(a, `edge(G, ${JSON.stringify(ab.edge_id)}, "enox:fact_id", X)`)).rows.map((r) => r.cells[1]), [ab.fact_id]);
    assert.notEqual(ab.fact_id, ab.edge_id);

    // why, by either name: the same explanation of the same edge.
    const lit = (id: string) => `edge(${JSON.stringify(id)}, ${JSON.stringify(ab.source)}, "uses", ${JSON.stringify(ab.target)})`;
    const byF = json<{ holds: boolean; text: string }[]>(await call('why', { literal: lit(ab.edge_id) }));
    const byEnox = json<{ holds: boolean; text: string }[]>(await call('why', { literal: lit(ab.fact_id) }));
    assert.ok(byF.length > 0 && byF.every((e) => e.holds), JSON.stringify(byF));
    assert.deepEqual(byEnox, byF);
    // A reader with a grant names it by its Enox id too (asked of the engine, not the operator's view).
    const reader = identityAt(tmpDir('one-id-reader'), 'reader');
    await vouch(a, reader);
    await publish(a.url, a.me, [grant('reader', iso(T0 + DAY))], () => a.clock.t);
    const theirs = (await post(a.url, '/op/why', { literal: lit(ab.fact_id) }, { as: reader })).body as unknown as { identity: string; holds: boolean }[];
    assert.deepEqual(theirs.map((e) => [e.identity, e.holds]), [['node-a', true]], JSON.stringify(theirs));
    // ask too: the Enox id names the same fact.
    assert.deepEqual(((await post(a.url, '/op/ask', { query: `conf(${JSON.stringify(ab.fact_id)}, C)` })).body as unknown as Rows).rows.map((r) => r.cells), [[1000]]);

    // update_assertion by either name.
    const u1 = json<{ confidence: number; fact_id: string; edge_id: string }>(await call('update_assertion', { fact_id: ab.edge_id, confidence: 0.4 }));
    assert.deepEqual([u1.confidence, u1.fact_id, u1.edge_id], [0.4, ab.fact_id, ab.edge_id]);
    const u2 = json<{ confidence: number }>(await call('update_assertion', { fact_id: ab.fact_id, confidence: 0.3 }));
    assert.equal(u2.confidence, 0.3);
    assert.deepEqual((await ask(a, `conf(${JSON.stringify(ab.edge_id)}, C)`)).rows.map((r) => r.cells[0]), [300]);

    // delete_assertion by either name; the answer names both.
    const d1 = await call('delete_assertion', { fact_id: ab.edge_id });
    assert.equal(d1.text, `Deleted assertion ${ab.fact_id} (edge ${ab.edge_id})`);
    const d2 = await call('delete_assertion', { fact_id: bc.fact_id });
    assert.equal(d2.text, `Deleted assertion ${bc.fact_id} (edge ${bc.edge_id})`);
    for (const x of [ab, bc]) assert.deepEqual((await ask(a, `conf(${JSON.stringify(x.edge_id)}, C)`)).rows.map((r) => r.cells[0]), [0]);
    // An id that names nothing is still not found.
    assert.equal((await call('delete_assertion', { fact_id: 'f'.repeat(64) })).isError, true);
  } finally { await a.stop(); }
});
