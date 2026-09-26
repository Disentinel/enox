#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// roflenox — the user-facing CLI. It speaks in identity names and counts and
// never prints a key, key id, fingerprint or signature (r_identity_names).
//
//   roflenox init [--name N]                  create this node's identity
//   roflenox serve [--port P] [--host H]      run the node
//   roflenox publish <file.jsonl>             sign facts as this identity and post them
//   roflenox ask "<query>" | --why "<lit>" | --whynot "<lit>"
//   roflenox mirror <peer-url> <identity>     pull an identity's feed and admit it here
//   roflenox rotate                           a new key, signed over by the current one
//   roflenox recover <backup-code>            revoke every key and start a new one
//   roflenox seal <file.jsonl> --to a,b --out e.json   publish privately, sealed to a and b
//   roflenox open <e.json | url>              open a sealed batch addressed to this identity and admit it
//   roflenox checkpoint --out <dir>           write the public feed + a signed checkpoint for static hosting
//   roflenox backup --to <dir>                copy the log up to its last receipt, verified; or serve --backup-to/--backup-every
//
// The recovery code printed ONCE by init (or by the first serve) is the only
// key material the CLI ever shows, and `recover` the only command that takes
// any: the spec hands the user that code as a backup (r_recovery).
//
// --data DIR (or ROFLENOX_DATA, default ~/.roflenox) is the node's directory;
// --url U (or ROFLENOX_URL, default http://127.0.0.1:7380) the node to talk to.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalIdentity } from './identity.ts';
import { RoflenoxNode } from './node.ts';
import { backup } from './backup.ts';
import { createServer, listen } from './http.ts';
import { admitSealed, ask, headOf, identityChain, introduce, mirror, publish, publishSealed, readFacts, writeStaticFeed } from './client.ts';

/** Create the identity and hand over the recovery code, once. It is printed
 *  here and stored nowhere; losing it loses the way back from a stolen key. */
function created(data: string, name: string | undefined): LocalIdentity {
  const me = LocalIdentity.create(data, name ?? os.hostname().replace(/[^A-Za-z0-9._@-]/g, '-'));
  process.stderr.write(`recovery code for ${me.name} — shown once, stored nowhere; write it down:\n  ${me.recoveryCode}\n`);
  return me;
}

