// Domain vouching (r_domain_vouch): a user@domain identity's domain may vouch
// for its first key over HTTPS. No real DNS or network: example.org and its
// neighbours resolve to a local HTTPS server whose certificate a test CA signs
// (test/fixtures/tls: ca.pem signs host.pem; untrusted.pem is self-signed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { LookupFunction } from 'node:net';
import type { IdentityDoc, LocalIdentity } from '../src/identity.ts';
import type { DomainTransport } from '../src/domain.ts';
import { listen } from '../src/http.ts';
import { batch, fact, get, identityAt, invitation, iso, post, pull, start, tmpDir, exportRule } from './helpers.ts';

const TLS = path.join(import.meta.dirname, 'fixtures', 'tls');
const pem = (f: string) => fs.readFileSync(path.join(TLS, f));
/** Every name resolves to this machine. */
const lookup: LookupFunction = ((_host: string, opts: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
  (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as unknown as LookupFunction;

/** A web server for several hosts: by Host header, the well-known documents it serves. */
async function webServer(docs: Record<string, Record<string, unknown>>, o: { tls: 'trusted' | 'untrusted' | 'none'; redirect?: Record<string, string> }) {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const host = String(req.headers.host).replace(/:\d+$/, '');
    const local = decodeURIComponent(String(req.url).replace('/.well-known/roflenox/', ''));
    const to = o.redirect?.[`${host}/${local}`];
    if (to) { res.writeHead(302, { location: to }); res.end(); return; }
    const d = docs[host]?.[local];
    if (!d) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(d));
  };
  const server = o.tls === 'none' ? http.createServer(handler)
    : https.createServer({ key: pem(o.tls === 'trusted' ? 'host.key' : 'untrusted.key'), cert: pem(o.tls === 'trusted' ? 'host.pem' : 'untrusted.pem') }, handler);
  const url = await listen(server as http.Server, 0);
  return { port: Number(new URL(url).port), close: () => new Promise<void>((r) => server.close(() => r())) };
}

const transport = (port: number): DomainTransport => ({ ca: pem('ca.pem'), lookup, port });
const firstDoc = (me: LocalIdentity): IdentityDoc => me.identityChain()[0]!;
/** A stranger's own signed batch, posted with its identity attached: a first contact. */
const contact = (url: string, me: LocalIdentity, t: number) =>
  post(url, '/batches', batch(me, [fact('x', 'y', 'z')], null, iso(t)), { as: null });

test('with domain vouching on, a first contact with user@domain pins the key its domain publishes over HTTPS, and with it off the same contact needs an invitation', async () => {
  const ada = identityAt(tmpDir('dv-ada'), 'ada@example.org');
  const web = await webServer({ 'example.org': { ada: firstDoc(ada) } }, { tls: 'trusted' });
  const on = await start(tmpDir('dv-on'), 'hub', { domainVouch: transport(web.port) });
  const off = await start(tmpDir('dv-off'), 'hub');
  const home = await start(tmpDir('dv-home'), 'ada@example.org');   // (ada's own node, to pull from)
  try {
    assert.equal((await contact(on.url, ada, on.clock.t)).status, 201, 'the domain vouched');
    assert.equal(((await get(on.url, '/identities/ada@example.org')).body as unknown as IdentityDoc[])[0]!.key_id, ada.keyId);
    // Off: the same contact is refused, and it takes an invitation.
    assert.equal((await contact(off.url, ada, off.clock.t)).body.error, 'not_vouched');
    await post(home.url, '/batches', batch(home.me, [fact('a', 'b', 'c'), exportRule('*', 'public')], null, iso(home.clock.t)));
    assert.deepEqual(await pull(off, invitation(home), 'ada@example.org'), { identity: 'ada@example.org', batches: 1 });
  } finally { await on.stop(); await off.stop(); await home.stop(); await web.close(); }
});

test('a domain vouches for no name outside it, never over plain HTTP or across a redirect to another host, and never replaces an already pinned key', async () => {
  const ada = identityAt(tmpDir('dv2-ada'), 'ada@example.org');
  const mallory = identityAt(tmpDir('dv2-m'), 'mallory@evil.example');
  const bob = identityAt(tmpDir('dv2-bob'), 'bob@example.org');
  // example.org publishes ada, a document for a name under ANOTHER domain, and
  // redirects bob to another host that does publish him.
  const docs = { 'example.org': { ada: firstDoc(ada), mallory: firstDoc(mallory) }, 'other.example.org': { bob: firstDoc(bob) } };
  const web = await webServer(docs, { tls: 'trusted', redirect: { 'example.org/bob': 'https://other.example.org/.well-known/roflenox/bob' } });
  const plain = await webServer(docs, { tls: 'none' });
  const selfSigned = await webServer(docs, { tls: 'untrusted' });
  const node = await start(tmpDir('dv2-n'), 'hub', { domainVouch: transport(web.port) });
  const overHttp = await start(tmpDir('dv2-h'), 'hub', { domainVouch: transport(plain.port) });
  const badCert = await start(tmpDir('dv2-c'), 'hub', { domainVouch: transport(selfSigned.port) });
  try {
    // A key its owner does not hold, under ada's name: the domain serves ada's.
    const other = identityAt(tmpDir('dv2-ada2'), 'ada@example.org');
    assert.equal((await contact(node.url, other, node.clock.t)).body.error, 'not_vouched', 'only the document the domain serves');
    // Control: the same server does vouch for ada.
    assert.equal((await contact(node.url, ada, node.clock.t)).status, 201);
    assert.equal((await contact(node.url, mallory, node.clock.t)).body.error, 'not_vouched', 'example.org speaks for no name of evil.example');
    assert.equal((await contact(node.url, bob, node.clock.t)).body.error, 'not_vouched', 'a redirect to another host is not followed');
    for (const n of [overHttp, badCert]) assert.equal((await contact(n.url, ada, n.clock.t)).body.error, 'not_vouched', 'plain HTTP or a certificate no one trusts');
    // The domain now publishes another key for ada: the pinned one stays.
    (docs['example.org'] as Record<string, unknown>).ada = firstDoc(other);
    assert.equal((await contact(node.url, other, node.clock.t)).status, 403);
    assert.equal(((await get(node.url, '/identities/ada@example.org')).body as unknown as IdentityDoc[])[0]!.key_id, ada.keyId);
  } finally {
    for (const n of [node, overHttp, badCert]) await n.stop();
    for (const w of [web, plain, selfSigned]) await w.close();
  }
});
