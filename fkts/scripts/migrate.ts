// Migrate a node written before the rename (roflenox, signature contexts
// roflenox-*-v1) into a fresh FKTS data directory (enox-*-v1, fkts:*).
//
// Renaming the node's own relations changes the bytes of the facts, so every
// digest, chain link and signature changes: the log is written again, receipt
// by receipt in the old order, each batch re-signed by the key that signed it.
// What the old node knew is kept: who wrote each batch, when it was claimed and
// received, its salt, its facts (with these strings rewritten):
//
//   roflenox:<x>                → fkts:<x>        (the node's own relations, in any field, rule texts too)
//   sys_roflenox                → sys_fkts
//   s<old>.<owner> and its book → s<new>.<owner>  (a session's name is derived from its grant; so are its keys)
//   an old fact id              → the new one     (facts about a fact name it by id)
//
// The keys: the owner's from OLD/key, every other writer's from a data
// directory given in `also` (its key file is written again beside the new
// one), the sessions' derived again from the owner's key and their grants in
// OLD/oauth. A batch nobody here can sign again (another node's identity
// mirrored in, a withheld batch, a rotated or recovered identity) refuses the
// whole migration and names it; nothing is half-written into NEW.
//
// OLD is only read, and only its complete index lines (as a backup reads it),
// so the old node may keep running. NEW must not exist. The result is checked
// by opening NEW as a node: the replay verifies every signature and chain.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { batchDigest, factId, parseJsonl, sha256hex, toJsonl, type Fact } from '../src/facts.ts';
import { bookOf, IDENTITY_CONTEXT, LocalIdentity, REATTEST_CONTEXT, type IdentityDoc, type Manifest } from '../src/identity.ts';
import { Log, type Receipt } from '../src/log.ts';
import { FktsNode } from '../src/node.ts';

const OLD_SESSION = 'roflenox session';

export interface Migrated {
  receipts: number;
  batches: number;
  facts: number;
  rewritten: number;
  forks_dropped: number;
  identities: Record<string, string>;
  health: Record<string, unknown>;
}

interface Signer { me: LocalIdentity; doc: IdentityDoc }

function readKeyFile(dir: string): { identity: string; private_key: string; enc_private_key: string; docs: IdentityDoc[] } {
  return JSON.parse(fs.readFileSync(LocalIdentity.keyPath(dir), 'utf8'));
}

