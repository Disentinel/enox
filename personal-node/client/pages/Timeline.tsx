import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActivityLog, listAssertions, type AssertionRow } from '../api.js';
import { useNavigate } from 'react-router';

const PAGE_SIZE = 30;

const RELATION_COLORS: Record<string, string> = {
  supersedes: 'bg-orange-100 text-orange-700',
  contradicts: 'bg-red-100 text-red-700',
  depends_on: 'bg-blue-100 text-blue-700',
  enables: 'bg-green-100 text-green-700',
  about: 'bg-gray-100 text-gray-600',
  part_of: 'bg-purple-100 text-purple-700',
  references: 'bg-cyan-100 text-cyan-700',
  outperforms: 'bg-emerald-100 text-emerald-700',
  fails_on: 'bg-red-100 text-red-600',
  extends: 'bg-indigo-100 text-indigo-700',
  builds_on: 'bg-indigo-100 text-indigo-600',
  introduces: 'bg-teal-100 text-teal-700',
  uses: 'bg-sky-100 text-sky-700',
  is_based_on: 'bg-violet-100 text-violet-700',
  subclass_of: 'bg-fuchsia-100 text-fuchsia-700',
  instance_of: 'bg-pink-100 text-pink-700',
};

function RelBadge({ relation }: { relation: string }) {
  const cls = RELATION_COLORS[relation] || 'bg-gray-100 text-gray-600';
  return <span className={`text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap ${cls}`}>{relation}</span>;
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Timeline() {
  const [tab, setTab] = useState<'assertions' | 'activity'>('assertions');
  const [pages, setPages] = useState(1);
  const navigate = useNavigate();

  const { data: assertions, isLoading: loadingAssertions } = useQuery({
    queryKey: ['timeline-assertions', pages],
    queryFn: () => listAssertions({ limit: pages * PAGE_SIZE }),
    refetchInterval: 15_000,
  });

  const { data: activity, isLoading: loadingActivity } = useQuery({
    queryKey: ['timeline-activity'],
    queryFn: () => getActivityLog(50),
    refetchInterval: 15_000,
  });

  const loadMore = useCallback(() => setPages(p => p + 1), []);

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Timeline</h2>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        <button
          onClick={() => setTab('assertions')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'assertions' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Assertions
        </button>
        <button
          onClick={() => setTab('activity')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === 'activity' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          Activity Log
        </button>
      </div>

      {tab === 'assertions' && (
        <div>
          {loadingAssertions && !assertions && <p className="text-gray-400 text-sm">Loading...</p>}
          <div className="space-y-0">
            {assertions?.map((a: AssertionRow, i: number) => (
              <div key={i} className="flex items-start gap-2 py-2 border-b border-gray-100 last:border-0 text-sm hover:bg-gray-50">
                <span className="text-gray-400 text-xs w-16 shrink-0 pt-0.5">{timeAgo(a.updated_at)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      onClick={() => navigate(`/explore?id=${encodeURIComponent(a.source_id)}`)}
                      className="text-blue-600 hover:underline font-medium truncate max-w-[220px]"
                      title={a.source_name}
                    >
                      {a.source_name}
                    </button>
                    <RelBadge relation={a.relation} />
                    <button
                      onClick={() => navigate(`/explore?id=${encodeURIComponent(a.target_id)}`)}
                      className="text-blue-600 hover:underline font-medium truncate max-w-[220px]"
                      title={a.target_name}
                    >
                      {a.target_name}
                    </button>
                    {a.confidence < 1 && (
                      <span className="text-gray-400 text-xs">({a.confidence})</span>
                    )}
                  </div>
                  {a.context && (
                    <p className="text-gray-500 text-xs mt-0.5 line-clamp-2">{a.context}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {assertions && assertions.length >= pages * PAGE_SIZE && (
            <button
              onClick={loadMore}
              className="w-full py-3 text-sm text-blue-500 hover:text-blue-700 hover:bg-gray-50 rounded mt-2"
            >
              Load more...
            </button>
          )}
          {assertions && assertions.length === 0 && (
            <p className="text-gray-400 text-sm">No assertions yet</p>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="space-y-0">
          {loadingActivity && <p className="text-gray-400 text-sm">Loading...</p>}
          {activity?.map(a => (
            <div key={a.id} className="flex items-center gap-2 text-sm py-1.5 border-b border-gray-100 last:border-0 hover:bg-gray-50">
              <span className="text-gray-400 text-xs w-16 shrink-0">
                {timeAgo(a.timestamp)}
              </span>
              <span className="font-mono text-xs px-1.5 py-0.5 bg-gray-100 rounded">{a.action}</span>
              {a.entity_type && (
                <span className="text-gray-500 truncate max-w-[300px]" title={a.entity_id ?? ''}>
                  {a.entity_type}:{(a.entity_id ?? '').split('/').pop()}
                </span>
              )}
              {a.actor && <span className="text-gray-400 text-xs ml-auto">by {a.actor}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
