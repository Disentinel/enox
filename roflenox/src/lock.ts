// One process at a time owns a data directory (r_single_writer). serve, stdio
// and every local operation that signs take <data>/lock before they read or
// write anything else in it; a second process refuses to start and names the
// holder. Two owners would each keep a log and sign a successor of the same
// head — the node's own chain forked, and it would refuse to start again.
//
// The lock file is created whole or not at all: its content is written to a
// private temp file first and hard-linked into place, and a link fails if the
// name exists. A lock whose pid is dead on this host is stale and is taken
// over, one taker at a time (a takeover directory is the mutex). A holder on
// another host cannot be checked from here, so it is refused like a live one.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Refusal } from './facts.ts';

export interface Holder { pid: number; host: string; role: string; since: string; url?: string; token: string }

/** A takeover mutex older than this was left by a taker that died. */
export const TAKEOVER_STALE_MS = 10_000;

export const lockPath = (dataDir: string) => path.join(dataDir, 'lock');

/** Read the holder of a data directory, or null when nobody holds it. */
export function holderOf(dataDir: string): Holder | null {
  let text: string;
  try { text = fs.readFileSync(lockPath(dataDir), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(text) as Holder; } catch { return { pid: -1, host: '?', role: 'unknown', since: '?', token: text }; }
}

/** Whether a holder is still running. A pid on another host cannot be seen
 *  from here and counts as running. */
export function alive(h: Holder): boolean {
  if (h.host !== os.hostname()) return true;
  if (!Number.isInteger(h.pid) || h.pid <= 0) return false;
  try { process.kill(h.pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const describe = (h: Holder) =>
  `${h.role} (pid ${h.pid} on ${h.host}, since ${h.since}${h.url ? `, at ${h.url}` : ''})`;

export function refusal(dataDir: string, h: Holder): Refusal {
  return new Refusal(423, 'data_dir_locked',
    `the data directory ${dataDir} is held by ${describe(h)}; one process owns a data directory at a time — stop it first, or give this one its own data directory`,
    { holder: { pid: h.pid, host: h.host, role: h.role, since: h.since, ...(h.url ? { url: h.url } : {}) } });
}

export class DataLock {
  private released = false;
  private readonly onExit = () => this.release();
  readonly dataDir: string;
  readonly holder: Holder;
  private constructor(dataDir: string, holder: Holder) {
    this.dataDir = dataDir;
    this.holder = holder;
    process.on('exit', this.onExit);
  }

  /** Take the data directory, or refuse naming its holder. Nothing in the
   *  directory is read or written first; a missing directory is created. */
  static acquire(dataDir: string, role: string, o: { now?: () => number } = {}): DataLock {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const me: Holder = { pid: process.pid, host: os.hostname(), role, since: new Date((o.now ?? Date.now)()).toISOString(),
      token: crypto.randomBytes(12).toString('hex') };
    const target = lockPath(dataDir);
    for (let attempt = 0; attempt < 5; attempt++) {
      const tmp = `${target}.${process.pid}.${me.token}`;
      fs.writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
      try {
        fs.linkSync(tmp, target);
        return new DataLock(dataDir, me);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      const h = holderOf(dataDir);
      if (h === null) continue;                       // released meanwhile: try again
      if (alive(h)) throw refusal(dataDir, h);
      DataLock.takeOver(dataDir, h);
    }
    const h = holderOf(dataDir);
    throw refusal(dataDir, h ?? { pid: -1, host: '?', role: 'another process', since: '?', token: '' });
  }

  /** Remove a stale lock — only the one that was seen stale, and only by one
   *  taker at a time; everyone then races for the name again. */
  private static takeOver(dataDir: string, stale: Holder): void {
    const mutex = `${lockPath(dataDir)}.takeover`;
    try { fs.mkdirSync(mutex); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another taker is at it (a takeover is a read and an unlink); one that
      // died in the middle left its mutex, which is removed once it is old.
      try { if (Date.now() - fs.statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) fs.rmdirSync(mutex); } catch { /* gone meanwhile */ }
      return;
    }
    try {
      const now = holderOf(dataDir);
      if (now !== null && now.token === stale.token && !alive(now)) fs.rmSync(lockPath(dataDir), { force: true });
    } finally {
      fs.rmdirSync(mutex);
    }
  }

  /** Say where this holder can be reached (serve, once it listens): a local
   *  operation that signs may then go through it instead of refusing. */
  note(url: string): void {
    const next: Holder = { ...this.holder, url };
    const tmp = `${lockPath(this.dataDir)}.${process.pid}.${this.holder.token}`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, lockPath(this.dataDir));
    this.holder.url = url;
  }

  /** Let go, if the lock is still this process's own. */
  release(): void {
    if (this.released) return;
    this.released = true;
    process.off('exit', this.onExit);
    try {
      if (holderOf(this.dataDir)?.token === this.holder.token) fs.rmSync(lockPath(this.dataDir), { force: true });
    } catch { /* the directory is gone: nothing to let go of */ }
  }
}
