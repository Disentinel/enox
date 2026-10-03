// THE OPERATION TABLE (r_interface_parity). Every operation a node offers is
// declared here once — name, input schema, who may call it, handler — and the
// three surfaces are GENERATED from it:
//
//   HTTP   POST /op/<name> for every operation that is not local-only, plus
//          the op's `http` alias (the wire paths older clients and peers use,
//          e.g. GET /feeds/<identity>, which a static directory can also serve)
//   MCP    tools/list is the table (minus local-only ops over HTTP); tools/call
//          runs the op as the caller the transport proved
//   CLI    `roflenox <name> --<property> <value>…`, flags from the schema
//
// A local-only op says why. It exists in the CLI and over stdio (the local
// machine, where its key or code lives) and nowhere on the network.
//
// Access is one of: anyone (the handler still sees WHO — access rules inside
// the node decide what they get), operator (the node's own identity), or
// local. There is no other gate on any surface.
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { checkFact, Refusal, type Fact } from './facts.ts';
import { LocalIdentity } from './identity.ts';
import type { RoflenoxNode } from './node.ts';
import { ENOX_OPS } from './enox-ops.ts';
import { explainEmpty } from './empty.ts';

/** A property; no `type` means any JSON value. */
export type Prop = { type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'; description?: string; items?: unknown };
export interface Schema { type: 'object'; required?: string[]; properties: Record<string, Prop>; additionalProperties: false }

export interface Ctx {
  /** The node, when the op runs inside one (HTTP, MCP, stdio). */
  node: RoflenoxNode | null;
  /** Who is calling, as the transport proved it; null = nobody. */
  caller: string | null;
  /** The local data dir (CLI, stdio). */
  dataDir: string | null;
  /** Reach another op: in-node directly, or over HTTP signed as the local identity. */
  call: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}

export interface Op {
  name: string;
  description: string;
  input: Schema;
  access: 'anyone' | 'operator' | { local: string };
  /** A local op that signs with, or makes, this machine's key: from the CLI it
   *  owns the data directory while it runs (r_single_writer, src/lock.ts). */
  signs?: true;
  /** A signing op the holder of the directory does not do for it (a key
   *  change, a checkpoint): while another process holds the directory, it
   *  refuses instead of signing beside it (r_single_writer). */
  alone?: true;
  /** CLI convenience: properties that may also be given positionally, in order. */
  positional?: string[];
  /** A wire alias. `:x` path segments and GET query parameters become args;
   *  `body` names the one property a raw body stands for. */
  http?: { method: 'GET' | 'POST'; path: string; body?: string; status?: number };
  run: (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;
  /** How the CLI prints a result (default: `text`, then JSON). */
  say?: (result: any) => string;
  /** The text an MCP tool answers with (default: compact JSON). */
  text?: (result: any) => string;
}

const obj = (properties: Record<string, Prop>, required: string[] = []): Schema =>
  ({ type: 'object', required, properties, additionalProperties: false });
const str = (description?: string): Prop => ({ type: 'string', ...(description ? { description } : {}) });

function needNode(ctx: Ctx): RoflenoxNode {
  if (!ctx.node) throw new Refusal(500, 'no_node', 'this operation runs inside a node');
  return ctx.node;
}

/** Whether the node an op reaches is this machine's own identity's. Then
 *  that node signs (r_single_writer): the op hands it the facts through
 *  `assert`, and its batches are signed one at a time on its own head. */
async function ownNode(ctx: Ctx, me: LocalIdentity): Promise<boolean> {
  const chain = await ctx.call('identity', {}).catch(() => null) as { doc: { identity: string } }[] | null;
  return Array.isArray(chain) && chain.length > 0 && chain[chain.length - 1]!.doc.identity === me.name;
}

function localIdentity(ctx: Ctx): LocalIdentity {
  const me = ctx.dataDir ? LocalIdentity.load(ctx.dataDir) : null;
  if (!me) throw new Refusal(404, 'no_identity', `no identity in ${ctx.dataDir}; run: roflenox init`);
  return me;
}

/** The recovery code is handed over once, on stderr, at creation. */
export function createIdentity(dataDir: string, name?: string): LocalIdentity {
  const me = LocalIdentity.create(dataDir, name ?? os.hostname().replace(/[^A-Za-z0-9._@-]/g, '-'));
  process.stderr.write(`recovery code for ${me.name} — shown once, stored nowhere; write it down:\n  ${me.recoveryCode}\n`);
  return me;
}

const rowsSay = (r: { rows: { identity: string; cells: unknown[] }[]; cut?: boolean; cursor?: string; total?: number; note?: string }) =>
  [...r.rows.map((row) => `${row.identity}\t${row.cells.map((c) => JSON.stringify(c)).join('\t')}`),
    r.cut ? `${r.rows.length} of ${r.total} rows — cut; next page: --cursor ${r.cursor}` : `${r.rows.length} rows`,
    ...(r.note ? [`note: ${r.note}`] : [])].join('\n');
const explainSay = (r: { identity: string; text: string }[]) => r.map((e) => `[${e.identity}] ${e.text}`).join('\n');

 /** Answer limits (r_answer_limits): no answer is silently truncated. A longer
 *  one comes back `cut: true` with a `cursor`; the cursor names the question,
 *  the asker and the log state, so a page of a changed log is refused rather
 *  than stitched from two different answers — unless the asker says `resume`:
 *  then the page continues after the last row it had, in the answer of the
 *  log as it is now, marked `resumed: true` (rows are in one fixed order).
 *  A reader that must finish while writes keep arriving (the embedder,
 *  r_compat_parity) takes that: rows written behind its position are left
 *  for its next read. */
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10_000;

function page(ctx: Ctx, a: Record<string, unknown>, ans: { vars: string[]; rows: unknown[]; unknown?: unknown }) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor((a.limit as number | undefined) ?? DEFAULT_LIMIT)));
  const head = (ctx.node!.health() as { log_head: string }).log_head;
  const q = createHash('sha256').update(JSON.stringify([a.query, a.perspective ?? null, ctx.caller])).digest('hex').slice(0, 16);
  const key = (r: unknown) => { const x = r as { identity: string; cells: unknown[] }; return JSON.stringify([x.identity, x.cells]); };
  let offset = 0;
  let resumed = false;
  if (a.cursor !== undefined) {
    let c: { q: string; o: number; h: string; k: string };
    try { c = JSON.parse(Buffer.from(a.cursor as string, 'base64url').toString('utf8')); } catch { throw new Refusal(400, 'bad_cursor', 'not a cursor'); }
    if (c.q !== q) throw new Refusal(400, 'bad_cursor', 'this cursor belongs to another question or asker');
    if (c.h === head) offset = c.o;
    else if (a.resume === true && typeof c.k === 'string') {
      offset = ans.rows.findIndex((r) => key(r) > c.k);
      if (offset < 0) offset = ans.rows.length;
      resumed = true;
    } else throw new Refusal(409, 'cursor_stale', 'the log has changed since the first page; ask again from the start (or ask with resume to continue after the last row)');
  }
  const rows = ans.rows.slice(offset, offset + limit);
  const more = offset + limit < ans.rows.length;
  return { ...ans, rows, ...(resumed ? { resumed: true } : {}),
    ...(more ? { cut: true, cursor: Buffer.from(JSON.stringify({ q, o: offset + limit, h: head, k: key(rows[rows.length - 1]) })).toString('base64url'),
      total: ans.rows.length } : {}) };
}

