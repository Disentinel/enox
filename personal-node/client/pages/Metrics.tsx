import { useQuery } from '@tanstack/react-query';
import { getCurrentMetrics, getMetricHistory, getBasePath } from '../api.js';
import StatCard from '../components/StatCard.js';

export default function Metrics() {
  const { data: metrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: getCurrentMetrics,
    refetchInterval: 30_000,
  });

  const { data: history } = useQuery({
    queryKey: ['metricHistory'],
    queryFn: () => getMetricHistory({ limit: 50 }),
  });

  const extractionStats = useQuery({
    queryKey: ['extractionStats'],
    queryFn: () => fetch(`${getBasePath()}/api/metrics/extractions`).then(r => r.json()),
  });

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Metrics</h2>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Nodes" value={metrics?.graph.total_nodes ?? '...'} />
        <StatCard label="Total Edges" value={metrics?.graph.total_edges ?? '...'} />
        <StatCard label="Embedded" value={metrics?.embedded_count ?? '...'} />
        <StatCard
          label="Embedding Coverage"
          value={metrics ? `${Math.round((metrics.embedded_count / Math.max(1, metrics.graph.total_nodes)) * 100)}%` : '...'}
        />
      </div>

      {/* Nodes by type */}
      {metrics?.nodes_by_type && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="font-semibold mb-3">Nodes by Type</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2 text-left">Bar</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.nodes_by_type)
                  .sort(([,a], [,b]) => b - a)
                  .map(([type, count]) => {
                    const maxCount = Math.max(...Object.values(metrics.nodes_by_type));
                    return (
                      <tr key={type} className="border-b border-gray-50">
                        <td className="px-3 py-1.5 font-mono text-xs">{type}</td>
                        <td className="px-3 py-1.5 text-right">{count}</td>
                        <td className="px-3 py-1.5">
                          <div className="w-full bg-gray-100 rounded-full h-2">
                            <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${(count / maxCount) * 100}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edges by relation */}
      {metrics?.edges_by_relation && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="font-semibold mb-3">Edges by Relation</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Relation</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2 text-left">Bar</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.edges_by_relation)
                  .sort(([,a], [,b]) => b - a)
                  .map(([rel, count]) => {
                    const maxCount = Math.max(...Object.values(metrics.edges_by_relation));
                    return (
                      <tr key={rel} className="border-b border-gray-50">
                        <td className="px-3 py-1.5 font-mono text-xs">{rel}</td>
                        <td className="px-3 py-1.5 text-right">{count}</td>
                        <td className="px-3 py-1.5">
                          <div className="w-full bg-gray-100 rounded-full h-2">
                            <div className="bg-green-500 h-2 rounded-full" style={{ width: `${(count / maxCount) * 100}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Extraction stats */}
      {extractionStats.data?.total > 0 && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="font-semibold mb-3">Extraction Stats</h3>
          <p className="text-sm text-gray-600">Total extractions: {extractionStats.data.total}</p>
          {extractionStats.data.by_perspective?.length > 0 && (
            <table className="w-full text-sm mt-2">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Perspective</th>
                  <th className="px-3 py-2 text-right">Count</th>
                  <th className="px-3 py-2 text-right">Avg Nodes</th>
                  <th className="px-3 py-2 text-right">Avg Edges</th>
                </tr>
              </thead>
              <tbody>
                {extractionStats.data.by_perspective.map((row: any) => (
                  <tr key={row.perspective} className="border-b border-gray-50">
                    <td className="px-3 py-1.5">{row.perspective}</td>
                    <td className="px-3 py-1.5 text-right">{row.count}</td>
                    <td className="px-3 py-1.5 text-right">{Math.round(row.avg_nodes)}</td>
                    <td className="px-3 py-1.5 text-right">{Math.round(row.avg_edges)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Metric history */}
      {history && (history as any[]).length > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold mb-3">Snapshot History (last {(history as any[]).length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-right">Nodes</th>
                  <th className="px-3 py-2 text-right">Edges</th>
                  <th className="px-3 py-2 text-right">Embedded</th>
                  <th className="px-3 py-2 text-right">Queue Pending</th>
                </tr>
              </thead>
              <tbody>
                {(history as any[]).map((s: any) => (
                  <tr key={s.id} className="border-b border-gray-50">
                    <td className="px-3 py-1.5 text-xs">{new Date(s.timestamp).toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right">{s.total_nodes}</td>
                    <td className="px-3 py-1.5 text-right">{s.total_edges}</td>
                    <td className="px-3 py-1.5 text-right">{s.embedded_count ?? '-'}</td>
                    <td className="px-3 py-1.5 text-right">{s.queue_pending ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