/** The key file of `dir`, its document signed again under the new context. */
function migrateKey(oldDir: string, newDir: string): Signer {
  const k = readKeyFile(oldDir);
  if (k.docs.length !== 1) {
    throw new Error(`${k.identity}: its key file holds ${k.docs.length} identity documents (a rotation or recovery); only the first-key document can be signed again here`);
  }
  // A key file is written 0600 and LocalIdentity.load refuses anything wider.
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(newDir)), '.fkts-migrate-'));
  try {
    fs.mkdirSync(path.join(tmp, 'key'), { mode: 0o700 });
    fs.writeFileSync(LocalIdentity.keyPath(tmp), JSON.stringify(k), { mode: 0o600 });
    const old = LocalIdentity.load(tmp)!;
    const body = k.docs[0]!.doc;
    const doc: IdentityDoc = { doc: body, key_id: old.keyId, sig: old.sign(IDENTITY_CONTEXT, body).sig };
    fs.mkdirSync(path.join(newDir, 'key'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(LocalIdentity.keyPath(newDir), JSON.stringify({ ...k, docs: [doc] }), { mode: 0o600 });
    return { me: LocalIdentity.load(newDir)!, doc };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every receipt the old index has committed, and the log head after each. */
function oldIndex(oldDir: string): { receipts: Receipt[]; heads: string[] } {
  const text = fs.readFileSync(path.join(oldDir, 'log', 'index.jsonl'), 'utf8');
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((l) => l.length > 0);
  const run = crypto.createHash('sha256');
  const heads = [run.copy().digest('hex')];
  const receipts = lines.map((l) => { run.update(`${l}\n`); heads.push(run.copy().digest('hex')); return JSON.parse(l) as Receipt; });
  return { receipts, heads };
}

export async function migrate(oldDir: string, newDir: string, also: { from: string; to: string }[] = [], bin?: string): Promise<Migrated> {
  if (fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0) throw new Error(`${newDir} is not empty; the migration writes a fresh data directory`);
  if (!fs.existsSync(LocalIdentity.keyPath(oldDir))) throw new Error(`${oldDir} has no key/identity.json: not a node's data directory`);
  for (const a of also) if (fs.existsSync(a.to)) throw new Error(`${a.to} exists; each --also identity's key is written to a fresh directory`);
  const { receipts, heads } = oldIndex(oldDir);
  const stage = `${newDir}.migrating-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    const owner = migrateKey(oldDir, stage);
    const signers = new Map<string, Signer>([[owner.me.name, owner]]);
    for (const a of also) {
      const s = migrateKey(a.from, a.to);
      signers.set(s.me.name, s);
    }

    // Sessions: old name → grant, from the old node's OAuth state.
    const oauthFile = path.join(oldDir, 'oauth', 'state.json');
    const grants: string[] = fs.existsSync(oauthFile) ? Object.keys(JSON.parse(fs.readFileSync(oauthFile, 'utf8')).grants ?? {}) : [];
    const sessionOf = new Map(grants.map((g) => [`s${sha256hex(`${OLD_SESSION} ${g}`).slice(0, 10)}.${owner.me.name}`, g]));

    // Every string the rename touches, longest first.
    const names = new Map<string, string>();
    const subst: [string, string][] = [['sys_roflenox', 'sys_fkts'], ['roflenox:', 'fkts:']];
    const ids = new Map<string, string>();
    const rename = (s: string): string => {
      const id = ids.get(s);
      if (id) return id;
      for (const [a, b] of subst) if (s.includes(a)) s = s.split(a).join(b);
      return s;
    };
    const oldLog = new Log(oldDir);
    const docOf = (r: Receipt): IdentityDoc => oldLog.readIdentity(r);

    // The identity each old name becomes, and how it signs there.
    const signerOf = (name: string, doc: IdentityDoc | null): Signer => {
      const known = signers.get(names.get(name) ?? name);
      if (known) return known;
      const grant = sessionOf.get(name);
      if (grant === undefined) {
        throw new Error(`${name}: no key for it here (pass its data directory with --also, or it is another node's identity mirrored in, which this migration cannot sign again)`);
      }
      const label = `${grant} ${owner.me.keyId}`;
      const fresh = `s${sha256hex(`fkts session ${grant}`).slice(0, 10)}.${owner.me.name}`;
      const issued = new Date((doc ?? owner.doc).doc.issued_at);
      const me = LocalIdentity.derive(owner.me, fresh, label, issued);
      const s = { me, doc: me.identityDoc() };
      names.set(name, fresh);
      subst.unshift([name, fresh], [bookOf(name), bookOf(fresh)]);
      signers.set(fresh, s);
      return s;
    };
    signerOf(owner.me.name, null);
    // Every session is renamed before the first fact that may name it.
    for (const r of receipts) if (r.kind === 'identity' && sessionOf.has(r.identity)) signerOf(r.identity, docOf(r));

    const log = new Log(stage);
    log.open();
    const newHeads = [log.head()];
    const prevOf = new Map<string, string | null>();
    let batches = 0, facts = 0, rewritten = 0, forks = 0;
    const refused: string[] = [];
    for (const r of receipts) {
      if (r.kind === 'fork') { forks++; continue; }
      if (r.kind === 'identity') {
        const doc = docOf(r);
        try {
          const s = signerOf(r.identity, doc);
          log.appendIdentity(s.doc, r.received_at);
        } catch (e) { refused.push((e as Error).message); }
        newHeads.push(log.head());
        continue;
      }
      if (r.withheld) { refused.push(`${r.identity}'s batch ${r.digest} was mirrored withheld: its content is not here to sign again`); continue; }
      const old = oldLog.read(r);
      let s: Signer;
      try { s = signerOf(r.identity, old.pinned); } catch (e) { refused.push((e as Error).message); continue; }
      if (!sessionOf.has(r.identity) && old.manifest.key_id !== s.me.keyId) {
        refused.push(`${r.identity}'s batch ${r.digest} is signed by key ${old.manifest.key_id.slice(0, 12)}…, not the key held here`);
        continue;
      }
      const before = parseJsonl(old.jsonl!, false);
      const after: Fact[] = before.map((f) => ({ ...f, source: rename(f.source), relation: rename(f.relation), target: rename(f.target) }));
      after.forEach((f, i) => {
        const a = factId(before[i]!), b = factId(f);
        if (a !== b) { ids.set(a, b); rewritten++; }
      });
      const jsonl = toJsonl(after);
      const prev = prevOf.get(s.me.name) ?? null;
      const n = r.received_at;
      const knewAt = old.manifest.knew === undefined ? -1 : heads.indexOf(old.manifest.knew);
      const knew = knewAt >= 0 && knewAt < newHeads.length ? newHeads[knewAt] : undefined;
      const manifest: Manifest = s.me.signBatch(jsonl, prev, old.manifest.claimed_at, old.salt!, knew);
      const reattest = r.reattest ? s.me.sign(REATTEST_CONTEXT, { identity: s.me.name, key_id: s.me.keyId, digest: manifest.digest, attested_at: r.reattest.attested_at }) : undefined;
      if (manifest.digest !== batchDigest(old.salt!, jsonl)) throw new Error('digest mismatch');
      log.append(manifest, jsonl, n, old.pinned ? s.doc : null, {
        ...(r.via ? { via: r.via } : {}), ...(reattest ? { reattest } : {}), salt: old.salt!,
      });
      prevOf.set(s.me.name, manifest.digest);
      newHeads.push(log.head());
      batches++;
      facts += after.length;
    }
    if (refused.length > 0) throw new Error(`nothing was migrated; these cannot be signed again:\n  ${[...new Set(refused)].join('\n  ')}`);

    for (const f of ['oauth/state.json', 'key/operator-token']) {
      const from = path.join(oldDir, f);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, path.join(stage, f));
      fs.chmodSync(path.join(stage, f), 0o600);
    }

    // The proof: NEW opens as a node, every signature and chain re-checked.
    const node = await FktsNode.open({ dataDir: stage, ...(bin ? { bin } : {}) });
    const health = node.health(true);
    await node.close();
    if ((health.warnings as string[]).length > 0 || (health.recovered as string[]).length > 0) {
      throw new Error(`the migrated log opens with warnings: ${JSON.stringify([health.warnings, health.recovered])}`);
    }
    fs.renameSync(stage, newDir);
    return { receipts: log.receipts.length, batches, facts, rewritten, forks_dropped: forks, identities: Object.fromEntries(names), health };
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    for (const a of also) fs.rmSync(a.to, { recursive: true, force: true });
    throw e;
  }
}
