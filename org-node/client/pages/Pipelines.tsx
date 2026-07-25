import { useQuery } from '@tanstack/react-query';
import { getBasePath } from '../api.js';
import StatusBadge from '../components/StatusBadge.js';

// Note: Pipeline API endpoints exist on server but full pipeline management is Phase 3.
// For now, show current embedding worker status via metrics.

export default function Pipelines() {
  const { data: metrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      const res = await fetch(`${getBasePath()}/api/metrics/current`);
      return res.json();
    },
    refetchInterval: 5_000,
  });

  const pipelines = [
    { name: 'Embedding', description: 'Generate vector embeddings for new nodes', status: 'idle', embedded: metrics?.embedded_count ?? 0, total: metrics?.graph?.total_nodes ?? 0 },
    { name: 'Deduplication', description: 'Find and merge duplicate entities', status: 'idle' },
    { name: 'Review', description: 'LLM-based relation quality review', status: 'idle' },
  ];

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Pipelines</h2>

      <div className="space-y-4">
        {pipelines.map(p => (
          <div key={p.name} className="bg-white rounded-lg shadow p-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-semibold">{p.name}</h3>
                <p className="text-sm text-gray-500">{p.description}</p>
              </div>
              <StatusBadge status={p.status} />
            </div>

            {p.name === 'Embedding' && (
              <div className="mt-3">
                <div className="flex justify-between text-sm text-gray-600 mb-1">
                  <span>Progress</span>
                  <span>{p.embedded} / {p.total} nodes embedded</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${p.total > 0 ? Math.min(100, (p.embedded / p.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <button disabled className="px-3 py-1 bg-green-600 text-white rounded text-xs opacity-50 cursor-not-allowed">
                Start
              </button>
              <button disabled className="px-3 py-1 bg-yellow-600 text-white rounded text-xs opacity-50 cursor-not-allowed">
                Pause
              </button>
              <button disabled className="px-3 py-1 bg-red-600 text-white rounded text-xs opacity-50 cursor-not-allowed">
                Stop
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-sm text-gray-400 mt-4">
        Pipeline controls will be fully implemented with crawler worker integration.
        Embedding worker runs automatically in the background.
      </p>
    </div>
  );
}
