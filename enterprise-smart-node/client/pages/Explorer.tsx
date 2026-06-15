import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router';
import { searchNodes, getNeighbors, type NodeRow, type NeighborEdge } from '../api.js';

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
};

function RelBadge({ relation }: { relation: string }) {
  const cls = RELATION_COLORS[relation] || 'bg-gray-100 text-gray-600';
  return <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls}`}>{relation}</span>;
}

function TypeBadge({ type }: { type: string }) {
  return <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-mono">{type}</span>;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function EdgeRow({ edge, nodeId, navigate }: { edge: NeighborEdge; nodeId: string; navigate: (p: string) => void }) {
  const isOutgoing = edge.source === undefined || edge.source === nodeId;
  const otherId = isOutgoing ? edge.target! : edge.source!;
  const otherName = isOutgoing ? (edge.target_name ?? otherId.split('/').pop()) : (edge.source_name ?? otherId.split('/').pop());
  const otherType = isOutgoing ? edge.target_type : edge.source_type;

  return (
    <div className="py-1.5 border-b border-gray-50 last:border-0 text-sm">
      <div className="flex items-center gap-1.5 flex-wrap">
        {!isOutgoing && (
          <button
            onClick={() => navigate(`/explore?id=${encodeURIComponent(otherId)}`)}
            className="text-blue-600 hover:underline truncate max-w-[250px]"
            title={otherName}
          >
            {otherName}
          </button>
        )}
        <RelBadge relation={edge.relation} />
        {isOutgoing && (
          <button
            onClick={() => navigate(`/explore?id=${encodeURIComponent(otherId)}`)}
            className="text-blue-600 hover:underline truncate max-w-[250px]"
            title={otherName}
          >
            {otherName}
          </button>
        )}
        {otherType && <TypeBadge type={otherType} />}
        {edge.confidence < 1 && <span className="text-gray-400 text-xs">({edge.confidence})</span>}
        <span className="text-gray-400 text-xs ml-auto shrink-0">{timeAgo(edge.created_at)}</span>
      </div>
      {edge.context && (
        <p className="text-gray-500 text-xs mt-0.5 ml-0 line-clamp-2">{edge.context}</p>
      )}
    </div>
  );
}

function EntityDetail({ nodeId }: { nodeId: string }) {
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['neighbors', nodeId],
    queryFn: () => getNeighbors(nodeId),
    enabled: !!nodeId,
  });

  if (isLoading) return <p className="text-gray-400 text-sm mt-4">Loading...</p>;
  if (error) return <p className="text-red-500 text-sm mt-4">Error: {String(error)}</p>;
  if (!data?.node) return <p className="text-gray-400 text-sm mt-4">Node not found</p>;

  const { node, outgoing, incoming } = data;

  const ageDays = Math.round((Date.now() - new Date(node.updated_at).getTime()) / 86400000);
  const aliases = node.aliases?.filter(Boolean) ?? [];

  return (
    <div className="mt-4">
      {/* Node header */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-lg font-bold">{node.name}</h3>
          <TypeBadge type={node.type} />
          <span className="text-xs text-gray-400 font-mono">{node.domain}</span>
          <span className="text-xs text-gray-300 ml-auto">{outgoing.length + incoming.length} edges</span>
        </div>

        {node.description && (
          <p className="text-sm text-gray-600 mb-2 leading-relaxed">{node.description}</p>
        )}

        {aliases.length > 0 && (
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
            <span className="text-xs text-gray-400">Aliases:</span>
            {aliases.map((a, i) => (
              <span key={i} className="text-xs px-1.5 py-0.5 bg-yellow-50 text-yellow-700 rounded">{a}</span>
            ))}
          </div>
        )}

        <div className="flex gap-4 text-xs text-gray-400 flex-wrap">
          <span>Created: {new Date(node.created_at).toLocaleDateString()}</span>
          <span>Updated: {new Date(node.updated_at).toLocaleDateString()} ({ageDays}d ago)</span>
          <span className="font-mono text-gray-300 truncate max-w-[400px]" title={node.id}>{node.id}</span>
        </div>
      </div>

      {/* Outgoing edges */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <h4 className="font-semibold mb-2 text-sm">
          Outgoing <span className="text-gray-400 font-normal">({outgoing.length})</span>
        </h4>
        {outgoing.length > 0 ? (
          <div>{outgoing.map((e, i) => <EdgeRow key={i} edge={e} nodeId={nodeId} navigate={navigate} />)}</div>
        ) : (
          <p className="text-gray-400 text-sm">No outgoing edges</p>
        )}
      </div>

      {/* Incoming edges */}
      <div className="bg-white rounded-lg shadow p-4">
        <h4 className="font-semibold mb-2 text-sm">
          Incoming <span className="text-gray-400 font-normal">({incoming.length})</span>
        </h4>
        {incoming.length > 0 ? (
          <div>{incoming.map((e, i) => <EdgeRow key={i} edge={e} nodeId={nodeId} navigate={navigate} />)}</div>
        ) : (
          <p className="text-gray-400 text-sm">No incoming edges</p>
        )}
      </div>
    </div>
  );
}

export default function Explorer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  // selectedId is always derived from URL
  const selectedId = searchParams.get('id') ?? '';

  const selectNode = (id: string) => {
    setQuery('');
    setSearchParams({ id });
  };

  const { data: searchResults, isLoading } = useQuery({
    queryKey: ['search', query],
    queryFn: () => searchNodes(query),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Explorer</h2>

      {/* Search */}
      <form onSubmit={e => e.preventDefault()} className="mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search entities by name..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </form>

      {/* Search results dropdown */}
      {query.length >= 2 && (
        <div className="bg-white rounded-lg shadow mb-4 max-h-80 overflow-auto">
          {isLoading && <p className="p-4 text-gray-400 text-sm">Searching...</p>}
          {searchResults && searchResults.length === 0 && <p className="p-4 text-gray-400 text-sm">No results</p>}
          {searchResults?.slice(0, 30).map(node => (
            <button
              key={node.id}
              onClick={() => selectNode(node.id)}
              className="w-full text-left px-4 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0 flex items-center gap-2"
            >
              <span className="font-medium text-sm">{node.name}</span>
              <TypeBadge type={node.type} />
              <span className="text-xs text-gray-400 font-mono">{node.domain}</span>
              {node.description && <span className="text-xs text-gray-400 truncate max-w-[300px]">{node.description}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Entity detail */}
      {selectedId && <EntityDetail nodeId={selectedId} />}
    </div>
  );
}
