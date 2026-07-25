// Copies in-scope artifact blobs into a share's own directory at export/
// refresh time — the same "freeze a copy, never re-read the live store"
// pattern snapshot.ts uses for nodes.jsonl/edges.jsonl. This is what gives a
// share its isolation guarantee for artifact bodies: every share-facing route
// only ever reads from data/shares/<id>/artifacts/**, so there is no code
// path — buggy or not — that lets a guest reach an artifact outside the
// share's domains, even though the main artifacts store has no per-request
// scope check of its own. A per-request re-read from the live store was
// rejected for the same reason a per-share KuzuDB was rejected in
// snapshot.ts: it would need the scope check re-verified on every single
// request instead of once at export time, and would silently start serving
// artifacts added to an in-scope domain *after* the share was created,
// breaking the "share is a frozen slice until /refresh" invariant the graph
// snapshot already establishes.
import fs from 'node:fs';
import path from 'node:path';
import { listArtifactRecords, type ArtifactRecord } from '../artifacts/store.js';
import { blobPath as mainBlobPath, extFor } from '../artifacts/blob.js';
import { shareDir } from './snapshot.js';

export interface ShareArtifactMeta {
  id: string;
  entity_id: string;
  title: string;
  content_type: string;
  filename: string | null;
  size: number;
  sha256: string;
}

function artifactsDir(shareId: string): string {
  return path.join(shareDir(shareId), 'artifacts');
}

function indexPath(shareId: string): string {
  return path.join(shareDir(shareId), 'artifacts-index.json');
}

function shareBlobPath(shareId: string, artifactId: string, contentType: string, filename: string | null): string {
  return path.join(artifactsDir(shareId), `${artifactId}.${extFor(contentType, filename ?? undefined)}`);
}

// listArtifactRecords only filters by a single domain at a time; a share can
// carry several, so this loops and concatenates. Domains never overlap on a
// single artifact row (one `domain` column each), so no dedup is needed.
// Number.MAX_SAFE_INTEGER as the limit bypasses the 500-row cap the HTTP
// validator (ListArtifactsQuery) enforces on the owner-facing API — that cap
// exists to bound a single paginated HTTP response, not this in-process export.
function listInScope(domains: string[]): ArtifactRecord[] {
  const out: ArtifactRecord[] = [];
  for (const domain of domains) {
    out.push(...listArtifactRecords({ domain, limit: Number.MAX_SAFE_INTEGER, offset: 0 }));
  }
  return out;
}

export function exportShareArtifacts(shareId: string, domains: string[]): { artifact_count: number } {
  const dir = artifactsDir(shareId);
  // Wipe and recopy on every export (including /refresh) rather than diffing:
  // an artifact can be updated (new body/content-type -> new blob path/ext)
  // or fall out of scope (domain changed) between refreshes, and a stale
  // leftover file would otherwise keep serving old bytes forever.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const index: ShareArtifactMeta[] = [];
  for (const record of listInScope(domains)) {
    const srcPath = mainBlobPath(record.id, record.content_type, record.filename ?? undefined);
    if (!fs.existsSync(srcPath)) continue; // blob missing on disk — skip rather than fail the whole share export
    fs.copyFileSync(srcPath, shareBlobPath(shareId, record.id, record.content_type, record.filename));
    index.push({
      id: record.id, entity_id: record.entity_id, title: record.title,
      content_type: record.content_type, filename: record.filename, size: record.size, sha256: record.sha256,
    });
  }

  fs.writeFileSync(indexPath(shareId), JSON.stringify(index));
  return { artifact_count: index.length };
}

export function loadShareArtifactsIndex(shareId: string): ShareArtifactMeta[] {
  try {
    return JSON.parse(fs.readFileSync(indexPath(shareId), 'utf-8'));
  } catch {
    return [];
  }
}

export function getShareArtifactMeta(shareId: string, artifactId: string): ShareArtifactMeta | null {
  return loadShareArtifactsIndex(shareId).find(a => a.id === artifactId) ?? null;
}

export function shareArtifactBlobPath(shareId: string, meta: ShareArtifactMeta): string {
  return shareBlobPath(shareId, meta.id, meta.content_type, meta.filename);
}
