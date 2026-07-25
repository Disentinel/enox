// Auto-detect base path for multi-instance deployments (e.g. /abstract_dl_pub/)
function detectBasePath(): string {
  if (typeof window === 'undefined') return '';
  const path = window.location.pathname;
  // Known SPA routes to strip
  const spaRoutes = ['login', 'dashboard', 'explorer', 'graph', 'timeline', 'queue', 'perspectives', 'metrics', 'pipelines'];
  const segments = path.split('/').filter(Boolean);
  // If first segment isn't a known SPA route, it's the base prefix
  if (segments.length > 0 && !spaRoutes.includes(segments[0])) {
    return '/' + segments[0];
  }
  return '';
}

const BASE = detectBasePath();

export function getBasePath(): string {
  return BASE;
}

function getToken(): string | null {
  return localStorage.getItem('enox_token');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 || res.status === 403) {
    if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login')) {
      window.location.href = `${BASE}/login`;
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Health
export const getHealth = () => request<{ status: string; version: string }>('GET', '/health');

// Metrics
export const getCurrentMetrics = () => request<{
  graph: { total_nodes: number; total_edges: number };
  nodes_by_type: Record<string, number>;
  edges_by_relation: Record<string, number>;
  embedded_count: number;
  queue: Record<string, number>;
  workers: Record<string, number>;
}>('GET', '/api/metrics/current');

export const getMetricHistory = (params?: { from?: string; to?: string; limit?: number }) => {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.limit) qs.set('limit', String(params.limit));
  return request<unknown[]>('GET', `/api/metrics/history?${qs}`);
};

export const getActivityLog = (limit = 20, offset = 0) =>
  request<Array<{ id: number; timestamp: string; actor: string | null; action: string; entity_type: string; entity_id: string; detail: unknown }>>('GET', `/api/metrics/activity?limit=${limit}&offset=${offset}`);

// Queue
export interface Task {
  id: string;
  type: string;
  status: string;
  priority: number;
  source_url: string | null;
  perspective: string | null;
  config_json: unknown;
  assigned_to: string | null;
  result_json: unknown;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export const listTasks = (params?: { status?: string; type?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.type) qs.set('type', params.type);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  return request<Task[]>('GET', `/api/queue?${qs}`);
};

export const getQueueStats = () => request<Record<string, number>>('GET', '/api/queue/stats');
export const createTask = (data: { type: string; source_url?: string; perspective?: string; priority?: number }) =>
  request<Task>('POST', '/api/queue', data);
export const bulkCreateTasks = (tasks: Array<{ type: string; source_url?: string; perspective?: string }>) =>
  request<Task[]>('POST', '/api/queue/bulk', { tasks });
export const deleteTask = (id: string) => request<void>('DELETE', `/api/queue/${id}`);
export const pauseTask = (id: string) => request<Task>('POST', `/api/queue/${id}/pause`);
export const resumeTask = (id: string) => request<Task>('POST', `/api/queue/${id}/resume`);

// Perspectives
export interface Perspective {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  node_types: string[];
  relation_types: string[];
  chunk_size: number;
  llm_model: string;
  temperature: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const listPerspectives = () => request<Perspective[]>('GET', '/api/perspectives');
export const createPerspective = (data: Partial<Perspective> & { id: string; name: string; system_prompt: string; node_types: string[]; relation_types: string[] }) =>
  request<Perspective>('POST', '/api/perspectives', data);
export const updatePerspective = (id: string, data: Partial<Perspective>) =>
  request<Perspective>('PUT', `/api/perspectives/${id}`, data);
export const deletePerspective = (id: string) => request<void>('DELETE', `/api/perspectives/${id}`);

// Workers
export const listWorkers = () => request<Array<{
  id: string;
  name: string;
  capabilities: string[];
  status: string;
  last_heartbeat: string | null;
  tasks_completed: number;
  tasks_failed: number;
}>>('GET', '/api/workers');

// Graph — Timeline & Explorer
export interface AssertionRow {
  source_name: string;
  source_id: string;
  relation: string;
  target_name: string;
  target_id: string;
  confidence: number;
  context: string;
  created_at: string;
  updated_at: string;
}

export interface NodeRow {
  id: string;
  type: string;
  domain: string;
  name: string;
  description: string;
  aliases: string[];
  created_at: string;
  updated_at: string;
}

export interface NeighborEdge {
  fact_id: string;
  source?: string;
  target?: string;
  source_name?: string;
  target_name?: string;
  source_type?: string;
  target_type?: string;
  relation: string;
  confidence: number;
  context: string;
  created_at: string;
  updated_at: string;
}

export const listAssertions = (params?: { source?: string; target?: string; relation?: string; limit?: number; offset?: number }) => {
  const qs = new URLSearchParams();
  if (params?.source) qs.set('source', params.source);
  if (params?.target) qs.set('target', params.target);
  if (params?.relation) qs.set('relation', params.relation);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  return request<AssertionRow[]>('GET', `/api/assertions?${qs}`);
};

export const searchNodes = (q: string, type?: string) => {
  const qs = new URLSearchParams({ q });
  if (type) qs.set('type', type);
  return request<NodeRow[]>('GET', `/api/nodes?${qs}`);
};

export const getNode = (id: string) =>
  request<NodeRow>('GET', `/api/node?id=${encodeURIComponent(id)}`);

export const getNeighbors = (id: string) =>
  request<{ node: NodeRow; outgoing: NeighborEdge[]; incoming: NeighborEdge[] }>('GET', `/api/graph/neighbors?id=${encodeURIComponent(id)}`);

// Auth
export const login = async (token: string): Promise<boolean> => {
  localStorage.setItem('enox_token', token);
  try {
    await getHealth();
    return true;
  } catch {
    localStorage.removeItem('enox_token');
    return false;
  }
};

export const logout = () => {
  localStorage.removeItem('enox_token');
  window.location.href = `${BASE}/login`;
};

export const isAuthenticated = () => !!localStorage.getItem('enox_token');
