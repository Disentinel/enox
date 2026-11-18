// A view link (src/viewlink.ts): a grantee who reads by signature opens a
// view's page in a browser with a capability its own key minted — for one
// view, on one node, until a time — and reads exactly what ask gives it, and
// what a node rebuilt from the log gives it (test/helpers.ts, oracle).
// Needs a `rofl` engine with `watch` (ROFL_BIN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publish } from '../src/client.ts';
import type { LocalIdentity } from '../src/identity.ts';
import type { Fact } from '../src/facts.ts';
import { mintViewLink, VIEW_LINK_MAX_SEC } from '../src/viewlink.ts';
import { canonicalize } from '../src/jcs.ts';
import { callOp } from '../src/ops.ts';
import { asked, exportRule, identityAt, oracle, post, start, subscribe, T0, tmpDir, vouch, type Running, type Stream } from './helpers.ts';

const TOY = path.join(import.meta.dirname, 'fixtures/invariants');
const toy = (f: string): Fact[] => fs.readFileSync(path.join(TOY, `${f}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Fact);
const pubAs = (n: Running, who: LocalIdentity, facts: Fact[]) => publish(n.url, who, facts, () => n.clock.t);
const VIEW = '/view/home.node/shown';
const withLink = (t: string) => ({ authorization: `FKTSView ${t}` });

const rowsOf = (s: Stream) => [...s.rows.keys()].sort();

test('a grantee\'s view link opens the view\'s stream with the grantee\'s rows only; another view, another node, expired, tampered, revoked links are refused; the link is never in a request line', async () => {
  const n = await start(tmpDir('vl'), 'home.node');
  const eveDir = tmpDir('vl-eve');
  const eve = identityAt(eveDir, 'eve');
  const lines: string[] = [];
  n.server!.on('request', (req) => lines.push(`${req.method} ${req.url} ${req.headers.referer ?? ''}`));
  const q = 'edge(F, S, R, T)';
  try {
    await vouch(n, eve);
    // eve may read the owner's "shows" facts and its views, nothing else of the book.
    await pubAs(n, n.me, [...toy('scan'), exportRule('shows', 'eve'), exportRule('fkts:view', 'eve'),
      { source: 'shown', relation: 'fkts:view', target: q, perspective: 'view', confidence: 1 },
      { source: 'other', relation: 'fkts:view', target: 'edge(F, S, "shows", T)', perspective: 'view', confidence: 1 }]);
    // As the CLI mints it (fkts view_link home.node shown --ttl 600): eve's key, on eve's machine.
    const minted = await callOp('view_link', { owner: 'home.node', name: 'shown', ttl: 600 }, {
      node: null, caller: 'eve', dataDir: eveDir, now: () => n.clock.t, url: n.url,
      call: async (op, args) => (await post(n.url, `/op/${op}`, args ?? {}, { as: eve })).body }, 'local') as { link: string; jti: string };
    assert.ok(minted.link.startsWith(`${n.url}${VIEW}#link=`), minted.link);
    const token = minted.link.slice(minted.link.indexOf('#link=') + 6);
    const claims = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as ReturnType<typeof mintViewLink>['claims'];
    assert.equal(claims.jti, minted.jti);
    // The page itself is static and asks for nothing; the link stays in the fragment.
    const page = await fetch(`${n.url}${VIEW}#link=${token}`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /FKTSView/);

    const s = await subscribe(n.url, VIEW, withLink(token));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const f0 = await s.next();
    assert.equal(f0.kind, 'full');
    await oracle(n, s, q, eve);
    assert.ok(rowsOf(s).length < (await asked(n, q)).length, 'and less than the operator reads');
    assert.ok(rowsOf(s).every((k) => /"shows"|"fkts:view"/.test(k)), 'eve\'s rows only');
    // A batch reaches the link's stream as a delta, still as eve.
    await pubAs(n, n.me, [...toy('update'), { source: 'about', relation: 'shows', target: 'signup@v1', perspective: 'scanner', confidence: 1 }]);
    const d = await s.next();
    assert.equal(d.kind, 'delta', JSON.stringify(d));
    assert.equal(d.added!.length, 1, 'the new shows fact; not the supersedes eve may not read');
    await oracle(n, s, q, eve);

    const refused = async (headers: Record<string, string>, p = VIEW, why = 'bad_view_link') => {
      const r = await subscribe(n.url, p, headers);
      assert.equal(r.status, 401, `${p}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body!.error, why);
      assert.ok(!JSON.stringify(r.body).includes(token), 'a refusal never echoes the link');
    };
    // Another view, another node, another route.
    await refused(withLink(mintViewLink(eve, 'home.node', 'home.node', 'other', n.clock.t, 600, claims.lit).token));
    await refused(withLink(mintViewLink(eve, 'elsewhere.node', 'home.node', 'shown', n.clock.t, 600, claims.lit).token));
    await refused(withLink(token), `/subscribe?query=${encodeURIComponent(q)}`);
    assert.equal((await fetch(`${n.url}/op/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...withLink(token) }, body: JSON.stringify({ query: q }) })).status, 401);
    // Tampered: a claim changed (eve → the owner; a longer life), the claims re-ordered, the signature changed, a life past the cap.
    const [body, sig] = token.split('.');
    const forge = (k: object) => `${Buffer.from(canonicalize(k)).toString('base64url')}.${sig}`;
    await refused(withLink(forge({ ...claims, iss: 'home.node' })));
    await refused(withLink(forge({ ...claims, exp: claims.exp + 3600 })));
    await refused(withLink(`${Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(claims).reverse()))).toString("base64url")}.${sig}`));
    // (A byte of the signature flipped: its last characters carry padding bits, and an
    // Ed25519 signature's top bits are zero, so rewriting them left it valid one run in 16.)
    const flipped = Buffer.from(sig!, 'base64url');
    flipped[20]! ^= 1;
    await refused(withLink(`${body}.${flipped.toString('base64url')}`));
    assert.throws(() => mintViewLink(eve, 'home.node', 'home.node', 'shown', n.clock.t, VIEW_LINK_MAX_SEC + 1));

    // Expired.
    const short = mintViewLink(eve, 'home.node', 'home.node', 'shown', n.clock.t, 60, claims.lit).token;
    n.clock.t = T0 + 61_000;
    await refused(withLink(short));
    n.clock.t = T0;

    // Revoked by its issuer: the open stream ends, and the link opens nothing.
    await pubAs(n, eve, [{ source: claims.jti, relation: 'fkts:revoke_link', target: 'revoked', perspective: 'policy', confidence: 1 }]);
    // (eve's first batch gives her a book of her own: her scope moved, and a full frame may come first.)
    let end = await s.next();
    if (end.kind === 'full') end = await s.next();
    assert.equal(end.kind, 'refused', JSON.stringify(end));
    assert.equal(end.error, 'link_revoked');
    await refused(withLink(token));

    // The owner's grant withdrawn: a fresh link opens nothing either.
    const fresh = mintViewLink(eve, 'home.node', 'home.node', 'shown', n.clock.t, 600, claims.lit).token;
    const open = await subscribe(n.url, VIEW, withLink(fresh));
    assert.equal(open.status, 200);
    await open.next();
    await pubAs(n, n.me, [{ ...exportRule('shows', 'eve'), confidence: 0 }, { ...exportRule('fkts:view', 'eve'), confidence: 0 }]);
    const gone = await open.next();
    assert.equal(gone.kind, 'refused', JSON.stringify(gone));
    assert.equal(gone.error, 'no_grant', 'the export withdrawn: the open stream ends');
    const after = await subscribe(n.url, VIEW, withLink(fresh));
    assert.equal(after.status, 404, 'eve can no longer see the view');
    open.close();

    assert.ok(lines.length > 5);
    for (const l of lines) for (const t of [token, short, fresh, sig!]) assert.ok(!l.includes(t), `a link in a request line: ${l}`);
    s.close();
  } finally { await n.stop(); }
});
