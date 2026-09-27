// Backup (r_backup): a copy of the log up to a committed receipt, verified by
// rebuilding a node from it.
//
// Consistent while the node runs, with no lock: a receipt is committed only
// after every file it names is durable, and committed files never change. So
// the backup reads the index ONCE, keeps its complete lines, and copies
// exactly the files those receipts name — anything admitted meanwhile is simply
// not in this backup. The copy is assembled in a staging directory, rebuilt
// into a throwaway node (every signature, chain link and digest re-checked),
// and only then swapped in as <to>/latest. A backup that does not rebuild is
// never installed.
//
// <to>/latest is a SYMLINK to the snapshot directory (r_atomic_write): the
// swap is one rename of a new link over the old one, so a process killed at
// any step leaves latest naming a whole backup — the previous or the new.
//
// Where <to> lives is the operator's choice; r_backup wants it off the host
// (a mounted volume, a synced directory). Run it on a schedule with
// `roflenox serve --backup-to <dir> --backup-every <sec>` or from cron with
// `roflenox backup --to <dir>`; at most one period of writes can be lost.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256hex } from './facts.ts';
import { bookOf } from './identity.ts';
import type { Fault, Receipt } from './log.ts';
import { RoflenoxNode } from './node.ts';

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export interface BackupResult { dir: string; receipts: number; log_head: string; at: string }

export async function backup(dataDir: string, toDir: string,
  o: { bin?: string; now?: () => number; /** test seam: runs right after the index is read */ afterIndexRead?: () => Promise<void>;
    /** test seam: called at each step of the swap (a crash test kills the process there) */ fault?: Fault } = {}): Promise<BackupResult> {
  const now = o.now ?? Date.now;
  const fault = o.fault ?? (() => {});
  const log = path.join(dataDir, 'log');
  const all = fs.existsSync(path.join(log, 'index.jsonl')) ? fs.readFileSync(path.join(log, 'index.jsonl')) : Buffer.alloc(0);
  const index = all.subarray(0, all.lastIndexOf(0x0a) + 1);     // committed lines only
  const receipts = index.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Receipt);
  await o.afterIndexRead?.();

  fs.mkdirSync(toDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(toDir, 'snap-'));
  let installed = false;
  try {
    const copy = (rel: string) => {
      const to = path.join(staging, 'log', rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(log, rel), to);
    };
    for (const r of receipts) {
      const book = bookOf(r.identity);
      if (r.pin) copy(path.join(book, `identity-${r.pin}.json`));
      if (r.kind === 'identity') continue;
      if (!r.withheld) copy(path.join(book, `${r.digest}.jsonl`));
      copy(path.join(book, `${r.digest}.manifest.json`));
    }
    fs.writeFileSync(path.join(staging, 'log', 'index.jsonl'), index);

    // Verify: a node rebuilt from the copy alone, every check re-run.
    const n = await RoflenoxNode.open({ dataDir: staging, bin: o.bin, now });
    const head = n.log.head();
    const batches = n.log.receipts.filter((r) => r.kind !== 'identity').length;
    await n.close();
    if (head !== sha256hex(index) || batches !== receipts.filter((r) => r.kind !== 'identity').length) {
      throw new Error('the backup did not rebuild to the log it was copied from');
    }
    const result: BackupResult = { dir: path.join(toDir, 'latest'), receipts: receipts.length, log_head: head, at: new Date(now()).toISOString() };
    fs.writeFileSync(path.join(staging, 'backup.json'), JSON.stringify(result));

    fsyncDir(staging);
    fault('backup:staged');

    // Swap in: a new link renamed over latest; the previous snapshot goes
    // only once nothing names it.
    const latest = path.join(toDir, 'latest');
    let old = fs.existsSync(latest) ? fs.realpathSync(latest) : null;
    if (old !== null && !fs.lstatSync(latest).isSymbolicLink()) {
      // A backup made before latest was a link: a real directory cannot be
      // replaced by a rename, so it becomes a snapshot first (once).
      old = `${staging}-before`;
      fs.renameSync(latest, old);
      fault('backup:migrated');
    }
    const link = path.join(toDir, `.latest-${path.basename(staging)}`);
    fs.symlinkSync(path.basename(staging), link);
    fault('backup:link-written');
    fs.renameSync(link, latest);
    installed = true;
    fsyncDir(toDir);
    fault('backup:swapped');
    if (old !== null && old !== fs.realpathSync(staging)) fs.rmSync(old, { recursive: true, force: true });
    fault('backup:old-removed');
    return result;
  } catch (e) {
    if (!installed) fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
