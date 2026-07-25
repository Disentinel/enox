// Transport-agnostic share management: create / list / revoke orchestration,
// shared by BOTH the REST handlers (handlers.ts, mounted at /api/shares) and
// the MCP tools (src/mcp/tools.ts). Single implementation so the two surfaces
// can never drift (same rollback-on-snapshot-failure, same URL construction,
// same not-found semantics). The domain gate itself lives in the zod schemas
// at each edge (CreateShareSchema for REST, create_share inputSchema for MCP);
// this layer assumes `input.domains` is already a validated non-empty array.
import { loadConfig } from '../config.js';
import { createShareRecord, listShares, getShare, setShareCounts, revokeShare, hardDeleteShare } from './store.js';
import { exportShareSnapshot, deleteShareSnapshot } from './snapshot.js';
import { evictSnapshotStore } from './cache.js';
import type { CreateShareInput, ShareRecord } from './types.js';

function shareUrl(id: string, token: string): string {
  const config = loadConfig();
  return `${config.publicBaseUrl}/share/${id}?token=${token}`;
}

export interface CreatedShare {
  id: string;
  url: string;
  token: string;
  node_count: number;
  edge_count: number;
  artifact_count: number;
}

// Creates the metadata row, exports the snapshot, records the counts. If the
// snapshot export throws the share never became usable, so it is rolled back
// (hard delete of the row + snapshot dir) and the error re-thrown for the
// caller to surface (REST → 500, MCP → isError result).
export async function createShare(input: CreateShareInput): Promise<CreatedShare> {
  const share = createShareRecord({
    name: input.name,
    description: input.description,
    domains: input.domains,
    ttlDays: input.ttl_days,
  });

  try {
    const { node_count, edge_count, artifact_count } = await exportShareSnapshot(share.id, share.domains);
    setShareCounts(share.id, node_count, edge_count);
    return {
      id: share.id,
      url: shareUrl(share.id, share.token),
      token: share.token,
      node_count,
      edge_count,
      artifact_count,
    };
  } catch (err) {
    hardDeleteShare(share.id);
    deleteShareSnapshot(share.id);
    throw err;
  }
}

export type ShareWithUrl = ShareRecord & { url: string | null };

// All shares, newest first, each with its resolvable url (null once revoked —
// a revoked share keeps its row so /share/:id can answer 410, but has no live url).
export function listSharesWithUrls(): ShareWithUrl[] {
  return listShares().map(s => ({
    ...s,
    url: s.revoked ? null : shareUrl(s.id, s.token),
  }));
}

// Revokes a share and tears down its snapshot + cached store. Returns false if
// no such share exists (caller maps to 404 / not-found), true on revoke.
export function revokeShareById(id: string): boolean {
  const share = getShare(id);
  if (!share) return false;
  revokeShare(share.id);
  deleteShareSnapshot(share.id);
  evictSnapshotStore(share.id);
  return true;
}