const FACT_ITEMS = { type: 'object', required: ['source', 'relation', 'target', 'perspective', 'confidence'] };

export const OPS: Op[] = [
  // ---- reading -------------------------------------------------------------
  { name: 'health', description: 'The node\'s heads, counts and engine state.', input: obj({}), access: 'anyone',
    http: { method: 'GET', path: '/health' }, run: async (ctx) => needNode(ctx).health(ctx.caller !== null && ctx.caller === needNode(ctx).identity?.name) },
  { name: 'identity', description: 'This node\'s signed identity document chain.', input: obj({}), access: 'anyone',
    http: { method: 'GET', path: '/.well-known/roflenox/identity' },
    run: async (ctx) => {
      const me = needNode(ctx).identity;
      if (!me) throw new Refusal(404, 'no_identity', 'this node has no identity; run init');
      return me.identityChain();
    } },
  { name: 'identity_chain', description: 'An identity\'s document chain as this node holds it.', input: obj({ identity: str() }, ['identity']),
    access: 'anyone', positional: ['identity'], http: { method: 'GET', path: '/identities/:identity' },
    run: async (ctx, a) => needNode(ctx).readIdentityChain(a.identity as string, ctx.caller) },
  { name: 'ask', description: `Ask one ROFL literal, e.g. edge(F, S, R, T) or edge(F, S, "supersedes", T): stored values are strings, so a constant is quoted (a bare lowercase word is an atom and matches nothing). Optional perspective restricts edge questions to the facts asserted under it. At most \`limit\` rows (default ${DEFAULT_LIMIT}); a longer answer is marked cut, with a cursor for the next page. An answer with no rows carries a \`note\` when the cause is in the question (r_empty_explains).`,
    input: obj({ query: str('one ROFL literal; quote constants: edge(F, S, "supersedes", T)'),
      perspective: str('the perspective the facts were asserted under (facts written through the Enox tools and imports are under "enox"); only for edge(F, S, R, T)'),
      limit: { type: 'number' }, cursor: str('from the previous page'),
      resume: { type: 'boolean', description: 'with a cursor of a log that has changed since: continue after its last row instead of refusing' } }, ['query']),
    access: 'anyone', positional: ['query'], http: { method: 'POST', path: '/ask' }, say: rowsSay,
    run: async (ctx, a) => {
      const n = needNode(ctx);
      const perspective = (a.perspective as string | undefined) ?? null;
      const ans = await n.ask(a.query as string, ctx.caller, perspective);
      const note = ans.rows.length === 0 && !ans.unknown ? await explainEmpty(n, a.query as string, ctx.caller, perspective) : undefined;
      return page(ctx, a, note !== undefined ? { ...ans, note } : ans);
    } },
  { name: 'why', description: 'Why a ground literal holds, in the books you may read whole.', input: obj({ literal: str() }, ['literal']),
    access: 'anyone', positional: ['literal'], say: explainSay, run: async (ctx, a) => needNode(ctx).why(a.literal as string, ctx.caller) },
  { name: 'whynot', description: 'Why a ground literal does not hold, in the books you may read whole.', input: obj({ literal: str() }, ['literal']),
    access: 'anyone', positional: ['literal'], say: explainSay, run: async (ctx, a) => needNode(ctx).whynot(a.literal as string, ctx.caller) },
  { name: 'chain', description: 'The digests of an identity\'s batches, in chain order (what any feed shows of it).',
    input: obj({ identity: str() }, ['identity']), access: 'anyone', positional: ['identity'],
    run: async (ctx, a) => ({ identity: a.identity, ...(await needNode(ctx).readChain(a.identity as string, ctx.caller)) }) },
  { name: 'feed', description: 'An identity\'s batches after a digest, as signed; withheld where the reader may not have them.',
    input: obj({ identity: str(), after: str(), challenge: str() }, ['identity']), access: 'anyone', positional: ['identity'],
    http: { method: 'GET', path: '/feeds/:identity' },
    run: async (ctx, a) => needNode(ctx).feed(a.identity as string, (a.after as string | undefined) ?? null,
      (a.challenge as string | undefined) ?? null, ctx.caller) },
  // ---- writing (every write is a signed batch, admitted by the same checks) ----
  { name: 'admit', description: 'Admit a signed batch {manifest, jsonl, salt, identity?, reattest?}.',
    input: obj({ manifest: { type: 'object' }, jsonl: str(), salt: str(), identity: { description: 'the signer\'s document chain (or one document)' },
      reattest: { type: 'object' }, withheld: { type: 'boolean' } }, ['manifest']),
    access: 'anyone', http: { method: 'POST', path: '/batches', status: 201 },
    run: async (ctx, a) => ({ admitted: true, receipt: await needNode(ctx).admit(a as never, ctx.caller) }) },
  { name: 'assert', description: 'Publish facts as this node\'s own identity: a signed batch through normal admission. The node signs it: this is how local operations publish while a node runs (r_single_writer).',
    input: obj({ facts: { type: 'array', items: FACT_ITEMS },
      import: { type: 'boolean', description: 'an import batch: its salt derives from its content, and a batch already held is not signed again' },
      seal_to: { type: 'array', items: { type: 'string' }, description: 'also seal the signed batch to these identities, and answer the envelope' } }, ['facts']), access: 'operator',
    run: async (ctx, a) => {
      const facts = (a.facts as unknown[]).map((f, i) => checkFact(f, i + 1));
      const n = needNode(ctx);
      const { importSalt } = await import('./import.ts');
      const r = await n.signAsSelf(facts, a.import === true ? { salt: (jsonl) => importSalt(n.identity!, jsonl) } : {});
      const out: Record<string, unknown> = { admitted: !r.held, identity: r.receipt.identity, facts: facts.length, ...(r.held ? { held: true } : {}) };
      if (a.seal_to !== undefined) {
        const { seal } = await import('./seal.ts');
        const keys = [];
        for (const to of a.seal_to as string[]) {
          const chain = to === n.identity!.name ? n.identity!.identityChain() : await n.readIdentityChain(to, ctx.caller);
          keys.push({ identity: to, enc_public_key: chain[chain.length - 1]!.doc.enc.public_key });
        }
        out.envelope = seal(r.body, keys);
      }
      return out;
    } },
  { name: 'introduce', description: 'Introduce an identity by its document chain (pinned only on the operator\'s word or a delegation; rotations by rule).',
    input: obj({ chain: { description: 'a document chain, oldest first (or one document)' } }, ['chain']), access: 'anyone',
    http: { method: 'POST', path: '/identities', body: 'chain' },
    run: async (ctx, a) => needNode(ctx).introduce(a.chain, ctx.caller) },
  { name: 'challenge', description: 'A one-time challenge for pulling a feed into this node.', input: obj({}), access: 'anyone',
    http: { method: 'POST', path: '/challenges', status: 201 }, run: async (ctx) => ({ nonce: needNode(ctx).issueChallenge() }) },
  { name: 'admit_feed', description: 'Admit a peer\'s feed under this node\'s challenge, or under a static checkpoint.',
    input: obj({ identity: { description: 'the publisher\'s document chain' }, batches: { type: 'array' }, attestation: { type: 'object' },
      nonce: str(), checkpoint: { type: 'object' } }, ['batches']),
    access: 'anyone', http: { method: 'POST', path: '/feeds/admit', status: 201 }, run: async (ctx, a) => needNode(ctx).admitFeed(a as never, ctx.caller) },
  { name: 'admit_sealed', description: 'Admit a sealed batch addressed to this node\'s identity (offline admission).',
    input: obj({ v: str(), epk: str(), recipients: { type: 'array' }, iv: str(), ciphertext: str() }, ['v', 'epk', 'recipients', 'iv', 'ciphertext']),
    access: 'anyone', http: { method: 'POST', path: '/sealed', status: 201 },
    run: async (ctx, a) => ({ admitted: true, receipt: await needNode(ctx).admitSealed(a, ctx.caller) }) },
  // ---- local: they need the key, the code or the disk of this machine ---------
  { name: 'init', signs: true, description: 'Create this machine\'s identity (the recovery code is shown once).', input: obj({ name: str() }),
    access: { local: 'it creates the private key on this machine' },
    say: (r) => `identity ${r.identity} ready in ${r.dataDir}`,
    run: async (ctx, a) => {
      const me = LocalIdentity.load(ctx.dataDir!) ?? createIdentity(ctx.dataDir!, a.name as string | undefined);
      return { identity: me.name, dataDir: ctx.dataDir };
    } },
  { name: 'publish', signs: true, description: 'Sign the facts in a JSONL file as this identity and admit them.', input: obj({ file: str() }, ['file']),
    access: { local: 'it signs with the private key on this machine' }, positional: ['file'],
    say: (r) => `published ${r.facts} facts as ${r.identity}`,
    run: async (ctx, a) => {
      const { publishVia, readFacts } = await import('./client.ts');
      const me = localIdentity(ctx);
      const facts = readFacts(fs.readFileSync(a.file as string, 'utf8'));
      if (await ownNode(ctx, me)) {
        await ctx.call('assert', { facts });
        return { identity: me.name, facts: facts.length };
      }
      return publishVia(ctx.call, me, facts, ctx.now);
    } },
  { name: 'mirror', signs: true, description: 'Pull an identity\'s feed from a peer URL (or its invitation link, the first time over plain HTTP) and admit it here.', input: obj({ peer: str(), identity: str() }, ['peer', 'identity']),
    access: { local: 'it signs its requests to the peer with the private key on this machine' }, positional: ['peer', 'identity'],
    say: (r) => `mirrored ${r.batches} batches of ${r.identity}`,
    run: async (ctx, a) => {
      const { mirrorVia } = await import('./client.ts');
      return mirrorVia(ctx.call, a.peer as string, a.identity as string, LocalIdentity.load(ctx.dataDir!) ?? undefined, ctx.now);
    } },
  { name: 'invite', description: 'The link a reader copies to pull this identity\'s feed the first time, over plain HTTP too.',
    input: obj({ at: str('the URL readers reach this node at') }, ['at']), access: { local: 'it reads the identity on this machine' },
    positional: ['at'], say: (r) => r.link,
    run: async (ctx, a) => {
      const { invitationLink } = await import('./client.ts');
      const me = localIdentity(ctx);
      return { identity: me.name, link: invitationLink(a.at as string, me) };
    } },
  { name: 'rotate', signs: true, alone: true, description: 'A new key, signed over by the current one.', input: obj({}),
    access: { local: 'it replaces the private key on this machine' }, say: (r) => `rotated ${r.identity}'s key`,
    run: async (ctx) => {
      const next = localIdentity(ctx).rotate(ctx.dataDir!, new Date(ctx.now()));
      await ctx.call('introduce', { chain: next.identityChain() });
      return { identity: next.name };
    } },
  { name: 'recover', signs: true, alone: true, description: 'Revoke every key with the backup code and start a new one.', input: obj({ code: str(), name: str() }, ['code']),
    access: { local: 'it takes the backup code, which never crosses a network' }, positional: ['code'],
    say: (r) => `recovered ${r.identity}: every earlier key is revoked and a new one is in use`,
    run: async (ctx, a) => {
      const name = (a.name as string | undefined) ?? LocalIdentity.load(ctx.dataDir!)?.name;
      if (!name) throw new Refusal(400, 'bad_args', 'recover needs --name when there is no key file');
      const chain = await ctx.call('identity_chain', { identity: name }) as never;
      const head = ((await ctx.call('health', {}) as { heads: Record<string, string> }).heads)[name] ?? null;
      const next = LocalIdentity.recover(ctx.dataDir!, a.code as string, chain, head, new Date(ctx.now()));
      await ctx.call('introduce', { chain: next.identityChain() });
      return { identity: next.name };
    } },
  { name: 'backup', description: 'Copy the log up to its last receipt into <to>/latest, verified by a rebuild.', input: obj({ to: str() }, ['to']),
    access: { local: 'it reads this machine\'s data directory' }, say: (r) => `backed up ${r.receipts} receipts to ${r.dir}`,
    run: async (ctx, a) => (await import('./backup.ts')).backup(ctx.dataDir!, a.to as string, { now: ctx.now }) },
  { name: 'checkpoint', signs: true, alone: true, description: 'Write the public feed and a signed checkpoint into a static directory.', input: obj({ out: str() }, ['out']),
    access: { local: 'it signs with the private key on this machine and writes to its disk' },
    say: (r) => `checkpointed ${r.identity}'s public feed into ${r.out}`,
    run: async (ctx, a) => {
      const { writeStaticFeedVia } = await import('./client.ts');
      const me = localIdentity(ctx);
      await writeStaticFeedVia(ctx.call, me, a.out as string, ctx.now);
      return { identity: me.name, out: a.out };
    } },
  { name: 'seal', signs: true, description: 'Publish facts privately: admit them, then seal the batch to recipients into a file.',
    input: obj({ file: str(), to: str('comma-separated identities'), out: str() }, ['file', 'to', 'out']),
    access: { local: 'it signs with the private key on this machine and writes to its disk' }, positional: ['file'],
    say: (r) => `sealed a batch of ${r.identity} for ${r.to} into ${r.out}`,
    run: async (ctx, a) => {
      const { publishSealedVia, readFacts } = await import('./client.ts');
      const me = localIdentity(ctx);
      const facts = readFacts(fs.readFileSync(a.file as string, 'utf8'));
      const to = (a.to as string).split(',');
      const e = await ownNode(ctx, me)
        ? (await ctx.call('assert', { facts, seal_to: to }) as { envelope: unknown }).envelope
        : await publishSealedVia(ctx.call, me, facts, to, ctx.now);
      fs.writeFileSync(a.out as string, JSON.stringify(e));
      return { identity: me.name, to: a.to, out: a.out };
    } },
  { name: 'open', description: 'Hand a sealed batch (a file or URL) to this node to open and admit.', input: obj({ envelope: str() }, ['envelope']),
    access: { local: 'it reads a file on this machine' }, positional: ['envelope'], say: () => 'opened and admitted a sealed batch',
    run: async (ctx, a) => {
      const p = a.envelope as string;
      const text = /^https?:/.test(p) ? await (await fetch(p)).text() : fs.readFileSync(p, 'utf8');
      return ctx.call('admit_sealed', JSON.parse(text));
    } },
  { name: 'import_enox', signs: true, description: 'Import an Enox snapshot (JSONL of _type node/edge) as this identity; repeatable.',
    input: obj({ file: str(), batch_size: { type: 'number' } }, ['file']), access: { local: 'it signs with the private key on this machine and reads a file on its disk' },
    positional: ['file'],
    say: (r) => `imported ${r.entities} entities and ${r.assertions} assertions as ${r.facts} facts in ${r.batches} batches (${r.admitted} admitted, ${r.skipped} already held)`,
    run: async (ctx, a) => {
      const { importEnox } = await import('./import.ts');
      const me = localIdentity(ctx);
      return importEnox(ctx.call, me, fs.readFileSync(a.file as string, 'utf8'),
        { batchSize: a.batch_size as number | undefined, now: ctx.now, handOff: await ownNode(ctx, me) });
    } },
  { name: 'follow', signs: true, description: 'Keep mirrors current: run this identity\'s follow executor (every roflenox:follow fact it holds) until stopped.',
    input: obj({ interval_ms: { type: 'number' }, rounds: { type: 'number' } }),
    access: { local: 'it signs its pulls with the private key on this machine and runs as a process here' },
    say: (r) => `followed for ${r.rounds} rounds`,
    run: async (ctx, a) => {
      const { followLoop } = await import('./executor.ts');
      const me = localIdentity(ctx);
      const ac = new AbortController();
      let rounds = 0;
      const limit = a.rounds as number | undefined;
      const tick: typeof ctx.call = async (op, args) => {
        if (op === 'ask' && limit !== undefined && ++rounds > limit) ac.abort();
        return ctx.call(op, args);
      };
      process.once('SIGTERM', () => ac.abort());
      await followLoop(tick, me, (a.interval_ms as number | undefined) ?? 30_000, ac.signal, (s) => process.stderr.write(`${s}\n`));
      return { rounds: limit ?? rounds };
    } },
  { name: 'oauth_grants', description: 'The OAuth grants hosted MCP clients hold on this node: client, redirect host, when, live tokens, revoked.',
    input: obj({}), access: 'operator',
    say: (r) => r.grants.length ? r.grants.map((g: Record<string, unknown>) => `${g.grant}\t${g.client}\t${g.redirect_host}\t${g.created_at}\t${g.revoked_at ? `revoked ${g.revoked_at}` : `${g.live_access_tokens} live`}`).join('\n') : 'no OAuth grants',
    run: async (ctx) => ({ grants: needNode(ctx).oauth.grants() }) },
  { name: 'oauth_revoke', description: 'Revoke an OAuth grant: every token it issued stops at once.', input: obj({ grant: str() }, ['grant']),
    access: 'operator', positional: ['grant'], say: (r) => `revoked ${r.grant}`,
    run: async (ctx, a) => {
      if (!needNode(ctx).oauth.revoke(a.grant as string)) throw new Refusal(404, 'no_grant', `no OAuth grant ${a.grant}`);
      return { grant: a.grant, revoked: true };
    } },
  { name: 'operator_token', description: 'The bearer token that stands for this node\'s own identity over MCP.', input: obj({}),
    access: { local: 'it is a credential; it is shown only on the machine that holds it' },
    say: (r) => r.token,
    run: async (ctx) => {
      const { operatorTokenOf } = await import('./node.ts');
      return { token: operatorTokenOf(ctx.dataDir!) };
    } },
];

