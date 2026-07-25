import { createHash, randomBytes } from 'node:crypto';

export function nanoid(size = 12): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}

export function computeFactId(source: string, relation: string, target: string): string {
  return createHash('sha256')
    .update(`${source}|${relation}|${target}`)
    .digest('hex');
}

// Truncate long text for display fields (e.g. entity `name`) without cutting
// mid-word. Only truncates when text exceeds maxLen; appends an ellipsis so
// callers can tell at a glance the field was shortened (unlike a bare
// substring cut, which silently drops the tail).
export function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return boundary + '…';
}

// Serializes concurrent check-then-write sequences on the same fact_id within
// this process. Kuzu's Assertion rel table has no unique constraint on
// fact_id (only node tables support PRIMARY KEY), so the existing-row check
// used before every assertion CREATE is the only guard — and a plain
// `if (await queryOne(check)) ... else CREATE` has a window between the two
// awaits where a second concurrent call for the same fact_id can also see
// "not found". This queues same-fact_id callers instead of letting them
// interleave. Per-process only (matches the deployment: a single Kuzu
// connection, single Node process — Kuzu itself takes an exclusive file lock
// that prevents a second process from opening the same store at all).
const factIdLocks = new Map<string, Promise<unknown>>();

export async function withFactIdLock<T>(factId: string, fn: () => Promise<T>): Promise<T> {
  const prior = factIdLocks.get(factId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const myTurn = prior.then(() => gate);
  factIdLocks.set(factId, myTurn);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (factIdLocks.get(factId) === myTurn) factIdLocks.delete(factId);
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Short random slug over the base58 alphabet (no 0/O/I/l ambiguity) — used for share IDs.
export function randomSlug(size = 10): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += BASE58_ALPHABET[bytes[i] % BASE58_ALPHABET.length];
  return out;
}

// Long random hex token — used for share credentials (independent of the main auth token).
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
