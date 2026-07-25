import path from 'node:path';

export interface NodeConfig {
  /** Display name for this node */
  name: string;
  /** URI prefix: enox://example.org/graph/main or enox://example.org/source/tg/some_channel */
  uriPrefix: string;
  /** HTTP port */
  port: number;
  /** Path to KuzuDB */
  dbPath: string;
  /** Public (no auth, read-only API) or private (auth required for writes) */
  mode: 'public' | 'private';
  /** Known federation peers: other nodes we can resolve URIs from */
  peers: Array<{ prefix: string; url: string }>;
  /** Path to SQLite database file */
  sqlitePath: string;
  /** Auth token (null = no auth / dev mode) */
  authToken: string | null;
  /** Public base URL this node is reachable at — used to build share links */
  publicBaseUrl: string;
  /**
   * Optional display name for the graph owner, shown on public share receipts
   * ("<name> shared a slice of their knowledge graph with you"). Never a
   * gendered possessive — deliberately not configurable, falls back to
   * "their" rather than guessing. Null/unset renders "Someone shared...".
   */
  publicOwnerName: string | null;
  /**
   * Display-only fallback label for Assertion.asserted_by when materializing
   * OLD rows that predate the provenance fix (2026-07-24) and never had an
   * identity recorded. NOT used to satisfy new writes — asserted_by is
   * required on creation (CreateAssertionSchema has no default; REST 400s if
   * it's missing). This is purely "what do we print for a legacy row with no
   * recorded identity" (see backup.ts materialize()).
   */
  defaultAssertedBy: string;
  /**
   * Identity attributed to assertions created by MCP write tools
   * (add_assertion/batch_assertions/remember) and the /api/ingest LLM
   * extraction pipeline when the calling agent doesn't pass its own
   * asserted_by. Deliberately distinct from a human identity: these paths
   * are invoked by agents, not typed in by the user directly, so facts they
   * assert are attributed to the agent, not to a person. Convention: humans use
   * a plain identity ("alice"); agents use "agent:<name>" — see
   * ENOX_AGENT_IDENTITY.
   */
  agentIdentity: string;
}

// Load config from env or defaults
export function loadConfig(): NodeConfig {
  return {
    name: process.env.NODE_NAME ?? 'node',
    uriPrefix: process.env.NODE_URI_PREFIX ?? 'enox://example.org/graph/main',
    port: parseInt(process.env.PORT ?? '3700', 10),
    dbPath: path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db'),
    mode: (process.env.NODE_MODE ?? 'private') as 'public' | 'private',
    peers: parsePeers(process.env.NODE_PEERS ?? ''),
    sqlitePath: path.resolve(process.env.SQLITE_PATH ?? './data/enox-meta.sqlite'),
    authToken: process.env.AUTH_TOKEN ?? null,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'https://api.example.org').replace(/\/+$/, ''),
    publicOwnerName: process.env.PUBLIC_OWNER_NAME?.trim() || null,
    defaultAssertedBy: process.env.ENOX_DEFAULT_ASSERTED_BY?.trim() || 'unknown',
    agentIdentity: process.env.ENOX_AGENT_IDENTITY?.trim() || 'agent:unknown',
  };
}

// Parse peers from env: "prefix1=url1,prefix2=url2"
function parsePeers(raw: string): Array<{ prefix: string; url: string }> {
  if (!raw.trim()) return [];
  return raw.split(',').map(p => {
    const [prefix, url] = p.split('=');
    return { prefix: prefix.trim(), url: url.trim() };
  }).filter(p => p.prefix && p.url);
}
