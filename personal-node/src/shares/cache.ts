// Caches loaded SnapshotGraphStore instances per share so every MCP tool call
// doesn't re-read and re-parse JSONL from disk. Invalidated by comparing the
// mtime of nodes.jsonl — refreshShare()/revokeShare() touch or delete that file,
// so a stale cache entry self-heals on the next request without any explicit
// invalidation call from the handlers.
import { loadSnapshotStore, snapshotMtime, SnapshotGraphStore } from './snapshot-store.js';

interface CacheEntry {
  store: SnapshotGraphStore;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

export function getSnapshotStore(shareId: string, shareName: string): SnapshotGraphStore | null {
  const mtimeMs = snapshotMtime(shareId);
  if (mtimeMs === null) {
    cache.delete(shareId);
    return null;
  }

  const cached = cache.get(shareId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.store;

  const store = loadSnapshotStore(shareId, shareName);
  if (!store) return null;

  cache.set(shareId, { store, mtimeMs });
  return store;
}

export function evictSnapshotStore(shareId: string): void {
  cache.delete(shareId);
}
