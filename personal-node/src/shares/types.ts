export interface ShareRecord {
  id: string;
  token: string;
  name: string;
  description: string | null;
  domains: string[];
  node_count: number;
  edge_count: number;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** When the snapshot files were last (re)exported — distinct from created_at/updated_at. */
  snapshot_at: string | null;
}

export interface ShareRawRow {
  id: string;
  token: string;
  name: string;
  description: string | null;
  domains: string;
  node_count: number;
  edge_count: number;
  revoked: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  snapshot_at: string | null;
}

export interface CreateShareInput {
  name: string;
  description?: string;
  domains: string[];
  ttl_days?: number;
}
