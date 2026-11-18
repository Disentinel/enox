// An empty answer says why when the cause is in the question, and only then
// (r_empty_explains): the owner's session on 2026-10-03 got 0 rows, silently,
// for edge(F, S, supersedes, T), a misspelt relation, an unknown predicate
// and a perspective nothing was asserted under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../src/client.ts';
import { fact, post, start, tmpDir } from './helpers.ts';

type Answer = { rows: unknown[]; note?: string };

test('ask with an unquoted relation, a misspelt relation, an unknown predicate or an unknown perspective answers no rows with a note naming the cause and the nearest existing names', async () => {
  const a = await start(tmpDir('empty-note'), 'node-a');
  try {
    await publish(a.url, a.me, [fact('v2', 'supersedes', 'v1', 1, 'enox'), fact('v3', 'supersedes', 'v2', 1, 'enox'),
      fact('v3', 'contradicts', 'v1', 0.5, 'enox'), fact('v1', 'depends_on', 'lib', 1, 'enox')], () => a.clock.t);
    const ask = async (query: string, perspective?: string, as?: null) =>
      (await post(a.url, '/ask', { query, ...(perspective ? { perspective } : {}) }, as === null ? { as: null } : {})).body as Answer;

    // Control: the quoted form holds rows.
    assert.equal((await ask('edge(F, S, "supersedes", T)')).rows.length, 2);

    // A bare word: the note names the quoted form, which holds rows.
    const bare = await ask('edge(F, S, supersedes, T)');
    assert.deepEqual(bare.rows, []);
    assert.match(bare.note ?? '', /supersedes is a bare word/);
    assert.ok(bare.note!.includes('edge(F, S, "supersedes", T) has 2 rows'), bare.note);

    // A misspelt relation: named, with the nearest relations that occur.
    const typo = await ask('edge(F, S, "supersedez", T)');
    assert.deepEqual(typo.rows, []);
    assert.match(typo.note ?? '', /no edge has "supersedez" as its relation; the nearest that do: "supersedes"/);
    // A misspelt bare word is quoted for the search, and named the same way.
    assert.match((await ask('edge(F, S, supersedez, T)')).note ?? '', /no edge has "supersedez" as its relation; the nearest that do: "supersedes"/);
    // An entity that occurs nowhere as a source, with the nearest sources.
    assert.match((await ask('edge(F, "v4", R, T)')).note ?? '', /no edge has "v4" as its source; the nearest that do: "v1", "v2", "v3"/);

    // An unknown predicate: named, with the nearest predicates there are.
    const pred = await ask('edgee(F, S, R, T)');
    assert.deepEqual(pred.rows, []);
    assert.match(pred.note ?? '', /^no predicate edgee here; the nearest that exist: edge,/);
    // A known predicate with the wrong number of arguments.
    assert.match((await ask('edge(F, S, R)')).note ?? '', /edge takes 4 arguments, not 3/);

    // An unknown perspective: the perspectives that exist are listed …
    const persp = await ask('edge(F, S, R, T)', 'work');
    assert.deepEqual(persp.rows, []);
    assert.match(persp.note ?? '', /no fact is asserted under perspective "work"; the perspectives here: "enox"/);
    // … and a reader who may read none says that none do.
    const anon = await ask('edge(F, S, R, T)', 'work', null);
    assert.deepEqual(anon.rows, []);
    assert.match(anon.note ?? '', /under any perspective you may read, so none under "work"/);

    // The MCP tool answers the same note (the owner asked through claude.ai).
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { query: 'edge(F, S, supersedes, T)' } } }) });
    const mcp = JSON.parse(((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as Answer;
    assert.deepEqual(mcp.rows, []);
    assert.match(mcp.note ?? '', /supersedes is a bare word/);
    // And the tool says what a perspective is and that constants are quoted.
    const tools = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.node.operatorToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const askTool = ((await tools.json()) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[] } })
      .result.tools.find((t) => t.name === 'ask')!;
    assert.match(askTool.inputSchema.properties.perspective!.description ?? '', /"enox"/);
    assert.match(askTool.description, /quoted/);
  } finally { await a.stop(); }
});

test('ask whose question is well formed but matches nothing answers no rows and no note', async () => {
  const a = await start(tmpDir('empty-quiet'), 'node-a');
  try {
    await publish(a.url, a.me, [fact('v2', 'supersedes', 'v1', 1, 'enox'), fact('v3', 'contradicts', 'v1', 0.5, 'enox'),
      fact('v1', 'depends_on', 'lib', 1, 'home')], () => a.clock.t);
    const ask = async (query: string, perspective?: string) => (await post(a.url, '/ask', { query, ...(perspective ? { perspective } : {}) })).body as Answer;
    for (const [q, p] of [
      ['edge(F, "v2", "contradicts", T)', undefined],      // every constant occurs, the combination does not
      ['edge(F, "lib", R, "v1")', undefined],              // "lib" is a target, and "v1" a source too — just not together
      ['edge(F, "v2", "depends_on", T)', 'enox'],          // a perspective that exists, with no such fact under it nor under any
                                                           // (one held under ANOTHER perspective is noted: r_query_errors)
      ['edge(F, "v3", R, "lib")', 'enox'],
      ['conf(F, 1)', undefined],                           // a number that is not a confidence held
    ] as [string, string | undefined][]) {
      const r = await ask(q, p);
      assert.deepEqual(r.rows, [], q);
      assert.equal(r.note, undefined, `${q}${p ? ` under ${p}` : ''}: ${r.note}`);
    }
    // Control: the same node does note a question whose cause is in it.
    assert.ok((await ask('edge(F, S, "contradict", T)')).note);
  } finally { await a.stop(); }
});
