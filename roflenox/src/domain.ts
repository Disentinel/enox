// Domain vouching (r_domain_vouch), off unless the operator turns it on: the
// domain of a user@domain identity may vouch for its FIRST document by serving
// it at https://<domain>/.well-known/roflenox/<local part, percent-encoded>.
// Only over HTTPS with a certificate the platform trusts, with no redirect
// followed, and only for the name the node asked about: what it answers is one
// more way a first contact is vouched for (RoflenoxNode.vouch), never a way to
// replace a key already pinned.
//
// A first contact is anyone's to make, so the domain it names is an
// attacker's choice. The node therefore asks only PUBLIC DNS names: never an
// IP literal or a single label (localhost), and only when every address the
// name resolves to is public; it then connects to the very address it
// checked, never to a fresh resolution (no DNS rebinding). Lookups are
// bounded — a few at a time — and every answer, including none, is cached.
import * as dns from 'node:dns';
import * as https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { domainToASCII } from 'node:url';
import type { IdentityDoc } from './identity.ts';

/** Where and how the domain is reached. In production: nothing (the
 *  platform's DNS and CAs, port 443, public addresses only). A test injects a
 *  local server, its CA and a resolver. */
export interface DomainTransport {
  ca?: string | Buffer;
  lookup?: LookupFunction;
  port?: number;
  /** Which resolved addresses may be connected to (default: public only). */
  allowAddress?: (address: string, family: number) => boolean;
  /** How long an answer, or its absence, is kept (default 5 min). */
  cacheMs?: number;
  timeoutMs?: number;
}

const LIMIT = 64 * 1024;
const IN_FLIGHT = 4;

/** Addresses that are not the public internet. */
const INTERNAL = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) INTERNAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) INTERNAL.addSubnet(net, bits, 'ipv6');
/** (A BlockList sees IPv4 as IPv4-mapped IPv6, so the mapped range is not
 *  listed above; a mapped address is judged by the IPv4 it carries.) */
export const isPublic = (address: string, family: number): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublic(mapped[1]!, 4);
  return !INTERNAL.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

export class DomainVouch {
  private readonly cache = new Map<string, { at: number; doc: IdentityDoc | null }>();
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  private readonly t: DomainTransport;
  private readonly now: () => number;

  constructor(t: DomainTransport, now: () => number) {
    this.t = t;
    this.now = now;
  }

  /** The first document `identity`'s domain publishes for it, or null. */
  async document(identity: string): Promise<IdentityDoc | null> {
    const at = identity.lastIndexOf('@');
    if (at < 0) return null;
    const host = domainToASCII(identity.slice(at + 1));
    // A public DNS name only: no IP literal, no single label.
    if (host === '' || isIP(host) !== 0 || !host.includes('.')) return null;
    const hit = this.cache.get(identity);
    if (hit && this.now() - hit.at < (this.t.cacheMs ?? 300_000)) return hit.doc;
    await this.slot();
    try {
      const doc = await this.fetch(host, `/.well-known/roflenox/${encodeURIComponent(identity.slice(0, at))}`);
      this.cache.set(identity, { at: this.now(), doc });
      return doc;
    } finally {
      this.inFlight--;
      this.waiting.shift()?.();
    }
  }

  private slot(): Promise<void> {
    if (this.inFlight < IN_FLIGHT) { this.inFlight++; return Promise.resolve(); }
    return new Promise((ok) => this.waiting.push(() => { this.inFlight++; ok(); }));
  }

  private async fetch(host: string, path: string): Promise<IdentityDoc | null> {
    const allow = this.t.allowAddress ?? isPublic;
    const lookup = this.t.lookup ?? (dns.lookup as unknown as LookupFunction);
    const addrs = await new Promise<{ address: string; family: number }[] | null>((ok) =>
      lookup(host, { all: true }, ((e: Error | null, a: { address: string; family: number }[]) => ok(e || !Array.isArray(a) ? null : a)) as never));
    // Every address public, or none is used; then connect to the one checked.
    if (!addrs || addrs.length === 0 || !addrs.every((a) => allow(a.address, a.family))) return null;
    const pinned = addrs[0]!;
    const fixed = ((_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
      (o?.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family))) as unknown as LookupFunction;
    return new Promise((ok) => {
      const req = https.get({ host, servername: host, port: this.t.port ?? 443, path, ca: this.t.ca, lookup: fixed, timeout: this.t.timeoutMs ?? 5000,
        headers: { accept: 'application/json' } }, (res) => {
        // No redirect is followed: an answer from anywhere but this host is none.
        if (res.statusCode !== 200) { res.resume(); ok(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => { body += d; if (body.length > LIMIT) req.destroy(); });
        res.on('end', () => { try { ok(JSON.parse(body) as IdentityDoc); } catch { ok(null); } });
        res.on('error', () => ok(null));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => ok(null));                 // a bad certificate, plain HTTP, no route: no vouch
    });
  }
}
