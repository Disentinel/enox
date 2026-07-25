import path from 'node:path';

export interface NodeConfig {
  /** Display name for this node */
  name: string;
  /** URI prefix for entities created on this node, e.g. enox://acme.example/team-a */
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
}

// Load config from env or defaults
export function loadConfig(): NodeConfig {
  return {
    name: process.env.NODE_NAME ?? 'default',
    uriPrefix: process.env.NODE_URI_PREFIX ?? 'enox://local/default',
    port: parseInt(process.env.PORT ?? '3700', 10),
    dbPath: path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db'),
    mode: (process.env.NODE_MODE ?? 'private') as 'public' | 'private',
    peers: parsePeers(process.env.NODE_PEERS ?? ''),
    sqlitePath: path.resolve(process.env.SQLITE_PATH ?? './data/enox-meta.sqlite'),
    authToken: process.env.AUTH_TOKEN ?? null,
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
