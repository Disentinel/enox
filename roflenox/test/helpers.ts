// Test harness: nodes in temp dirs, on loopback ports chosen by the OS, with
// an injectable clock. Nothing here sleeps or reaches past 127.0.0.1.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { LocalIdentity } from '../src/identity.ts';
import { RoflenoxNode, type NodeOptions } from '../src/node.ts';
import { createServer, listen } from '../src/http.ts';
import { newSalt, toJsonl, type Fact } from '../src/facts.ts';
import { signRequest } from '../src/httpsig.ts';
import { httpCaller, invitationLink, mirrorVia } from '../src/client.ts';
import type { Frame } from '../src/subscribe.ts';

/** The identity a test's /ask, /feeds, /op and write requests are signed as,
 *  per node URL: by default the node's own identity — its operator, who sees
 *  everything the node holds and vouches for what it writes (a first pin needs
 *  the operator's word). Tests pass `as` explicitly, or `null` for unsigned. */
const operators = new Map<string, string>();   // node URL → its data dir (the key file as it is NOW)
/** Each node's clock, so a signed request is dated on the clock that judges it. */
const clocks = new Map<string, Clock>();
/** A node's public URL, when it has one: what a request to it is signed for. */
const origins = new Map<string, string>();

const made: string[] = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

export function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `roflenox-${tag}-`));
  made.push(d);
  return d;
}

export interface Clock { t: number }

/** The fixed test time; identities are created a day before it. */
export const T0 = Date.parse('2026-09-26T12:00:00.000Z');
export const DAY = 86_400_000;
export const identityAt = (dir: string, name: string) => LocalIdentity.create(dir, name, new Date(T0 - DAY));

export interface Running {
  node: RoflenoxNode;
  url: string;
  dir: string;
  me: LocalIdentity;
  clock: Clock;
  /** The HTTP server, for a test that watches the requests it receives. */
  server?: http.Server;
  stop: () => Promise<void>;
}

/** Serve a node over `dir` exactly as found — no identity is created. */
export async function serveAsIs(dir: string, clock: Clock = { t: T0 }): Promise<Omit<Running, 'me'>> {
  const node = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t });
  const server: http.Server = createServer(node);
  const url = await listen(server, 0);
  return {
    node, url, dir, clock,
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close();
    },
  };
}

/** Start a node over `dir` (creating its identity `name` if absent). */
export async function start(dir: string, name: string, o: Partial<NodeOptions> & { clock?: Clock } = {}): Promise<Running> {
  const clock = o.clock ?? { t: T0 };
  const me = LocalIdentity.load(dir) ?? LocalIdentity.create(dir, name, new Date(T0 - DAY));
  const node = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t, ...o });
  const server: http.Server = createServer(node);
  const url = await listen(server, 0);
  operators.set(url, dir);
  clocks.set(url, clock);
  if (o.publicUrl) origins.set(url, new URL(o.publicUrl).origin);
  return {
    node, url, dir, me, clock, server,
    stop: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close();
    },
  };
}

export function fact(source: string, relation: string, target: string, confidence = 0.9, perspective = 'test'): Fact {
  return { source, relation, target, perspective, confidence };
}

/** Access facts (see src/facts.ts): a grant to read this book until `until`,
 *  and an export of a relation (or "*") to an audience ("public" or a name). */
export const grant = (recipient: string, until: string): Fact =>
  ({ source: recipient, relation: 'roflenox:grant', target: until, perspective: 'policy', confidence: 1 });
export const exportRule = (relation: string, audience: string): Fact =>
  ({ source: relation, relation: 'roflenox:export', target: audience, perspective: 'policy', confidence: 1 });

/** A signed batch body, ready to POST; `claimedAt` defaults to the clock. */
export function batch(me: LocalIdentity, facts: Fact[], prev: string | null, claimedAt: string) {
  const jsonl = toJsonl(facts);
  const salt = newSalt();
  return { manifest: me.signBatch(jsonl, prev, claimedAt, salt), jsonl, salt, identity: me.identityChain() };
}

type As = { as?: LocalIdentity | null; now?: number };

