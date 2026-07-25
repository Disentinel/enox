// Agent-native machine manifest for a share — the canonical, declarative
// contract an external agent parses to know what it can do here: what data
// this is a slice of, how to authenticate, which endpoints exist, and what
// its limits/capabilities/error codes are. This is the root of trust. The
// HTML receipt and the markdown "ready prompt" (markdown.ts) are conveniences
// layered on top for a human or an agent that just wants a quick narrative —
// neither is something an agent should treat as an authoritative contract,
// since a "ready prompt" is an imperative from an untrusted source (whoever
// is sharing the link), not data. Same manifest object is served from three
// places (see public.ts / api-router.ts): Accept: application/json on the
// share root, GET /share/:id/api, and GET /share/:id/manifest.json.
import { loadConfig } from '../config.js';
import { loadSnapshotId, computeSnapshotId, CANONICALIZATION } from './snapshot.js';
import { NODES_DEFAULT_LIMIT, TRAVERSE_MAX_DEPTH } from './api-router.js';
import { loadShareArtifactsIndex } from './artifacts.js';
import type { ShareRecord } from './types.js';
import type { ShareSummary } from './summary.js';
import type { SnapshotGraphStore } from './snapshot-store.js';

// Bumped when the SHAPE of this response changes (fields added/removed/
// renamed, semantics of an existing field changed) — never for changes to the
// underlying data (node/edge counts, domains, etc.), which is what
// snapshot.id already tracks. An agent pins/branches on this, not on
// snapshot.id, to know whether it still understands the response format.
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestEndpoint {
  rel: string;
  method: 'GET' | 'POST';
  href: string;
  note?: string;
}

export interface ShareManifest {
  protocol: 'enox-share';
  schema_version: number;
  snapshot: {
    // `id` is kept as a back-compat alias of `content_digest` (same bytes) so
    // existing consumers that read snapshot.id keep working unchanged.
    id: string;
    content_digest: string;
    digest_algorithm: string;
    // The described canonicalization scheme, single-sourced from snapshot.ts
    // (CANONICALIZATION) — lets a third party re-derive content_digest.
    canonicalization: typeof CANONICALIZATION;
    // Exactly what content_digest covers, and what it does not.
    digest_scope: {
      includes: string[];
      node_fields: readonly string[];
      edge_fields: readonly string[];
      excludes: string[];
      note: string;
    };
    taken_at: string | null;
  };
  slice: {
    uri: string;
    scope: {
      domains: string[];
      node_count: number;
      edge_count: number;
      nodes_by_type: Record<string, number>;
      edges_by_relation: Record<string, number>;
    };
  };
  auth: { type: 'token'; query_param: string; header: string; note: string };
  endpoints: ManifestEndpoint[];
  capabilities: string[];
  limits: { default_page_size: number; max_traverse_depth: number };
  expiry: { expires_at: string | null; revocable: boolean };
  errors: Record<string, string>;
}

export async function buildShareManifest(
  shareId: string,
  share: ShareRecord,
  summary: ShareSummary,
  store: SnapshotGraphStore,
): Promise<ShareManifest> {
  const config = loadConfig();

  // Prefer the id persisted at export/refresh time (the normal case). Falls
  // back to computing it from the already-loaded store only for a snapshot
  // exported before snapshot-id.txt existed — never re-reads nodes/edges
  // from disk just for this, since the store is already in memory.
  const snapshotId = loadSnapshotId(shareId) ?? computeSnapshotId(await store.findNodes({}), store.allEdges());

  const endpoints: ManifestEndpoint[] = [
    { rel: 'summary', method: 'GET', href: './api/summary' },
    { rel: 'nodes', method: 'GET', href: './api/nodes{?q,type,limit}' },
    { rel: 'node', method: 'GET', href: './api/nodes/{id}' },
    { rel: 'explore', method: 'GET', href: './api/explore{?name}' },
    { rel: 'traverse', method: 'GET', href: './api/traverse{?from,depth}' },
  ];
  if (store.supportsSemanticSearch) {
    endpoints.push({ rel: 'search', method: 'GET', href: './api/search{?q}' });
  }

  const artifactsIndex = loadShareArtifactsIndex(shareId);
  if (artifactsIndex.length > 0) {
    endpoints.push(
      { rel: 'artifacts', method: 'GET', href: './api/artifacts' },
      { rel: 'artifact-raw', method: 'GET', href: './api/artifacts/{artifactId}/raw' },
    );
  }

  endpoints.push(
    { rel: 'mcp', method: 'POST', href: './mcp' },
    { rel: 'manifest', method: 'GET', href: './api' },
    { rel: 'human', method: 'GET', href: '.', note: 'Accept: text/html for the receipt' },
  );

  const capabilities = ['read', 'traverse', 'mcp'];
  if (store.supportsSemanticSearch) capabilities.push('semantic_search');
  if (artifactsIndex.length > 0) capabilities.push('artifacts');

  return {
    protocol: 'enox-share',
    schema_version: MANIFEST_SCHEMA_VERSION,
    snapshot: {
      id: snapshotId,
      content_digest: snapshotId,
      digest_algorithm: CANONICALIZATION.digest_algorithm,
      canonicalization: CANONICALIZATION,
      digest_scope: {
        includes: ['nodes', 'edges'],
        node_fields: CANONICALIZATION.node_fields,
        edge_fields: CANONICALIZATION.edge_fields,
        excludes: ['manifest'],
        note: 'Digest covers the snapshot content (nodes + edges) only; this manifest is the envelope and is NOT part of the hashed input.',
      },
      taken_at: share.snapshot_at,
    },
    slice: {
      uri: `enox://${sliceHost(config.uriPrefix)}/share/${shareId}`,
      scope: {
        domains: summary.domains,
        node_count: summary.node_count,
        edge_count: summary.edge_count,
        nodes_by_type: summary.nodes_by_type,
        edges_by_relation: summary.edges_by_relation,
      },
    },
    auth: {
      type: 'token',
      query_param: 'token',
      header: 'Authorization: Bearer <token>',
      note: 'token already embedded in the share URL you were given',
    },
    endpoints,
    capabilities,
    limits: {
      default_page_size: NODES_DEFAULT_LIMIT,
      max_traverse_depth: TRAVERSE_MAX_DEPTH,
    },
    expiry: { expires_at: share.expires_at, revocable: true },
    errors: {
      '401': 'missing or invalid share token',
      '404': 'share or resource not found',
      '410': 'share revoked or expired',
    },
  };
}

// Derives the host for slice.uri from this node's own enox:// uriPrefix
// (e.g. "enox://example.org/graph/main" -> "example.org"), rather than
// hardcoding a host — a self-hosted node can configure a different
// NODE_URI_PREFIX, and shares should resolve under that same namespace.
function sliceHost(uriPrefix: string): string {
  try {
    return new URL(uriPrefix).host;
  } catch {
    return 'example.org';
  }
}
