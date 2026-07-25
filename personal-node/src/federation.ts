import type { NodeConfig } from './config.js';

let config: NodeConfig;

export function initFederation(cfg: NodeConfig): void {
  config = cfg;
}

/** Check if a URI belongs to this node */
export function isLocal(uri: string): boolean {
  return uri.startsWith(config.uriPrefix + '/');
}

/** Resolve a URI — if local, return null (handle locally). If remote, fetch from peer. */
export async function resolveRemote(uri: string): Promise<Record<string, unknown> | null> {
  if (isLocal(uri)) return null;

  // Find matching peer
  for (const peer of config.peers) {
    if (uri.startsWith(peer.prefix)) {
      try {
        const encoded = encodeURIComponent(uri);
        const resp = await fetch(`${peer.url}/api/node?id=${encoded}`);
        if (resp.ok) {
          return await resp.json() as Record<string, unknown>;
        }
      } catch {
        // Peer unreachable
      }
      return null;
    }
  }

  return null; // No peer found for this URI
}

/** Resolve a batch of URIs — returns map of uri → node data (only remote ones) */
export async function resolveRemoteBatch(
  uris: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();
  const remoteUris = uris.filter(u => !isLocal(u));

  // Group by peer
  const byPeer = new Map<string, string[]>();
  for (const uri of remoteUris) {
    for (const peer of config.peers) {
      if (uri.startsWith(peer.prefix)) {
        const existing = byPeer.get(peer.url) || [];
        existing.push(uri);
        byPeer.set(peer.url, existing);
        break;
      }
    }
  }

  // Fetch from each peer in parallel
  await Promise.all(
    [...byPeer.entries()].map(async ([peerUrl, peerUris]) => {
      for (const uri of peerUris) {
        try {
          const encoded = encodeURIComponent(uri);
          const resp = await fetch(`${peerUrl}/api/node?id=${encoded}`);
          if (resp.ok) {
            results.set(uri, await resp.json() as Record<string, unknown>);
          }
        } catch {
          // Skip unreachable
        }
      }
    }),
  );

  return results;
}

/** Get config for external use */
export function getConfig(): NodeConfig {
  return config;
}
