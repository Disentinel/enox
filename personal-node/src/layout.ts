import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  duration_ms: number;
}

export function computeLayout(
  nodes: Array<{ id: string; type: string }>,
  edges: Array<{ source: string; target: string }>,
  iterations = 100,
): LayoutResult {
  const start = Date.now();

  const graph = new (Graph.default ?? Graph)();

  const nodeSet = new Set(nodes.map(n => n.id));

  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const r = 500 + Math.random() * 200;
    graph.addNode(n.id, {
      x: Math.cos(angle) * r + (Math.random() - 0.5) * 100,
      y: Math.sin(angle) * r + (Math.random() - 0.5) * 100,
    });
  });

  edges.forEach(e => {
    if (nodeSet.has(e.source) && nodeSet.has(e.target) && e.source !== e.target) {
      try { graph.addEdge(e.source, e.target); } catch { /* dup */ }
    }
  });

  const fa2 = forceAtlas2.default ?? forceAtlas2;
  fa2.assign(graph, {
    iterations,
    settings: {
      gravity: 1,
      scalingRatio: 10,
      barnesHutOptimize: nodes.length > 500,
      barnesHutTheta: 0.5,
      slowDown: 5,
      outboundAttractionDistribution: true,
    },
  });

  const positions: Record<string, { x: number; y: number }> = {};
  graph.forEachNode((node: string, attrs: Record<string, number>) => {
    positions[node] = { x: attrs.x, y: attrs.y };
  });

  return { positions, duration_ms: Date.now() - start };
}
