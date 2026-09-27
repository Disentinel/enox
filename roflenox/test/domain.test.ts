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
import { DomainVouch, isPublic, type DomainTransport } from '../src/domain.ts';
import { listen } from '../src/http.ts';
import { batch, fact, get, identityAt, invitation, iso, post, pull, start, T0, tmpDir, exportRule } from './helpers.ts';

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
  return { port: Number(new URL(url).port), close: () => new Promise<void>((r) => server.close(() => r())),
    onConnection: (f: () => void) => { server.on('connection', f); } };      // any TCP connection, before TLS
}

/** The local test server is on loopback: these transports let it through
 *  (allowAddress); the SSRF test below keeps the default, public only. */
const transport = (port: number): DomainTransport => ({ ca: pem('ca.pem'), lookup, port, allowAddress: () => true });
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

test('an anonymous first contact as user@127.0.0.1, user@localhost or a user at a name resolving to a private address makes no outbound connection', async () => {
  const web = await webServer({}, { tls: 'trusted' });
  let connections = 0;
  const asked: string[] = [];
  const where: Record<string, { address: string; family: number }[]> = {
    'intranet.example.org': [{ address: '127.0.0.1', family: 4 }], 'office.example.org': [{ address: '10.0.0.7', family: 4 }],
    'shared.example.org': [{ address: '100.64.1.1', family: 4 }], 'linklocal.example.org': [{ address: '169.254.169.254', family: 4 }],
    // One public address beside an internal one: not all public, so none is used.
    'mixed.example.org': [{ address: '127.0.0.1', family: 4 }, { address: '203.0.113.9', family: 4 }],
    'v6.example.org': [{ address: '::1', family: 6 }],
  };
  const spy = ((host: string, _o: unknown, cb: (e: Error | null, a?: unknown) => void) => {
    asked.push(host);
    cb(null, where[host] ?? [{ address: '127.0.0.1', family: 4 }]);
  }) as unknown as LookupFunction;
  const node = await start(tmpDir('ssrf-n'), 'hub', { domainVouch: { ca: pem('ca.pem'), lookup: spy, port: web.port } });   // public addresses only
  try {
    web.onConnection(() => { connections++; });
    for (const host of ['127.0.0.1', 'localhost', ...Object.keys(where)]) {
      const me = identityAt(tmpDir('ssrf-u'), `user@${host}`);
      assert.equal((await contact(node.url, me, node.clock.t)).body.error, 'not_vouched', host);
    }
    assert.equal(connections, 0, 'no connection was made');
    // Control of the classification itself: public addresses are public.
    assert.deepEqual(['8.8.8.8', '203.0.113.9', '2001:4860::8888', '2606:4700::1111'].map((x) => isPublic(x, x.includes(':') ? 6 : 4)), [true, true, true, true]);
    assert.deepEqual(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']
      .map((x) => isPublic(x, x.includes(':') ? 6 : 4)), Array(11).fill(false));
    assert.deepEqual(asked.sort(), Object.keys(where).sort(), 'an IP literal or a single label is not even looked up');
    // The connection goes to the address that was checked, never to a second
    // resolution (a name that rebinds between the check and the connect).
    let asks = 0;
    const rebinding = ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => {
      asks++;
      cb(null, [{ address: asks === 1 ? '127.0.0.1' : '10.9.9.9', family: 4 }]);
    }) as unknown as LookupFunction;
    const checked = await start(tmpDir('ssrf-r'), 'hub', { domainVouch: { ca: pem('ca.pem'), lookup: rebinding, port: web.port, allowAddress: (x) => x === '127.0.0.1' } });
    try {
      await contact(checked.url, identityAt(tmpDir('ssrf-rb'), 'user@rebind.example.org'), checked.clock.t);
      assert.equal(asks, 1, 'resolved once, connected to what was checked');
      assert.equal(connections, 1, 'the one connection is to the checked address');
    } finally { await checked.stop(); }
  } finally { await node.stop(); await web.close(); }
});

test('a flood of first contacts naming many domains opens a bounded number of domain lookups at a time and repeats none within the cache time', async () => {
  const web = await webServer({}, { tls: 'trusted' });
  let inFlight = 0, most = 0;
  const counts = new Map<string, number>();
  const slow = ((host: string, _o: unknown, cb: (e: Error | null, a?: unknown) => void) => {
    counts.set(host, (counts.get(host) ?? 0) + 1);
    most = Math.max(most, ++inFlight);
    setTimeout(() => { inFlight--; cb(null, [{ address: '127.0.0.1', family: 4 }]); }, 20);
  }) as unknown as LookupFunction;
  const clock = { t: T0 };
  const dv = new DomainVouch({ ca: pem('ca.pem'), lookup: slow, port: web.port, allowAddress: () => true, cacheMs: 60_000 }, () => clock.t);
  const node = await start(tmpDir('flood-n'), 'hub', { clock, domainVouch: { ca: pem('ca.pem'), lookup: slow, port: web.port, allowAddress: () => true, cacheMs: 60_000 } });
  try {
    // Forty names at once, straight at the lookup layer: a few at a time.
    const names = Array.from({ length: 40 }, (_, i) => `u@d${i}.example.org`);
    await Promise.all(names.map((n) => dv.document(n)));
    assert.ok(most >= 2 && most <= 4, `at most 4 lookups at a time (saw ${most})`);
    // Asked again within the cache time: no lookup; after it: one each.
    await Promise.all(names.map((n) => dv.document(n)));
    assert.ok([...counts.values()].every((c) => c === 1), 'no repeat within the cache time');
    clock.t += 60_001;
    await dv.document(names[0]!);
    assert.equal(counts.get('d0.example.org'), 2);
    // Through the node: a flood of anonymous first contacts, one domain each, twice.
    counts.clear(); most = 0;
    const people = Array.from({ length: 12 }, (_, i) => identityAt(tmpDir('flood-u'), `u${i}@n${i}.example.org`));
    for (let round = 0; round < 2; round++) await Promise.all(people.map((p) => contact(node.url, p, node.clock.t)));
    assert.ok(most <= 4, `at most 4 at a time (saw ${most})`);
    assert.ok([...counts.values()].every((c) => c === 1) && counts.size === 12, 'each domain looked up once');
  } finally { await node.stop(); await web.close(); }
});

test('an internal IPv4 written in any IPv6 form, NAT64, 6to4, IPv4-compatible or mapped, is not a public address', () => {
  const v6 = (x: string) => isPublic(x, 6);
  // 10.0.0.5 and 127.0.0.1 in every IPv6 spelling that carries an IPv4 address.
  for (const x of ['64:ff9b::a00:5', '64:ff9b::7f00:1', '2002:a00:5::1', '2002:7f00:1::', '::a00:5', '::7f00:1',
    '::ffff:10.0.0.5', '::ffff:127.0.0.1', '2001:0:a00:5::1']) assert.equal(v6(x), false, x);
  // And what is not the internet at all.
  for (const x of ['2001:db8::1', '100::1', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1']) assert.equal(v6(x), false, x);
  // Control: global unicast is public.
  for (const x of ['2001:4860:4860::8888', '2606:4700::1111', '2a00:1450::1']) assert.equal(v6(x), true, x);
});
