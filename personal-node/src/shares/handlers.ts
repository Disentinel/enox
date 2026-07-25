import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { getShare, setShareCounts } from './store.js';
import { exportShareSnapshot } from './snapshot.js';
import { evictSnapshotStore } from './cache.js';
import { CreateShareSchema } from './validators.js';
import { createShare, listSharesWithUrls, revokeShareById } from './service.js';

// These handlers are thin HTTP adapters over service.ts — the create/list/revoke
// orchestration lives there once and is shared with the MCP tools (see
// src/mcp/tools.ts). Handlers own only the transport concerns: request parsing,
// status codes, and error JSON. `refresh` has no MCP counterpart and keeps its
// own (store + snapshot) logic.

export async function create(req: Request, res: Response): Promise<void> {
  let input;
  try {
    input = CreateShareSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.flatten() });
      return;
    }
    throw err;
  }

  try {
    const result = await createShare(input);
    res.status(201).json(result);
  } catch (err: unknown) {
    // Snapshot export failed — createShare already rolled the share back.
    res.status(500).json({ error: 'Failed to export share snapshot', detail: err instanceof Error ? err.message : String(err) });
  }
}

export function list(_req: Request, res: Response): void {
  res.json(listSharesWithUrls());
}

export function remove(req: Request, res: Response): void {
  const revoked = revokeShareById(req.params.id as string);
  if (!revoked) {
    res.status(404).json({ error: 'Share not found' });
    return;
  }
  res.status(204).end();
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const share = getShare(req.params.id as string);
  if (!share) {
    res.status(404).json({ error: 'Share not found' });
    return;
  }
  if (share.revoked) {
    res.status(410).json({ error: 'This share has been revoked' });
    return;
  }

  try {
    const { node_count, edge_count, artifact_count } = await exportShareSnapshot(share.id, share.domains);
    setShareCounts(share.id, node_count, edge_count);
    evictSnapshotStore(share.id);
    res.json({ id: share.id, node_count, edge_count, artifact_count });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to refresh share snapshot', detail: err instanceof Error ? err.message : String(err) });
  }
}
