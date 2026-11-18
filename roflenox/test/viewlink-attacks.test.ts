// The browser path of a view (src/http.ts, src/view.ts, src/viewlink.ts)
// under attack: each test is a reproduction of the security review of
// 2026-11-18, kept as a regression. Needs a `rofl` engine with `watch` (ROFL_BIN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vm from 'node:vm';
import { httpCaller, publish, publishVia } from '../src/client.ts';
import { bookOf, docHash, signDoc, type LocalIdentity } from '../src/identity.ts';
import type { Fact } from '../src/facts.ts';
import { callOp } from '../src/ops.ts';
import { VIEW_PAGE } from '../src/view.ts';
import { exportRule, identityAt, oracle, post, start, subscribe, tmpDir, vouch, type Running, type Stream } from './helpers.ts';

const VIEW = '/view/home.node/shown';
const withLink = (t: string) => ({ authorization: `RoflenoxView ${t}` });
const pubAs = (n: Running, who: LocalIdentity, facts: Fact[]) => publish(n.url, who, facts, () => n.clock.t);
const shows = (s: string, t: string): Fact => ({ source: s, relation: 'shows', target: t, perspective: 'p', confidence: 1 });
const view = (name: string, literal: string): Fact => ({ source: name, relation: 'roflenox:view', target: literal, perspective: 'view', confidence: 1 });

/** A node home.node with eve vouched, eve allowed its "shows" facts and its views, and the view `shown` of them. */
async function home(tag: string): Promise<{ n: Running; eve: LocalIdentity; eveDir: string }> {
  const n = await start(tmpDir(tag), 'home.node');
  const eveDir = tmpDir(`${tag}-eve`);
  const eve = identityAt(eveDir, 'eve');
  await vouch(n, eve);
  await pubAs(n, n.me, [shows('a', 'x'), exportRule('shows', 'eve'), exportRule('roflenox:view', 'eve'), view('shown', 'edge(F, S, "shows", T)')]);
  // eve's book exists before any race below: her first batch moves her scope.
  await pubAs(n, eve, [{ source: 'eve-diary', relation: 'secret', target: 'PRIVATE-123', perspective: 'p', confidence: 1 }]);
  return { n, eve, eveDir };
}

/** A link as the CLI mints it on eve's machine (roflenox view_link home.node <name>). */
async function mint(n: Running, eve: LocalIdentity, eveDir: string, name = 'shown', o: { url?: string; aud?: string; call?: (op: string, args?: Record<string, unknown>) => Promise<unknown> } = {}): Promise<{ token: string; jti: string; link: string }> {
  const r = await callOp('view_link', { owner: 'home.node', name, ttl: 600, ...(o.aud ? { aud: o.aud } : {}) }, {
    node: null, caller: 'eve', dataDir: eveDir, now: () => n.clock.t, url: o.url ?? n.url,
    call: o.call ?? (async (op: string, args?: Record<string, unknown>) => (await post(n.url, `/op/${op}`, args ?? {}, { as: eve })).body),
  } as never, 'local') as { link: string; jti: string };
  return { ...r, token: r.link.slice(r.link.indexOf('#link=') + 6) };
}

/** The next refused frame within `ms`, or null; other frames are read past. */
async function refusedWithin(s: Stream, ms: number): Promise<Record<string, unknown> | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let f;
    try { f = await s.next(Math.max(1, ms - (Date.now() - t0))); } catch { return null; }
    if (f.kind === 'refused') return f as unknown as Record<string, unknown>;
  }
  return null;
}

