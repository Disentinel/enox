// Domain vouching (r_domain_vouch), off unless the operator turns it on: the
// domain of a user@domain identity may vouch for its FIRST document by serving
// it at https://<domain>/.well-known/roflenox/<local part, percent-encoded>.
// Only over HTTPS with a certificate the platform trusts, with no redirect
// followed, and only for the name the node asked about: what it answers is one
// more way a first contact is vouched for (RoflenoxNode.vouch), never a way to
// replace a key already pinned.
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import { domainToASCII } from 'node:url';
import type { IdentityDoc } from './identity.ts';

/** Where the domain is reached. In production: nothing (the platform's DNS,
 *  CA store, port 443); a test injects a local server and its test CA. */
export interface DomainTransport { ca?: string | Buffer; lookup?: LookupFunction; port?: number }

const LIMIT = 64 * 1024;

/** The first document `identity`'s domain publishes for it, or null. */
export function domainDocument(identity: string, t: DomainTransport = {}, timeoutMs = 5000): Promise<IdentityDoc | null> {
  const at = identity.lastIndexOf('@');
  if (at < 0) return Promise.resolve(null);
  const host = domainToASCII(identity.slice(at + 1));
  const path = `/.well-known/roflenox/${encodeURIComponent(identity.slice(0, at))}`;
  return new Promise((ok) => {
    const req = https.get({ host, servername: host, port: t.port ?? 443, path, ca: t.ca, lookup: t.lookup, timeout: timeoutMs,
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
