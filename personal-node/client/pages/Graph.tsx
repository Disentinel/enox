import { useState, useEffect, useRef, useCallback } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import { getBasePath } from '../api.js';

// --- Types ---

interface ApiNode {
  id: string;
  type: string;
  domain: string | null;
  name: string;
  description: string | null;
  aliases: string[] | null;
  created_at: string;
  _node?: string;
}

interface ApiEdge {
  source: string;
  target: string;
  relation: string;
  confidence: number | null;
  fact_id?: string;
}

interface LayoutResponse {
  positions: Record<string, { x: number; y: number }>;
  duration_ms: number;
}

// --- Constants ---

const TYPE_COLORS: Record<string, string> = {
  concept: '#4299e1',
  decision: '#f56565',
  component: '#48bb78',
  pattern: '#ed8936',
  event: '#9f7aea',
  opinion: '#ed64a6',
  person: '#38b2ac',
};
const DEFAULT_COLOR = '#a0aec0';

function colorForType(type: string): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR;
}

// --- Component ---

export default function GraphPage() {
  // Data
  const [allNodes, setAllNodes] = useState<ApiNode[]>([]);
  const [allEdges, setAllEdges] = useState<ApiEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutStatus, setLayoutStatus] = useState<string | null>(null);

  // Filters
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [activeDomains, setActiveDomains] = useState<Set<string>>(new Set());
  const [activeRelations, setActiveRelations] = useState<Set<string>>(new Set());

  // Selection
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ApiNode | null>(null);
  const [connectedEdges, setConnectedEdges] = useState<{ outgoing: (ApiEdge & { otherName: string; otherId: string })[]; incoming: (ApiEdge & { otherName: string; otherId: string })[] }>({ outgoing: [], incoming: [] });

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ApiNode[]>([]);
  const [showSearchResults, setShowSearchResults] = useState(false);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // Drag state
  const dragStateRef = useRef<{ dragging: boolean; node: string | null }>({ dragging: false, node: null });

  // Derived filter options
  const typeOptions = [...new Set(allNodes.map(n => n.type))].sort();
  const domainOptions = [...new Set(allNodes.map(n => n.domain).filter(Boolean) as string[])].sort();
  const relationOptions = [...new Set(allEdges.map(e => e.relation).filter(Boolean))].sort();

  // --- Data fetching ---

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const token = localStorage.getItem('enox_token');
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const base = getBasePath();
        const [nodesRes, edgesRes] = await Promise.all([
          fetch(`${base}/api/nodes?limit=2000`, { headers }),
          fetch(`${base}/api/assertions?limit=3000`, { headers }),
        ]);
        if (!nodesRes.ok || !edgesRes.ok) throw new Error('Failed to fetch graph data');
        const nodes: ApiNode[] = await nodesRes.json();
        const edges: ApiEdge[] = await edgesRes.json();
        if (cancelled) return;

        setAllNodes(nodes);
        setAllEdges(edges);

        // Initialize filters to include everything
        setActiveTypes(new Set(nodes.map(n => n.type)));
        setActiveDomains(new Set(nodes.map(n => n.domain).filter(Boolean) as string[]));
        setActiveRelations(new Set(edges.map(e => e.relation).filter(Boolean)));
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, []);

  // --- Build / rebuild graph ---

  const buildGraph = useCallback(() => {
    if (!containerRef.current || allNodes.length === 0) return;

    // Kill previous renderer
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    const graph = new Graph();
    graphRef.current = graph;

    // Filter nodes
    const visibleNodeIds = new Set<string>();
    const filteredNodes = allNodes.filter(n =>
      activeTypes.has(n.type) &&
      (!n.domain || activeDomains.has(n.domain))
    );
    filteredNodes.forEach(n => visibleNodeIds.add(n.id));

    // Filter edges
    const filteredEdges = allEdges.filter(e =>
      visibleNodeIds.has(e.source) &&
      visibleNodeIds.has(e.target) &&
      activeRelations.has(e.relation)
    );

    // Compute degree map for sizing
    const degMap: Record<string, number> = {};
    filteredEdges.forEach(e => {
      degMap[e.source] = (degMap[e.source] || 0) + 1;
      degMap[e.target] = (degMap[e.target] || 0) + 1;
    });

    // Add nodes with circular layout as initial position
    filteredNodes.forEach((n, i) => {
      const angle = (i / filteredNodes.length) * Math.PI * 2;
      const deg = degMap[n.id] || 0;
      const radius = 50 + Math.max(0, 500 - deg * 3) + Math.random() * 100;
      graph.addNode(n.id, {
        label: n.name,
        x: Math.cos(angle) * radius + (Math.random() - 0.5) * 30,
        y: Math.sin(angle) * radius + (Math.random() - 0.5) * 30,
        size: Math.min(4 + deg * 0.3, 12),
        color: colorForType(n.type),
      });
    });

    // Add edges
    filteredEdges.forEach(e => {
      try {
        graph.addEdge(e.source, e.target, {
          size: Math.max(0.3, e.confidence ?? 1),
          color: '#292929',
        });
      } catch {
        // Skip duplicate edges
      }
    });

    // Create sigma renderer
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 6,
      labelColor: { color: '#999' },
      labelFont: 'system-ui',
      labelSize: 11,
      defaultEdgeType: 'arrow',
      defaultEdgeColor: '#292929',
      minCameraRatio: 0.01,
      maxCameraRatio: 30,
      stagePadding: 30,
    });
    sigmaRef.current = renderer;

    setLayoutStatus(`${filteredNodes.length} nodes, ${filteredEdges.length} edges`);

    // --- Node/edge reducers for selection highlighting ---
    renderer.setSetting('nodeReducer', (node, data) => {
      const res = { ...data };
      if (selectedNodeId) {
        if (node === selectedNodeId) {
          res.highlighted = true;
          res.zIndex = 10;
        } else if (graph.hasEdge(selectedNodeId, node) || graph.hasEdge(node, selectedNodeId)) {
          res.highlighted = true;
        } else {
          res.color = '#181818';
          res.label = '';
        }
      }
      return res;
    });

    renderer.setSetting('edgeReducer', (edge, data) => {
      const res = { ...data };
      if (selectedNodeId) {
        const s = graph.source(edge);
        const t = graph.target(edge);
        if (s !== selectedNodeId && t !== selectedNodeId) {
          res.hidden = true;
        } else {
          res.color = '#555';
          res.size = 1.5;
        }
      }
      return res;
    });

    // --- Drag support ---
    renderer.on('downNode', (e) => {
      dragStateRef.current = { dragging: true, node: e.node };
      graph.setNodeAttribute(e.node, 'highlighted', true);
      renderer.refresh();
    });

    renderer.getMouseCaptor().on('mousemovebody', (e) => {
      const { dragging, node } = dragStateRef.current;
      if (!dragging || !node) return;
      const pos = renderer.viewportToGraph(e);
      graph.setNodeAttribute(node, 'x', pos.x);
      graph.setNodeAttribute(node, 'y', pos.y);
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    });

    renderer.getMouseCaptor().on('mouseup', () => {
      const { node } = dragStateRef.current;
      if (node && graph.hasNode(node)) {
        graph.removeNodeAttribute(node, 'highlighted');
      }
      dragStateRef.current = { dragging: false, node: null };
    });

    // Cursor feedback
    renderer.on('enterNode', () => {
      if (containerRef.current) containerRef.current.style.cursor = 'grab';
    });
    renderer.on('leaveNode', () => {
      if (containerRef.current) containerRef.current.style.cursor = 'default';
    });

    // Click to select
    renderer.on('clickNode', ({ node }) => {
      if (!dragStateRef.current.dragging) {
        setSelectedNodeId(node);
      }
    });
    renderer.on('clickStage', () => {
      if (!dragStateRef.current.dragging) {
        setSelectedNodeId(null);
      }
    });

    // --- Request server-side ForceAtlas2 layout ---
    if (filteredNodes.length > 0) {
      const iterations = filteredNodes.length > 5000 ? 60 : filteredNodes.length > 1000 ? 100 : 150;
      setLayoutStatus(`${filteredNodes.length} nodes, ${filteredEdges.length} edges (computing layout...)`);

      const token = localStorage.getItem('enox_token');
      const layoutHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) layoutHeaders['Authorization'] = `Bearer ${token}`;
      fetch(`${getBasePath()}/api/layout`, {
        method: 'POST',
        headers: layoutHeaders,
        body: JSON.stringify({
          nodes: filteredNodes.map(n => ({ id: n.id, type: n.type })),
          edges: filteredEdges.map(e => ({ source: e.source, target: e.target })),
          iterations,
        }),
      })
        .then(r => r.json())
        .then((d: LayoutResponse) => {
          Object.entries(d.positions).forEach(([id, pos]) => {
            if (graph.hasNode(id)) {
              graph.setNodeAttribute(id, 'x', pos.x);
              graph.setNodeAttribute(id, 'y', pos.y);
            }
          });
          if (sigmaRef.current) sigmaRef.current.refresh();
          setLayoutStatus(`${filteredNodes.length} nodes, ${filteredEdges.length} edges (layout: ${d.duration_ms}ms)`);
        })
        .catch(() => {
          // Fallback: run a simple client-side force layout
          clientForceLayout(graph, Math.min(50, Math.max(15, 2000 / filteredNodes.length)));
          if (sigmaRef.current) sigmaRef.current.refresh();
          setLayoutStatus(`${filteredNodes.length} nodes, ${filteredEdges.length} edges (client layout)`);
        });
    }
  }, [allNodes, allEdges, activeTypes, activeDomains, activeRelations, selectedNodeId]);

  // Rebuild graph when data or filters change
  useEffect(() => {
    if (!loading && allNodes.length > 0) {
      buildGraph();
    }
    return () => {
      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
    };
  }, [buildGraph, loading]);

  // --- Selection detail ---

  useEffect(() => {
    if (!selectedNodeId) {
      setSelectedNode(null);
      setConnectedEdges({ outgoing: [], incoming: [] });
      return;
    }

    const node = allNodes.find(n => n.id === selectedNodeId) ?? null;
    setSelectedNode(node);

    const outgoing: (ApiEdge & { otherName: string; otherId: string })[] = [];
    const incoming: (ApiEdge & { otherName: string; otherId: string })[] = [];

    allEdges.forEach(e => {
      if (e.source === selectedNodeId) {
        const other = allNodes.find(n => n.id === e.target);
        outgoing.push({ ...e, otherName: other?.name ?? e.target.split('/').pop()!, otherId: e.target });
      } else if (e.target === selectedNodeId) {
        const other = allNodes.find(n => n.id === e.source);
        incoming.push({ ...e, otherName: other?.name ?? e.source.split('/').pop()!, otherId: e.source });
      }
    });

    setConnectedEdges({ outgoing, incoming });

    // Refresh sigma to apply highlight reducers
    if (sigmaRef.current) sigmaRef.current.refresh();
  }, [selectedNodeId, allNodes, allEdges]);

  // --- Search ---

  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setShowSearchResults(false);
      return;
    }
    const q = searchQuery.toLowerCase();
    const results = allNodes.filter(n => n.name.toLowerCase().includes(q)).slice(0, 20);
    setSearchResults(results);
    setShowSearchResults(results.length > 0);
  }, [searchQuery, allNodes]);

  // Close search dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchResults(false);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const focusNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setShowSearchResults(false);
    setSearchQuery('');

    const graph = graphRef.current;
    const renderer = sigmaRef.current;
    if (graph && renderer && graph.hasNode(nodeId)) {
      const pos = renderer.getNodeDisplayData(nodeId);
      if (pos) {
        renderer.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.3 }, { duration: 300 });
      }
    }
  }, []);

  // --- Filter toggle helpers ---

  function toggleType(type: string) {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  function toggleDomain(domain: string) {
    setActiveDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain); else next.add(domain);
      return next;
    });
  }

  function toggleRelation(rel: string) {
    setActiveRelations(prev => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel); else next.add(rel);
      return next;
    });
  }

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Loading graph data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-500">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full" style={{ background: '#0a0a0f' }}>
      {/* Sigma container — full size */}
      <div
        ref={containerRef}
        className="absolute inset-0"
      />

      {/* Filters panel — left */}
      <div
        className="absolute top-3 left-3 z-10 text-xs max-h-[calc(100vh-6rem)] overflow-y-auto"
        style={{
          background: 'rgba(20,20,30,0.92)',
          border: '1px solid #333',
          borderRadius: '8px',
          minWidth: '200px',
          color: '#e0e0e0',
          scrollbarWidth: 'thin',
          scrollbarColor: '#444 transparent',
        }}
      >
        <h2 className="text-sm font-bold px-4 pt-3 pb-2" style={{ color: '#8af' }}>
          Enox Graph
        </h2>

        {/* Node types filter */}
        <FilterSection title={`Node types (${typeOptions.length})`}>
          {typeOptions.map(type => (
            <label key={type} className="flex items-center gap-1.5 px-4 py-0.5 cursor-pointer hover:bg-white/5">
              <input
                type="checkbox"
                checked={activeTypes.has(type)}
                onChange={() => toggleType(type)}
                className="accent-blue-500"
              />
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: colorForType(type) }}
              />
              <span>{type}</span>
            </label>
          ))}
        </FilterSection>

        {/* Domains filter */}
        {domainOptions.length > 0 && (
          <FilterSection title={`Domains (${domainOptions.length})`}>
            {domainOptions.map(domain => (
              <label key={domain} className="flex items-center gap-1.5 px-4 py-0.5 cursor-pointer hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={activeDomains.has(domain)}
                  onChange={() => toggleDomain(domain)}
                  className="accent-blue-500"
                />
                <span>{domain}</span>
              </label>
            ))}
          </FilterSection>
        )}

        {/* Relations filter */}
        <FilterSection title={`Relations (${relationOptions.length})`}>
          {relationOptions.map(rel => (
            <label key={rel} className="flex items-center gap-1.5 px-4 py-0.5 cursor-pointer hover:bg-white/5">
              <input
                type="checkbox"
                checked={activeRelations.has(rel)}
                onChange={() => toggleRelation(rel)}
                className="accent-blue-500"
              />
              <span>{rel}</span>
            </label>
          ))}
        </FilterSection>

        {/* Stats */}
        {layoutStatus && (
          <div className="px-4 py-2 border-t border-gray-700/50 text-gray-500" style={{ fontSize: '11px' }}>
            {layoutStatus}
          </div>
        )}
      </div>

      {/* Search bar — top center */}
      <div ref={searchRef} className="absolute top-3 left-1/2 -translate-x-1/2 z-10" style={{ width: '280px' }}>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              setSearchQuery('');
              setShowSearchResults(false);
            }
          }}
          placeholder="Search nodes..."
          className="w-full px-3 py-2 text-sm outline-none"
          style={{
            background: 'rgba(20,20,30,0.92)',
            border: '1px solid #444',
            borderRadius: showSearchResults ? '6px 6px 0 0' : '6px',
            color: '#e0e0e0',
          }}
          autoComplete="off"
        />
        {showSearchResults && (
          <div
            className="overflow-y-auto"
            style={{
              background: 'rgba(20,20,30,0.95)',
              border: '1px solid #444',
              borderTop: 'none',
              borderRadius: '0 0 6px 6px',
              maxHeight: '320px',
            }}
          >
            {searchResults.map(n => (
              <div
                key={n.id}
                onClick={() => focusNode(n.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer text-xs"
                style={{ borderBottom: '1px solid #1a1a22', color: '#e0e0e0' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1a1a28')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: colorForType(n.type) }}
                />
                <span className="flex-1 truncate">{n.name}</span>
                {n.domain && <span className="text-gray-600" style={{ fontSize: '10px' }}>{n.domain}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Node detail panel — right */}
      <div
        className="absolute top-0 right-0 bottom-0 z-10 flex flex-col"
        style={{
          width: '340px',
          background: '#111118',
          borderLeft: '1px solid #333',
        }}
      >
        {selectedNode ? (
          <>
            {/* Header */}
            <div className="px-4 pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid #282830' }}>
              <h3 className="text-sm font-semibold text-gray-100 leading-snug">{selectedNode.name}</h3>
              <div className="flex items-center gap-1.5 mt-1.5">
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs font-semibold"
                  style={{ background: colorForType(selectedNode.type), color: '#000' }}
                >
                  {selectedNode.type}
                </span>
                {selectedNode.domain && (
                  <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: '#282830', color: '#888' }}>
                    {selectedNode.domain}
                  </span>
                )}
              </div>
            </div>

            {/* ID */}
            <div
              className="px-4 py-1.5 cursor-pointer shrink-0"
              style={{ color: '#555', fontSize: '10px', fontFamily: 'monospace', borderBottom: '1px solid #282830', wordBreak: 'break-all' }}
              onClick={() => {
                navigator.clipboard.writeText(selectedNode.id);
              }}
              title="Click to copy ID"
            >
              {selectedNode.id}
            </div>

            {/* Description */}
            <div
              className="px-4 py-3 text-xs leading-relaxed shrink-0 overflow-y-auto"
              style={{ color: '#aaa', maxHeight: '100px', borderBottom: '1px solid #282830' }}
            >
              {selectedNode.description || 'No description'}
            </div>

            {/* Edges title */}
            <div
              className="px-4 py-2 shrink-0 uppercase"
              style={{ color: '#888', fontSize: '11px', borderBottom: '1px solid #1a1a22' }}
            >
              Connections ({connectedEdges.outgoing.length + connectedEdges.incoming.length})
            </div>

            {/* Edges list */}
            <div
              className="flex-1 min-h-0 overflow-y-auto"
              style={{ scrollbarWidth: 'thin', scrollbarColor: '#444 transparent' }}
            >
              {connectedEdges.outgoing.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-gray-600 uppercase" style={{ fontSize: '10px' }}>
                    Outgoing ({connectedEdges.outgoing.length})
                  </div>
                  {connectedEdges.outgoing.map((e, i) => (
                    <div
                      key={`out-${i}`}
                      onClick={() => focusNode(e.otherId)}
                      className="px-4 py-2 cursor-pointer text-xs"
                      style={{ borderBottom: '1px solid #1a1a22' }}
                      onMouseEnter={ev => (ev.currentTarget.style.background = '#1a1a28')}
                      onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ color: '#fa8', fontWeight: 600, fontSize: '11px' }}>{e.relation}</span>
                      <span style={{ color: '#8af', marginLeft: '6px' }}>{e.otherName}</span>
                      {e.confidence != null && (
                        <span className="float-right" style={{ color: '#555', fontSize: '11px' }}>{e.confidence}</span>
                      )}
                    </div>
                  ))}
                </>
              )}
              {connectedEdges.incoming.length > 0 && (
                <>
                  <div className="px-4 py-1.5 text-gray-600 uppercase" style={{ fontSize: '10px' }}>
                    Incoming ({connectedEdges.incoming.length})
                  </div>
                  {connectedEdges.incoming.map((e, i) => (
                    <div
                      key={`in-${i}`}
                      onClick={() => focusNode(e.otherId)}
                      className="px-4 py-2 cursor-pointer text-xs"
                      style={{ borderBottom: '1px solid #1a1a22' }}
                      onMouseEnter={ev => (ev.currentTarget.style.background = '#1a1a28')}
                      onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ color: '#fa8', fontWeight: 600, fontSize: '11px' }}>{e.relation}</span>
                      <span style={{ color: '#8af', marginLeft: '6px' }}>{e.otherName}</span>
                      {e.confidence != null && (
                        <span className="float-right" style={{ color: '#555', fontSize: '11px' }}>{e.confidence}</span>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-600 text-sm">Click a node to inspect</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Collapsible filter section ---

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div style={{ borderBottom: '1px solid #222' }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center justify-between px-4 py-1.5 cursor-pointer select-none uppercase"
        style={{ color: '#888', fontSize: '10px' }}
        onMouseEnter={e => (e.currentTarget.style.color = '#aaa')}
        onMouseLeave={e => (e.currentTarget.style.color = '#888')}
      >
        <span>{title}</span>
        <span
          style={{
            fontSize: '8px',
            transition: 'transform 0.2s',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}
        >
          &#9660;
        </span>
      </div>
      {!collapsed && <div className="pb-1">{children}</div>}
    </div>
  );
}

// --- Client-side fallback force layout ---

function clientForceLayout(graph: Graph, iterations: number) {
  const nodes = graph.nodes();
  const N = nodes.length;
  if (N === 0) return;

  const pos: Record<string, { x: number; y: number }> = {};
  nodes.forEach(n => {
    pos[n] = { x: graph.getNodeAttribute(n, 'x'), y: graph.getNodeAttribute(n, 'y') };
  });

  const sampleRate = N > 5000 ? 0.05 : N > 2000 ? 0.15 : N > 500 ? 0.4 : 1;

  for (let it = 0; it < iterations; it++) {
    const speed = 2 / (1 + it * 0.1);
    const repStr = N > 3000 ? 800 : N > 1000 ? 500 : 300;

    // Repulsion (sampled)
    for (let i = 0; i < N; i++) {
      if (Math.random() > sampleRate && N > 500) continue;
      const a = pos[nodes[i]];
      for (let j = i + 1; j < N; j++) {
        if (Math.random() > sampleRate && N > 500) continue;
        const b = pos[nodes[j]];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 1;
        const f = repStr * speed / d2;
        const d = Math.sqrt(d2);
        a.x += dx / d * f;
        a.y += dy / d * f;
        b.x -= dx / d * f;
        b.y -= dy / d * f;
      }
    }

    // Attraction along edges
    graph.forEachEdge((_edge, _attr, source, target) => {
      const pa = pos[source];
      const pb = pos[target];
      if (!pa || !pb) return;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
      const f = d * 0.005 * speed;
      pa.x += dx / d * f;
      pa.y += dy / d * f;
      pb.x -= dx / d * f;
      pb.y -= dy / d * f;
    });

    // Gravity
    nodes.forEach(n => {
      pos[n].x *= 0.998;
      pos[n].y *= 0.998;
    });
  }

  nodes.forEach(n => {
    graph.setNodeAttribute(n, 'x', pos[n].x);
    graph.setNodeAttribute(n, 'y', pos[n].y);
  });
}
