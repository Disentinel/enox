// Test harness: nodes in temp dirs, on loopback ports chosen by the OS, with
// an injectable clock. Nothing here sleeps or reaches past 127.0.0.1.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { LocalIdentity } from '../src/identity.ts';
import { RoflenoxNode, type NodeOptions } from '../src/node.ts';
import { createServer, listen } from '../src/http.ts';
import { newSalt, toJsonl, type Fact } from '../src/facts.ts';
import { signRequest } from '../src/httpsig.ts';

/** The identity a test's /ask and /feeds requests are signed as, per node URL:
 *  by default the node's own identity — its operator, who sees everything the
 *  node holds. Access tests pass `as` explicitly, or `null` for unsigned. */
const operators = new Map<string, LocalIdentity>();
/** Each node's clock, so a signed request is dated on the clock that judges it. */
const clocks = new Map<string, Clock>();

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
  stop: (o?: { snapshot?: boolean }) => Promise<void>;
}

/** Serve a node over `dir` exactly as found — no identity is created. */
export async function serveAsIs(dir: string, clock: Clock = { t: T0 }): Promise<Omit<Running, 'me'>> {
  const node = await RoflenoxNode.open({ dataDir: dir, now: () => clock.t });
  const server: http.Server = createServer(node);
  const url = await listen(server, 0);
  return {
    node, url, dir, clock,
    stop: async ({ snapshot = false } = {}) => {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close({ snapshot });
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
  operators.set(url, me);
  clocks.set(url, clock);
  return {
    node, url, dir, me, clock,
    stop: async ({ snapshot = false } = {}) => {
      await new Promise<void>((r) => server.close(() => r()));
      await node.close({ snapshot });
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
  const who = o.as === undefined ? (p.startsWith('/ask') || p.startsWith('/feeds/') ? operators.get(url) : undefined) : o.as;
  return who ? signRequest(who, method, url + p, body, o.now ?? clocks.get(url)?.t ?? T0) : {};
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
  for (const q of QUESTIONS) out.push((await post(url, '/ask', { query: q }, o)).body);
  return out;
}