/** A GET with the request line exactly as given (fetch would normalise it). */
function rawGet(url: string, p: string, accept = 'text/html'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const u = new URL(url);
  return new Promise((ok, no) => {
    const req = http.request({ host: u.hostname, port: u.port, method: 'GET', path: p, headers: { accept } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => ok({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', no);
    req.end();
  });
}

test('a request path that is not one single-slash absolute path is refused: the view page is never served under //host', async () => {
  const n = await start(tmpDir('vla-path'), 'home.node');
  try {
    await pubAs(n, n.me, [view('shown', 'edge(F, S, "shows", T)')]);
    const ok = await rawGet(n.url, VIEW);
    assert.equal(ok.status, 200, 'the genuine path serves the page');
    for (const p of ['//evil.example/view/home.node/shown', '/\\evil.example/view/home.node/shown', '/x/../view/home.node/shown',
      '/view/home.node/./shown', '/x/%2e%2e/view/home.node/shown', 'http://evil.example/view/home.node/shown']) {
      const r = await rawGet(n.url, p);
      assert.equal(r.status, 400, `${p}: ${r.status} ${r.body.slice(0, 80)}`);
      assert.equal(JSON.parse(r.body).error, 'bad_path', p);
    }
  } finally { await n.stop(); }
});

/** Run the page's script against a fake browser at `pathname`; the URLs it fetched, resolved as a browser would. */
async function pageFetches(pathname: string, origin = 'http://node.test:7380'): Promise<string[]> {
  const script = /<script>([\s\S]*)<\/script>/.exec(VIEW_PAGE)![1]!;
  const el = () => ({ textContent: '', innerHTML: '', className: '', style: {} as Record<string, string>, value: 'tok.sig', appendChild() {}, remove() {}, addEventListener() {} });
  const els = new Map<string, ReturnType<typeof el>>();
  const fetched: string[] = [];
  const sandbox = {
    location: { pathname, origin, hash: '#link=a.b', href: origin + pathname },
    document: { getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); }, createElement: el },
    history: { replaceState() {} }, URLSearchParams, URL, TextDecoder, JSON, Map, String, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0,
    fetch: async (u: unknown) => { fetched.push(new URL(String(u), origin + pathname).href); return { ok: false, status: 401, json: async () => ({}) }; },
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((r) => setImmediate(r));
  return fetched;
}

test('the view page fetches only its own origin, from the view\'s owner and name, under a CSP that holds its own script', async () => {
  const origin = 'http://node.test:7380';
  for (const p of ['//evil.example/view/home.node/shown', '//evil.example/x/view/home.node/shown']) {
    for (const u of await pageFetches(p, origin)) assert.equal(new URL(u).origin, origin, `the page at ${p} fetched ${u}`);
  }
  assert.deepEqual(await pageFetches(VIEW, origin), [`${origin}${VIEW}`]);
  assert.deepEqual(await pageFetches('/fkts/view/home.node/shown', origin), [`${origin}/fkts/view/home.node/shown`], 'a path prefix (a reverse proxy) is kept');
  assert.deepEqual(await pageFetches('/view/a%2Fb/c%20d', origin), [`${origin}/view/a%2Fb/c%20d`]);

  const n = await start(tmpDir('vla-csp'), 'home.node');
  try {
    await pubAs(n, n.me, [view('shown', 'edge(F, S, "shows", T)')]);
    const r = await rawGet(n.url, VIEW);
    assert.equal(r.status, 200);
    const csp = String(r.headers['content-security-policy'] ?? '');
    for (const d of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(d), `CSP ${csp} lacks ${d}`);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    const hash = (s: string) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
    assert.ok(csp.includes(hash(/<script>([\s\S]*)<\/script>/.exec(r.body)![1]!)), 'the CSP admits the page\'s own script');
    assert.ok(csp.includes(hash(/<style>([\s\S]*)<\/style>/.exec(r.body)![1]!)), 'and its own style');
  } finally { await n.stop(); }
});

test('a link is bound to the view\'s definition: redefined, its open stream ends and the link opens nothing', async () => {
  const { n, eve, eveDir } = await home('vla-lit');
  try {
    const { token } = await mint(n, eve, eveDir);
    const s = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    await s.next();
    // Another view of the owner's does not touch it.
    await pubAs(n, n.me, [view('other', 'edge(F, S, R, T)'), shows('b', 'y')]);
    const d = await s.next(5000);
    assert.equal(d.kind, 'delta', JSON.stringify(d));
    await oracle(n, s, `edge[${bookOf('home.node')}](F, S, "shows", T)`, eve);
    // The owner redefines `shown` to read eve's own book.
    await pubAs(n, n.me, [view('shown', `edge[${bookOf('eve')}](F, S, R, T)`)]);
    const end = await refusedWithin(s, 5000);
    assert.ok(end, 'the open stream of the old definition ends');
    assert.equal(end.error, 'view_redefined', JSON.stringify(end));
    s.close();
    const again = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(again.status, 401, `reopened: ${JSON.stringify(again.body)}`);
    assert.equal(again.body!.error, 'bad_view_link');
    again.close();
    // A link minted for the definition as it is now opens it.
    const now = await subscribe(n.url, VIEW, withLink((await mint(n, eve, eveDir)).token));
    assert.equal(now.status, 200, JSON.stringify(now.body));
    now.close();
  } finally { await n.stop(); }
});

test('a revoke admitted while a link\'s stream opens always ends the stream', async (t) => {
  const { n, eve, eveDir } = await home('vla-race');
  try {
    let survived = 0, refusedAtOpen = 0, ended = 0;
    for (let i = 0; i < 40; i++) {
      const { token, jti } = await mint(n, eve, eveDir);
      const [s] = await Promise.all([subscribe(n.url, VIEW, withLink(token)),
        new Promise((r) => setTimeout(r, i % 8)).then(() => pubAs(n, eve, [{ source: jti, relation: 'roflenox:revoke_link', target: 'revoked', perspective: 'policy', confidence: 1 }]))]);
      if (s.status !== 200) { assert.equal(s.body!.error, 'bad_view_link'); refusedAtOpen++; continue; }
      if (await refusedWithin(s, 1500)) ended++; else survived++;
      s.close();
    }
    t.diagnostic(`refused at open ${refusedAtOpen}, ended ${ended}, survived ${survived}`);
    assert.equal(survived, 0, `streams that outlived their revoke: ${survived} (refused at open ${refusedAtOpen}, ended ${ended})`);
  } finally { await n.stop(); }
});

/** eve's batch revoking `jti`, signed now and posted later: its admission takes one serial slot. */
async function revokeBatch(n: Running, eve: LocalIdentity, jti: string): Promise<unknown> {
  const real = httpCaller(n.url, eve, () => n.clock.t);
  let body: unknown = null;
  await publishVia(async (op, a) => (op === 'admit' ? (body = a, { receipt: {} }) : real(op, a)), eve,
    [{ source: jti, relation: 'roflenox:revoke_link', target: 'revoked', perspective: 'policy', confidence: 1 }], () => n.clock.t);
  return body;
}

test('a revoke queued behind a link\'s open ends the stream, and one queued before refuses the open: no slot between check and registration', async () => {
  const { n, eve, eveDir } = await home('vla-order');
  const hold = (ms: number) => (n.node as unknown as { serial: (f: () => Promise<void>) => Promise<void> }).serial(() => new Promise((r) => setTimeout(r, ms)));
  try {
    // The open first, the revoke behind it.
    const first = await mint(n, eve, eveDir);
    const body = await revokeBatch(n, eve, first.jti);
    const busy = hold(500);
    const opening = subscribe(n.url, VIEW, withLink(first.token));
    await new Promise((r) => setTimeout(r, 150));
    const admitted = post(n.url, '/batches', body, { as: eve });
    await busy;
    const s = await opening;
    assert.equal((await admitted).status, 201);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const end = await refusedWithin(s, 3000);
    assert.ok(end, 'the stream outlived the revoke queued behind its open');
    assert.equal(end.error, 'link_revoked');
    s.close();
    // The revoke first, the open behind it.
    const second = await mint(n, eve, eveDir);
    const body2 = await revokeBatch(n, eve, second.jti);
    const busy2 = hold(500);
    const admitted2 = post(n.url, '/batches', body2, { as: eve });
    await new Promise((r) => setTimeout(r, 150));
    const opening2 = subscribe(n.url, VIEW, withLink(second.token));
    await busy2;
    assert.equal((await admitted2).status, 201);
    const s2 = await opening2;
    assert.equal(s2.status, 401, JSON.stringify(s2.body));
    s2.close();
  } finally { await n.stop(); }
});

test('rotating the issuer\'s key ends its links\' open streams', async () => {
  const { n, eve, eveDir } = await home('vla-rot');
  try {
    const { token } = await mint(n, eve, eveDir);
    const s = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    await s.next();
    const next = eve.rotate(eveDir, new Date(n.clock.t));
    assert.equal((await post(n.url, '/identities', next.identityChain(), { as: n.me })).status, 200);
    const end = await refusedWithin(s, 5000);
    assert.ok(end, 'the stream of a link signed by the rotated-out key ends');
    assert.equal(end.error, 'link_key_invalid', JSON.stringify(end));
    s.close();
    const again = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(again.status, 401);
    again.close();
  } finally { await n.stop(); }
});

test('view_link takes the node\'s identity from an unauthenticated health only over loopback or HTTPS; otherwise --aud, which health must match', async () => {
  const { n, eve, eveDir } = await home('vla-aud');
  try {
    // A man in the middle of plain HTTP answers health as another node.
    const evil = async (op: string, args?: Record<string, unknown>) => op === 'health' ? { identity: 'evil.node' } : (await post(n.url, `/op/${op}`, args ?? {}, { as: eve })).body;
    await assert.rejects(mint(n, eve, eveDir, 'shown', { url: 'http://node.example.test', call: evil }), (e: Error & { reason?: string }) => e.reason === 'unconfirmed_audience');
    await assert.rejects(mint(n, eve, eveDir, 'shown', { url: 'http://node.example.test', aud: 'home.node', call: evil }), (e: Error & { reason?: string }) => e.reason === 'wrong_audience');
    const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString('utf8')) as { aud: string };
    assert.equal(claims((await mint(n, eve, eveDir, 'shown', { url: 'http://node.example.test', aud: 'home.node' })).token).aud, 'home.node');
    assert.equal(claims((await mint(n, eve, eveDir, 'shown', { url: 'https://node.example.test' })).token).aud, 'home.node');
    assert.equal(claims((await mint(n, eve, eveDir)).token).aud, 'home.node', 'loopback: as before');
  } finally { await n.stop(); }
});

test('open streams are capped per link and per reader; a forged link is refused without waiting on the node\'s queue', async () => {
  const { n, eve, eveDir } = await home('vla-cap');
  const caps = await import('../src/node.ts') as unknown as { MAX_STREAMS_PER_LINK?: number; MAX_STREAMS_PER_READER?: number };
  const perLink = caps.MAX_STREAMS_PER_LINK ?? 4, perReader = caps.MAX_STREAMS_PER_READER ?? 32;
  const open: Stream[] = [];
  try {
    const { token } = await mint(n, eve, eveDir);
    for (let i = 0; i < perLink; i++) { const s = await subscribe(n.url, VIEW, withLink(token)); assert.equal(s.status, 200, JSON.stringify(s.body)); open.push(s); }
    const over = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(over.status, 429, `link stream ${perLink + 1}: ${over.status}`);
    assert.equal(over.body!.error, 'too_many_streams');
    while (open.length < perReader) {
      const t = (await mint(n, eve, eveDir)).token;
      for (let i = 0; i < perLink && open.length < perReader; i++) { const s = await subscribe(n.url, VIEW, withLink(t)); assert.equal(s.status, 200, JSON.stringify(s.body)); open.push(s); }
    }
    const reader = await subscribe(n.url, VIEW, withLink((await mint(n, eve, eveDir)).token));
    assert.equal(reader.status, 429, `eve's stream ${perReader + 1}: ${reader.status}`);
    // A closed stream frees its place.
    open.pop()!.close();
    let back = 0;
    for (let k = 0; k < 40 && back !== 200; k++) { await new Promise((r) => setTimeout(r, 50)); const s = await subscribe(n.url, VIEW, withLink((await mint(n, eve, eveDir)).token)); back = s.status; if (back === 200) open.push(s); }
    assert.equal(back, 200, 'a closed stream frees its place');

    // While the node's queue is busy, a link with a forged signature is refused at once.
    const forged = `${token.split('.')[0]}.${Buffer.alloc(64).toString('base64url')}`;
    const busy = (n.node as unknown as { serial: (f: () => Promise<void>) => Promise<void> }).serial(() => new Promise((r) => setTimeout(r, 1500)));
    const t0 = Date.now();
    const f = await subscribe(n.url, VIEW, withLink(forged));
    const ms = Date.now() - t0;
    assert.equal(f.status, 401);
    assert.ok(ms < 700, `the forged link waited ${ms} ms on the queue`);
    await busy;
  } finally { for (const s of open) s.close(); await n.stop(); }
});

test('a link has one spelling: a non-canonical base64url of its claims or signature is refused', async () => {
  const { n, eve, eveDir } = await home('vla-b64');
  try {
    const { token } = await mint(n, eve, eveDir);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // The last character of a part whose length is not a multiple of 4 carries unused bits: set one.
    const respell = (p: string) => p.slice(0, -1) + A[A.indexOf(p.at(-1)!) ^ 1];
    const [c, sig] = token.split('.') as [string, string];
    assert.equal(sig.length % 4, 2, 'a 64-byte signature has 4 unused bits');
    const spelt = [`${c}.${respell(sig)}`, ...(c.length % 4 ? [`${respell(c)}.${sig}`] : [])];
    for (const t of spelt) {
      assert.deepEqual(t.split('.').map((p) => Buffer.from(p, 'base64url')), token.split('.').map((p) => Buffer.from(p, 'base64url')), 'the same bytes');
      const r = await subscribe(n.url, VIEW, withLink(t));
      assert.equal(r.status, 401, `${t === spelt[0] ? 'signature' : 'claims'} respelt: ${r.status}`);
      r.close();
    }
    const ok = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(ok.status, 200);
    ok.close();
  } finally { await n.stop(); }
});

test('an identity document listing another identity\'s key is refused: a key signs for one identity only', async () => {
  const n = await start(tmpDir('vla-shadow'), 'home.node');
  const mallory = identityAt(tmpDir('vla-shadow-m'), 'mallory');
  const eveDir = tmpDir('vla-shadow-eve');
  const eve = identityAt(eveDir, 'eve');
  try {
    await vouch(n, mallory, eve);
    await pubAs(n, n.me, [shows('a', 'x'), exportRule('shows', 'eve'), exportRule('roflenox:view', 'eve'), view('shown', 'edge(F, S, "shows", T)')]);
    // mallory, pinned before eve, adds eve's public key to its own document, signed by its own key.
    const cur = mallory.identityDoc();
    const eveKey = eve.identityDoc().doc.keys[0]!;
    const shadow = signDoc({ ...cur.doc, seq: cur.doc.seq + 1, prev: docHash(cur), issued_at: new Date(n.clock.t).toISOString(), keys: [...cur.doc.keys, eveKey] },
      (mallory as unknown as { key: crypto.KeyObject }).key);
    const anon = await post(n.url, '/identities', [...mallory.identityChain(), shadow], { as: null });
    assert.notEqual(anon.status, 200, `the shadowing document was pinned: ${JSON.stringify(anon.body)}`);
    const r = await post(n.url, '/identities', [...mallory.identityChain(), shadow], { as: n.me });
    assert.notEqual(r.status, 200, `the shadowing document was pinned by the operator's word: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'key_taken', JSON.stringify(r.body));
    // eve's key still signs for eve: her link opens, her writes are hers.
    const { token } = await mint(n, eve, eveDir);
    const s = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    s.close();
    const a = await pubAs(n, eve, [{ source: 'mine', relation: 'note', target: 'x', perspective: 'p', confidence: 1 }]) as { identity?: string };
    assert.equal(a.identity ?? 'eve', 'eve');
  } finally { await n.stop(); }
});
