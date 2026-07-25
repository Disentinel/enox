// Transport-agnostic artifact orchestration: create / list / get, shared by
// BOTH the REST handlers (handlers.ts, mounted at /api/artifacts) and the MCP
// tools (src/mcp/tools.ts). Single implementation so the two surfaces can never
// drift (same sha256 dedup early-return, same blob write + rollback, same OKF /
// explicit-link materialization). The domain gate itself lives in the zod
// schemas at each edge (CreateArtifactSchema for REST, create_artifact
// inputSchema for MCP); this layer assumes its input is already validated.
import fs from 'node:fs';
import { blobPath, sha256Of, writeBlob, readBlob, deleteBlob, decodeBody } from './blob.js';
import {
  createArtifactRecord, getArtifactRecord, listArtifactRecords,
  deleteArtifactRecord, findArtifactBySha,
} from './store.js';
import type { ArtifactRecord } from './store.js';
import {
  artifactEntityId, createArtifactEntity, deleteArtifactEntity,
  materializeOkfEdges, materializeExplicitLinks, getArtifactEdges,
} from './graph.js';
import type { ArtifactEdgeRow } from './graph.js';
import { parseOkfRelations } from './okf.js';
import { nanoid } from '../util.js';
import type { CreateArtifactInput, ListArtifactsInput } from './validators.js';

export function isMarkdown(contentType: string): boolean {
  return contentType.split(';')[0].trim().toLowerCase() === 'text/markdown';
}

// Text-ish content-types whose blob can be decoded back to a UTF-8 string for
// get_artifact's include_body. Anything else (images, pdf, zip, unknown) is an
// opaque binary blob and is never inlined as text.
const TEXTISH_APP = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
]);

export function isTextLike(contentType: string): boolean {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base.startsWith('text/') || TEXTISH_APP.has(base);
}

export interface CreatedArtifact {
  id: string;
  entity_id: string;
  content_type: string;
  title: string;
  domain: string;
  size: number;
  sha256: string;
  deduped: boolean;
  links_created: number;
  edges_materialized: number;
}

// Full create orchestration: decode body, dedup by (domain, sha256), else write
// the blob + sqlite row + graph node, then materialize OKF and explicit-link
// edges. Dedup is an early return (deduped:true) rather than an error, so
// idempotent re-ingestion of the same bytes into the same domain is a no-op that
// reports the existing record. On any failure after the first write, best-effort
// rollback unwinds the partial state and the error is re-thrown for the caller to
// surface (REST -> 500, MCP -> isError result).
export async function createArtifact(input: CreateArtifactInput): Promise<CreatedArtifact> {
  const { title, domain, content_type, body, encoding, filename, parse_okf, links } = input;

  const buf = decodeBody(body, encoding);
  const sha256 = sha256Of(buf);

  const existing = findArtifactBySha(domain, sha256);
  if (existing) {
    return {
      id: existing.id,
      entity_id: existing.entity_id,
      content_type: existing.content_type,
      title: existing.title,
      domain: existing.domain,
      size: existing.size,
      sha256: existing.sha256,
      deduped: true,
      links_created: 0,
      edges_materialized: 0,
    };
  }

  const id = nanoid(12);
  const entityId = artifactEntityId(domain, id);
  const filePath = blobPath(id, content_type, filename);

  let blobWritten = false;
  let entityCreated = false;
  let recordCreated = false;

  try {
    writeBlob(filePath, buf);
    blobWritten = true;

    createArtifactRecord({ id, entity_id: entityId, content_type, title, domain, filename: filename ?? null, size: buf.length, sha256 });
    recordCreated = true;

    await createArtifactEntity(entityId, domain, title, '');
    entityCreated = true;

    let edgesMaterialized = 0;
    if (parse_okf && isMarkdown(content_type)) {
      const edges = parseOkfRelations(buf.toString('utf8'), domain, entityId);
      const result = await materializeOkfEdges(entityId, id, edges);
      edgesMaterialized = result.created;
    }

    let linksCreated = 0;
    if (links.length > 0) {
      const result = await materializeExplicitLinks(entityId, id, links);
      linksCreated = result.created;
    }

    return {
      id, entity_id: entityId, content_type, title, domain,
      size: buf.length, sha256, deduped: false,
      links_created: linksCreated, edges_materialized: edgesMaterialized,
    };
  } catch (err) {
    // Best-effort rollback so a failed create doesn't leave an orphaned blob,
    // sqlite row, or graph node behind.
    if (entityCreated) { try { await deleteArtifactEntity(entityId); } catch { /* ignore */ } }
    if (recordCreated) { try { deleteArtifactRecord(id); } catch { /* ignore */ } }
    if (blobWritten) { try { deleteBlob(filePath); } catch { /* ignore */ } }
    throw err;
  }
}

export function listArtifacts(filters: ListArtifactsInput): ArtifactRecord[] {
  return listArtifactRecords(filters);
}

export interface ArtifactWithLinks extends ArtifactRecord {
  links: ArtifactEdgeRow[];
  incoming: ArtifactEdgeRow[];
  body?: string;
}

// The record plus its outgoing (`links`) and `incoming` edges. When
// includeBody is set and the content_type is text-ish, the on-disk blob is read
// back and decoded to a UTF-8 string so an agent can READ a stored skill/doc.
// Binary blobs are never inlined; a missing blob simply yields no body.
export async function getArtifact(id: string, opts?: { includeBody?: boolean }): Promise<ArtifactWithLinks | null> {
  const record = getArtifactRecord(id);
  if (!record) return null;
  const edges = await getArtifactEdges(record.entity_id);
  const result: ArtifactWithLinks = { ...record, links: edges.outgoing, incoming: edges.incoming };
  if (opts?.includeBody && isTextLike(record.content_type)) {
    const filePath = blobPath(record.id, record.content_type, record.filename ?? undefined);
    if (fs.existsSync(filePath)) {
      result.body = readBlob(filePath).toString('utf8');
    }
  }
  return result;
}