function signed(url: string, p: string, method: string, body: string | null, o: As): Record<string, string> {
  const who = o.as === undefined ? (/^\/(ask|feeds\/|op\/|identities|batches|sealed|health)/.test(p) && operators.has(url) ? LocalIdentity.load(operators.get(url)!) ?? undefined : undefined) : o.as;
  return who ? signRequest(who, method, (origins.get(url) ?? url) + p, body, o.now ?? clocks.get(url)?.t ?? T0) : {};
}

export async function post(url: string, p: string, body: unknown, o: As = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body);
  const res = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...signed(url, p, 'POST', text, o) }, body: text });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function get(url: string, p: string, o: As = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url + p, { headers: signed(url, p, 'GET', null, o) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A running node's invitation link: what a reader copies for the first pull
 *  over plain HTTP (r_key_change_loud). `at` is where the feed is served. */
export const invitation = (r: { url: string; me: LocalIdentity }, at = r.url) => invitationLink(at, r.me);

/** `to`'s operator pulls `identity`'s feed from `link` into `to` (the CLI's
 *  mirror): the local calls are the operator's, the peer ones made as `as`. */
export const pull = (to: Running, link: string, identity: string, as?: LocalIdentity) =>
  mirrorVia(httpCaller(to.url, to.me, () => to.clock.t), link, identity, as, () => to.clock.t);

/** The operator of `node` introduces identities to it (their first pin). */
export async function vouch(node: Running, ...ids: LocalIdentity[]): Promise<void> {
  for (const id of ids) {
    const r = await post(node.url, '/identities', id.identityChain(), { as: node.me });
    if (r.status !== 200) throw new Error(`vouch ${id.name}: ${JSON.stringify(r.body)}`);
  }
}

export const iso = (t: number) => new Date(t).toISOString();

/** A fixed battery of questions whose answers must survive rebuilds. */
export const QUESTIONS = [
  'edge(F, S, R, T)',
  'conf(F, P)',
  'persp(F, P)',
  'edge(F, "alice", R, T)',
];

export async function answers(url: string, o: As = {}): Promise<unknown[]> {
  const out: unknown[] = [];
  // (Without the log head an answer names: two nodes holding the same facts
  // have different logs.)
  for (const q of QUESTIONS) { const { head: _h, ...b } = (await post(url, '/ask', { query: q }, o)).body; out.push(b); }
  return out;
}

// ---- subscriptions (r_subscribe) ------------------------------------------
const key = (r: { identity: string; cells: unknown[] }) => JSON.stringify([r.identity, r.cells]);

/** One subscription's stream: frames as they come, and the rows they add up to. */
export interface Stream { next(ms?: number): Promise<Frame>; quiet(ms: number): Promise<void>; rows: Map<string, { identity: string; cells: unknown[] }>; close(): void; status: number; body?: Record<string, unknown> }

export async function subscribe(url: string, p: string, headers: Record<string, string>): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(url + p, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
  const frames: Frame[] = [];
  let wake: (() => void) | null = null;
  const rows = new Map<string, { identity: string; cells: unknown[] }>();
  const s: Stream = {
    status: res.status, rows,
    async next(ms = 20_000) {
      const t0 = Date.now();
      while (frames.length === 0) {
        if (Date.now() - t0 > ms) throw new Error(`no frame within ${ms} ms`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
      }
      const f = frames.shift()!;
      // Strict accumulation: a frame may never add a row held or remove one not held.
      if (f.kind === 'full') { rows.clear(); for (const r of f.rows!) rows.set(key(r), r); }
      for (const r of f.added ?? []) { assert.ok(!rows.has(key(r)), `added twice: ${key(r)}`); rows.set(key(r), r); }
      for (const r of f.removed ?? []) { assert.ok(rows.delete(key(r)), `removed but never held: ${key(r)}`); }
      return f;
    },
    async quiet(ms) {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(frames, [], 'no frame was due');
    },
    close: () => ac.abort(),
  };
  if (res.status !== 200) { s.body = await res.json() as Record<string, unknown>; return s; }
  void (async () => {
    const rd = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = ev.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) { frames.push(JSON.parse(data) as Frame); (wake as (() => void) | null)?.(); }
        }
      }
    } catch { /* aborted */ }
  })();
  return s;
}

