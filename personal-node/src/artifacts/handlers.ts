import type { Request, Response } from 'express';
import fs from 'node:fs';
import { CreateArtifactSchema, UpdateArtifactSchema, ListArtifactsQuery } from './validators.js';
import { blobPath, sha256Of, writeBlob, readBlob, deleteBlob, decodeBody } from './blob.js';
import {
  getArtifactRecord, updateArtifactRecord, deleteArtifactRecord,
} from './store.js';
import {
  updateArtifactEntity, deleteArtifactEntity,
  materializeOkfEdges, materializeExplicitLinks,
} from './graph.js';
import { parseOkfRelations } from './okf.js';
import { createArtifact, listArtifacts, getArtifact, isMarkdown } from './service.js';

// create / list / get are thin HTTP adapters over service.ts — the create/list/get
// orchestration lives there once and is shared with the MCP tools (see
// src/mcp/tools.ts). Handlers own only the transport concerns: request parsing,
// status codes, and response shape. getRaw/update/remove have no MCP counterpart
// in this pass and keep their own logic.

export async function create(req: Request, res: Response): Promise<void> {
  const parsed = CreateArtifactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const r = await createArtifact(parsed.data);
    // Dedup: the same body re-posted to the same domain returns the existing
    // record (200, deduped:true) instead of 409, so idempotent re-ingestion
    // needs no special "already exists" handling on the caller side.
    if (r.deduped) {
      res.status(200).json({
        id: r.id, entity_id: r.entity_id, size: r.size, sha256: r.sha256,
        links_created: 0, edges_materialized: 0, deduped: true,
      });
      return;
    }
    res.status(201).json({
      id: r.id, entity_id: r.entity_id, size: r.size, sha256: r.sha256,
      links_created: r.links_created, edges_materialized: r.edges_materialized,
    });
  } catch (err: unknown) {
    // createArtifact already rolled back any partial state.
    res.status(500).json({ error: 'Failed to create artifact', detail: err instanceof Error ? err.message : String(err) });
  }
}

export function list(req: Request, res: Response): void {
  const parsed = ListArtifactsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(listArtifacts(parsed.data));
}

export async function get(req: Request, res: Response): Promise<void> {
  const result = await getArtifact(req.params.id as string, { includeBody: false });
  if (!result) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  res.json(result);
}

export function getRaw(req: Request, res: Response): void {
  const record = getArtifactRecord(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  const filePath = blobPath(record.id, record.content_type, record.filename ?? undefined);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Artifact blob missing on disk' });
    return;
  }
  res.setHeader('Content-Type', record.content_type);
  res.send(readBlob(filePath));
}

export async function update(req: Request, res: Response): Promise<void> {
  const record = getArtifactRecord(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }

  const parsed = UpdateArtifactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;

  const newTitle = input.title ?? record.title;
  const newDomain = input.domain ?? record.domain;
  const newContentType = input.content_type ?? record.content_type;
  const newFilename = input.filename !== undefined ? input.filename : record.filename ?? undefined;

  const oldPath = blobPath(record.id, record.content_type, record.filename ?? undefined);
  const newPath = blobPath(record.id, newContentType, newFilename);

  // Recompute buf/size/sha256 unconditionally: either the caller's new body,
  // or (if body wasn't part of this PUT) the existing bytes read back — keeps
  // size/sha256 correct even when only content_type/filename changed and the
  // blob simply moved to a new path.
  const buf = input.body !== undefined ? decodeBody(input.body, input.encoding) : readBlob(oldPath);
  const sha256 = sha256Of(buf);

  try {
    writeBlob(newPath, buf);
    if (newPath !== oldPath) deleteBlob(oldPath);

    updateArtifactRecord(record.id, {
      title: newTitle, domain: newDomain, content_type: newContentType,
      filename: newFilename ?? null, size: buf.length, sha256,
    });
    await updateArtifactEntity(record.entity_id, { title: newTitle, domain: newDomain });

    // Re-materialization only happens when explicitly requested this call —
    // see graph.ts header comment on why the two edge sets are independent.
    let edgesMaterialized: number | null = null;
    if (input.parse_okf === true && isMarkdown(newContentType)) {
      const edges = parseOkfRelations(buf.toString('utf8'), newDomain, record.entity_id);
      const result = await materializeOkfEdges(record.entity_id, record.id, edges);
      edgesMaterialized = result.created;
    }

    let linksCreated: number | null = null;
    if (input.links !== undefined) {
      const result = await materializeExplicitLinks(record.entity_id, record.id, input.links);
      linksCreated = result.created;
    }

    const updated = getArtifactRecord(record.id);
    res.json({ ...updated, links_created: linksCreated, edges_materialized: edgesMaterialized });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to update artifact', detail: err instanceof Error ? err.message : String(err) });
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const record = getArtifactRecord(req.params.id as string);
  if (!record) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }

  const filePath = blobPath(record.id, record.content_type, record.filename ?? undefined);
  deleteBlob(filePath);
  await deleteArtifactEntity(record.entity_id); // DETACH DELETE also removes every edge touching the node
  deleteArtifactRecord(record.id);

  res.status(204).end();
}
