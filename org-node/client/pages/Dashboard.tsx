import { useQuery } from '@tanstack/react-query';
import { getCurrentMetrics, getActivityLog, getQueueStats, listWorkers } from '../api.js';
import StatCard from '../components/StatCard.js';
import StatusBadge from '../components/StatusBadge.js';

export default function Dashboard() {
  const { data: metrics } = useQuery({ queryKey: ['metrics'], queryFn: getCurrentMetrics, refetchInterval: 10_000 });
  const { data: activity } = useQuery({ queryKey: ['activity'], queryFn: () => getActivityLog(15), refetchInterval: 10_000 });
  const { data: queueStats } = useQuery({ queryKey: ['queueStats'], queryFn: getQueueStats, refetchInterval: 10_000 });
  const { data: workers } = useQuery({ queryKey: ['workers'], queryFn: listWorkers, refetchInterval: 10_000 });

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Dashboard</h2>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Nodes" value={metrics?.graph.total_nodes ?? '...'} />
        <StatCard label="Total Edges" value={metrics?.graph.total_edges ?? '...'} />
        <StatCard label="Active Workers" value={metrics?.workers.active ?? 0} />
        <StatCard label="Embeddings" value={metrics?.embedded_count ?? 0} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Queue status */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold mb-3">Queue</h3>
          {queueStats && Object.keys(queueStats).length > 0 ? (
            <div className="space-y-2">
              {Object.entries(queueStats).map(([status, count]) => (
                <div key={status} className="flex justify-between items-center">
                  <StatusBadge status={status} />
                  <span className="font-mono text-sm">{count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm">Queue is empty</p>
          )}
        </div>

        {/* Workers */}
        <div className="bg-white rounded-lg shadow p-4">
          <h3 className="font-semibold mb-3">Workers</h3>
          {workers && workers.length > 0 ? (
            <div className="space-y-2">
              {workers.map(w => (
                <div key={w.id} className="flex justify-between items-center text-sm">
                  <span>{w.name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">{w.tasks_completed} done</span>
                    <StatusBadge status={w.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm">No workers connected</p>
          )}
        </div>
      </div>

      {/* Node types breakdown */}
      {metrics?.nodes_by_type && (
        <div className="bg-white rounded-lg shadow p-4 mt-6">
          <h3 className="font-semibold mb-3">Nodes by Type</h3>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
            {Object.entries(metrics.nodes_by_type)
              .sort(([,a], [,b]) => b - a)
              .map(([type, count]) => (
                <div key={type} className="text-center p-2 bg-gray-50 rounded">
                  <p className="text-lg font-bold">{count}</p>
                  <p className="text-xs text-gray-500 truncate">{type}</p>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Activity feed */}
      <div className="bg-white rounded-lg shadow p-4 mt-6">
        <h3 className="font-semibold mb-3">Recent Activity</h3>
        {activity && activity.length > 0 ? (
          <div className="space-y-1">
            {activity.map(a => (
              <div key={a.id} className="flex items-center gap-2 text-sm py-1 border-b border-gray-50 last:border-0">
                <span className="text-gray-400 text-xs w-32 shrink-0">
                  {new Date(a.timestamp).toLocaleString()}
                </span>
                <span className="font-mono text-xs px-1.5 py-0.5 bg-gray-100 rounded">{a.action}</span>
                {a.entity_type && <span className="text-gray-500">{a.entity_type}:{a.entity_id?.slice(0, 8)}</span>}
                {a.actor && <span className="text-gray-400">by {a.actor}</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-sm">No activity yet</p>
        )}
      </div>
    </div>
  );
}