function flags(argv: string[]): { pos: string[]; f: Record<string, string> } {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) f[a.slice(2)] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, f };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, f } = flags(rest);
  const data = f.data ?? process.env.ROFLENOX_DATA ?? path.join(os.homedir(), '.roflenox');
  const url = (f.url ?? process.env.ROFLENOX_URL ?? 'http://127.0.0.1:7380').replace(/\/$/, '');
  const say = (s: string) => process.stdout.write(`${s}\n`);

  switch (cmd) {
    case 'init': {
      const existing = LocalIdentity.load(data);
      const me = existing ?? created(data, f.name);
      say(`identity ${me.name} ready in ${data}`);
      return 0;
    }
    case 'serve': {
      if (!LocalIdentity.load(data)) created(data, f.name);
      const node = await RoflenoxNode.open({
        dataDir: data,
        freshnessSec: f.freshness ? Number(f.freshness) : undefined,
        publicUrl: f['public-url'] ?? process.env.ROFLENOX_PUBLIC_URL,
        checkpointWindowSec: f['checkpoint-window'] ? Number(f['checkpoint-window']) : undefined,
      });
      for (const r of node.log.recovered) process.stderr.write(`recovered: ${r}\n`);
      const server = createServer(node);
      const at = await listen(server, Number(f.port ?? 7380), f.host ?? '127.0.0.1');
      say(`serving ${node.identity!.name} at ${at}`);
      if (f['backup-to']) {
        // A backup on a schedule (r_backup): at most one period of writes is lost.
        const every = Number(f['backup-every'] ?? 3600) * 1000;
        const run = () => backup(data, f['backup-to']!).then(
          (r) => process.stderr.write(`backup: ${r.receipts} receipts to ${r.dir}\n`),
          (e: Error) => process.stderr.write(`backup failed: ${e.message}\n`));
        void run();
        setInterval(run, every).unref();
      }
      const stop = async () => {
        server.close();
        await node.close({ snapshot: true });
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return new Promise(() => {}); // runs until signalled
    }
    case 'rotate': {
      const me = LocalIdentity.load(data);
      if (!me) throw new Error(`no identity in ${data}; run: roflenox init`);
      const next = me.rotate(data, new Date());
      await introduce(url, next);
      say(`rotated ${next.name}'s key`);
      return 0;
    }
    case 'recover': {
      // The one command that takes key material: the backup code, typed back.
      if (!pos[0]) throw new Error('usage: roflenox recover <backup-code>');
      const me = LocalIdentity.load(data);
      const name = f.name ?? me?.name;
      if (!name) throw new Error('usage: roflenox recover <backup-code> --name <identity>');
      const chain = await identityChain(url, name);
      const head = await headOf(url, name);
      const next = LocalIdentity.recover(data, pos[0], chain, head, new Date());
      await introduce(url, next);
      say(`recovered ${next.name}: every earlier key is revoked and a new one is in use`);
      return 0;
    }
    case 'publish': {
      if (!pos[0]) throw new Error('usage: roflenox publish <file.jsonl>');
      const me = LocalIdentity.load(data);
      if (!me) throw new Error(`no identity in ${data}; run: roflenox init`);
      const r = await publish(url, me, readFacts(fs.readFileSync(pos[0], 'utf8')));
      say(`published ${r.facts} facts as ${r.identity}`);
      return 0;
    }
    case 'seal': {
      if (!pos[0] || !f.to || !f.out) throw new Error('usage: roflenox seal <file.jsonl> --to <identity>[,<identity>...] --out <envelope.json>');
      const me = LocalIdentity.load(data);
      if (!me) throw new Error(`no identity in ${data}; run: roflenox init`);
      const e = await publishSealed(url, me, readFacts(fs.readFileSync(pos[0], 'utf8')), f.to.split(','));
      fs.writeFileSync(f.out, JSON.stringify(e));
      say(`sealed a batch of ${me.name} for ${f.to.split(',').join(', ')} into ${f.out}`);
      return 0;
    }
    case 'open': {
      if (!pos[0]) throw new Error('usage: roflenox open <envelope.json | url>');
      const me = LocalIdentity.load(data);
      if (!me) throw new Error(`no identity in ${data}; run: roflenox init`);
      const text = /^https?:/.test(pos[0]) ? await (await fetch(pos[0])).text() : fs.readFileSync(pos[0], 'utf8');
      await admitSealed(url, JSON.parse(text));
      say(`opened and admitted a sealed batch for ${me.name}`);
      return 0;
    }
    case 'backup': {
      if (!f.to) throw new Error('usage: roflenox backup --to <dir>');
      const r = await backup(data, f.to);
      say(`backed up ${r.receipts} receipts to ${r.dir}`);
      return 0;
    }
    case 'checkpoint': {
      if (!f.out) throw new Error('usage: roflenox checkpoint --out <static-dir>');
      const me = LocalIdentity.load(data);
      if (!me) throw new Error(`no identity in ${data}; run: roflenox init`);
      await writeStaticFeed(url, me, f.out);
      say(`checkpointed ${me.name}'s public feed into ${f.out}`);
      return 0;
    }
    case 'ask': {
      const body = f.why ? { why: f.why } : f.whynot ? { whynot: f.whynot } : { query: pos[0] };
      if (!body.query && !f.why && !f.whynot) throw new Error('usage: roflenox ask "<query>"');
      const r = await ask(url, body, LocalIdentity.load(data) ?? undefined);
      if (r.why || r.whynot) {
        for (const e of (r.why ?? r.whynot) as { identity: string; text: string }[]) say(`[${e.identity}] ${e.text}`);
      } else {
        const rows = r.rows as { identity: string; cells: unknown[] }[];
        for (const row of rows) say(`${row.identity}\t${row.cells.map((c) => JSON.stringify(c)).join('\t')}`);
        say(`${rows.length} rows`);
      }
      return 0;
    }
    case 'mirror': {
      if (!pos[0] || !pos[1]) throw new Error('usage: roflenox mirror <peer-url> <identity>');
      const r = await mirror(url, pos[0].replace(/\/$/, ''), pos[1], LocalIdentity.load(data) ?? undefined);
      say(`mirrored ${r.batches} batches of ${r.identity}`);
      return 0;
    }
    default:
      say('usage: roflenox init | serve | publish <file.jsonl> | ask "<query>" | mirror <peer-url> <identity> | rotate | recover <code>');
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e: Error) => {
  process.stderr.write(`roflenox: ${e.message}\n`);
  process.exit(1);
});