OPS.push(...ENOX_OPS);

export const OP = new Map(OPS.map((o) => [o.name, o]));
export const isLocal = (o: Op) => typeof o.access === 'object';

/** Check args against an op's schema: required present, types right, nothing extra. */
export function validate(op: Op, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Refusal(400, 'bad_args', `${op.name} takes an object`);
  const a = args as Record<string, unknown>;
  for (const k of op.input.required ?? []) if (a[k] === undefined) throw new Refusal(400, 'bad_args', `${op.name} needs ${k}`);
  for (const [k, v] of Object.entries(a)) {
    const p = op.input.properties[k];
    if (!p) throw new Refusal(400, 'bad_args', `${op.name} takes no ${k}`);
    if (v === undefined || p.type === undefined) continue;
    const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    // An integer is a number with no fraction (JSON Schema's "integer").
    if (p.type === 'integer' && t === 'number' && !Number.isInteger(v)) throw new Refusal(400, 'bad_args', `${op.name}: ${k} is an integer, not ${v}`);
    if (t !== (p.type === 'integer' ? 'number' : p.type)) throw new Refusal(400, 'bad_args', `${op.name}: ${k} is ${p.type}, not ${t}`);
  }
  return a;
}

/** Run an op as `ctx.caller`: validation, then access, then the handler. */
export async function callOp(name: string, args: unknown, ctx: Ctx, surface: 'network' | 'local'): Promise<unknown> {
  const op = OP.get(name);
  if (!op || (surface === 'network' && isLocal(op))) throw new Refusal(404, 'unknown_op', `no operation ${name}`);
  const a = validate(op, args);
  if (op.access === 'operator' && (ctx.caller === null || ctx.caller !== ctx.node?.identity?.name)) {
    throw new Refusal(403, 'not_operator', `${name} is the node's own identity's to call`);
  }
  return op.run(ctx, a);
}

/** Facts from a tool argument, checked (used by table rows that take facts). */
export function factsArg(v: unknown): Fact[] {
  if (!Array.isArray(v)) throw new Refusal(400, 'bad_args', 'facts is an array');
  return v.map((f, i) => checkFact(f, i + 1));
}
