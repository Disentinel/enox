import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  listArtifacts, getArtifact, getArtifactRaw, getBasePath,
  type ArtifactRecord, type ArtifactEdge,
} from '../api.js';

// --- Tree building -----------------------------------------------------
// Groups artifacts by domain (top-level folder), then by filename path
// segments if the filename looks path-like (e.g. "guides/setup.md").
// Artifacts without a path-like filename become a single leaf named after
// their title.

interface FolderNode { kind: 'folder'; name: string; path: string; children: TreeNode[] }
interface ArtifactNode { kind: 'artifact'; name: string; path: string; artifact: ArtifactRecord }
type TreeNode = FolderNode | ArtifactNode;

interface MutableFolder { kind: 'folder'; name: string; path: string; children: Map<string, MutableFolder | ArtifactNode> }

function buildTree(artifacts: ArtifactRecord[]): TreeNode[] {
  const root = new Map<string, MutableFolder | ArtifactNode>();

  for (const artifact of artifacts) {
    const fileSegments = (artifact.filename ?? '').split('/').map(s => s.trim()).filter(Boolean);
    const segments = [artifact.domain, ...(fileSegments.length > 0 ? fileSegments : [artifact.title || artifact.id])];

    let cursor = root;
    let pathSoFar = '';
    segments.forEach((seg, i) => {
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      if (i === segments.length - 1) {
        cursor.set(`leaf:${artifact.id}`, { kind: 'artifact', name: seg, path: pathSoFar, artifact });
        return;
      }
      const key = `folder:${seg}`;
      let folder = cursor.get(key) as MutableFolder | undefined;
      if (!folder) {
        folder = { kind: 'folder', name: seg, path: pathSoFar, children: new Map() };
        cursor.set(key, folder);
      }
      cursor = folder.children;
    });
  }

  function toArray(map: Map<string, MutableFolder | ArtifactNode>): TreeNode[] {
    const items = Array.from(map.values());
    const folders = items
      .filter((n): n is MutableFolder => n.kind === 'folder')
      .map(f => ({ kind: 'folder' as const, name: f.name, path: f.path, children: toArray(f.children) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const leaves = items
      .filter((n): n is ArtifactNode => n.kind === 'artifact')
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...leaves];
  }

  return toArray(root);
}

function collectFolderPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      paths.push(node.path);
      paths.push(...collectFolderPaths(node.children));
    }
  }
  return paths;
}

// --- Formatting helpers --------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function baseContentType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

function isTextLikeContentType(contentType: string): boolean {
  const base = baseContentType(contentType);
  return base.startsWith('text/') || base === 'application/json' || base === 'application/xml' || base === 'application/x-yaml' || base === 'application/yaml';
}

function isMarkdownContentType(contentType: string): boolean {
  return baseContentType(contentType) === 'text/markdown';
}

// --- Tree view ------------------------------------------------------------

function TreeView({ nodes, selectedId, onSelect, expanded, onToggle }: {
  nodes: TreeNode[];
  selectedId: string;
  onSelect: (id: string) => void;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map(node => {
        if (node.kind === 'folder') {
          const isOpen = expanded.has(node.path);
          return (
            <li key={node.path}>
              <button
                onClick={() => onToggle(node.path)}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 text-sm rounded hover:bg-gray-100 text-gray-700"
              >
                <span className="text-gray-400 w-3 inline-block shrink-0">{isOpen ? '▾' : '▸'}</span>
                <span className="font-medium truncate">{node.name}</span>
              </button>
              {isOpen && (
                <div className="ml-3 border-l border-gray-100 pl-2">
                  <TreeView nodes={node.children} selectedId={selectedId} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />
                </div>
              )}
            </li>
          );
        }

        const isSelected = node.artifact.id === selectedId;
        return (
          <li key={node.artifact.id}>
            <button
              onClick={() => onSelect(node.artifact.id)}
              title={node.artifact.title}
              className={`w-full text-left px-1.5 py-1 text-sm rounded truncate ${
                isSelected ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {node.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// --- Linked entities row ---------------------------------------------------

function LinkChips({ links, incoming, onNavigate }: { links: ArtifactEdge[]; incoming: ArtifactEdge[]; onNavigate: (entityId: string) => void }) {
  if (links.length === 0 && incoming.length === 0) return null;
  return (
    <div className="mt-2 pt-2 border-t border-gray-100 flex flex-wrap gap-1.5">
      {links.map(l => (
        <button
          key={l.fact_id}
          onClick={() => l.target && onNavigate(l.target)}
          title={l.relation}
          className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
        >
          → {l.target_name ?? l.target?.split('/').pop()}
        </button>
      ))}
      {incoming.map(l => (
        <button
          key={l.fact_id}
          onClick={() => l.source && onNavigate(l.source)}
          title={l.relation}
          className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
        >
          ← {l.source_name ?? l.source?.split('/').pop()}
        </button>
      ))}
    </div>
  );
}

// --- Artifact viewer --------------------------------------------------------

function ArtifactViewer({ id, onNavigateEntity }: { id: string; onNavigateEntity: (entityId: string) => void }) {
  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['artifact', id],
    queryFn: () => getArtifact(id),
  });

  const textLike = detail ? isTextLikeContentType(detail.content_type) : false;

  const { data: raw, isLoading: rawLoading } = useQuery({
    queryKey: ['artifact-raw', id],
    queryFn: () => getArtifactRaw(id),
    enabled: !!detail && textLike,
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading...</p>;
  if (error) return <p className="text-red-500 text-sm">Error: {String(error)}</p>;
  if (!detail) return null;

  const rawUrl = `${getBasePath()}/api/artifacts/${encodeURIComponent(detail.id)}/raw`;
  const markdown = isMarkdownContentType(detail.content_type);

  return (
    <div>
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h3 className="text-lg font-bold">{detail.title}</h3>
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-mono">{detail.content_type}</span>
          <span className="text-xs text-gray-400 font-mono">{detail.domain}</span>
          <span className="text-xs text-gray-300 ml-auto shrink-0">{formatSize(detail.size)}</span>
        </div>

        <div className="flex gap-4 text-xs text-gray-400 flex-wrap items-center">
          {detail.filename && <span className="font-mono">{detail.filename}</span>}
          <span>Created: {new Date(detail.created_at).toLocaleDateString()}</span>
          <span>Updated: {new Date(detail.updated_at).toLocaleDateString()}</span>
          <a href={rawUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
            View raw
          </a>
        </div>

        <LinkChips links={detail.links} incoming={detail.incoming} onNavigate={onNavigateEntity} />
      </div>

      <div className="bg-white rounded-lg shadow p-4">
        {!textLike && (
          <p className="text-gray-400 text-sm">
            Binary content ({detail.content_type}) can&apos;t be previewed —{' '}
            <a href={rawUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">open raw</a>.
          </p>
        )}
        {textLike && rawLoading && <p className="text-gray-400 text-sm">Loading content...</p>}
        {textLike && raw !== undefined && markdown && (
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                table: ({ node, ...props }) => <div className="overflow-x-auto"><table {...props} /></div>,
                pre: ({ node, ...props }) => <pre {...props} className="overflow-x-auto" />,
              }}
            >
              {raw}
            </ReactMarkdown>
          </div>
        )}
        {textLike && raw !== undefined && !markdown && (
          <pre className="text-xs font-mono whitespace-pre overflow-x-auto bg-gray-50 rounded p-3">{raw}</pre>
        )}
      </div>
    </div>
  );
}

// --- Page --------------------------------------------------------------

export default function Wiki() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const selectedId = searchParams.get('id') ?? '';

  const { data: artifacts, isLoading, error } = useQuery({
    queryKey: ['artifacts-list'],
    queryFn: () => listArtifacts({ limit: 500 }),
  });

  const filtered = useMemo(() => {
    if (!artifacts) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.domain.toLowerCase().includes(q) ||
      (a.filename ?? '').toLowerCase().includes(q),
    );
  }, [artifacts, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  // Expand top-level (domain) folders by default once the tree is known.
  useEffect(() => {
    if (tree.length === 0) return;
    setExpanded(prev => (prev.size > 0 ? prev : new Set(tree.filter(n => n.kind === 'folder').map(n => n.path))));
  }, [tree]);

  const toggleFolder = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(collectFolderPaths(tree)));
  const collapseAll = () => setExpanded(new Set());

  const selectArtifact = (id: string) => setSearchParams({ id });
  const navigateToEntity = (entityId: string) => navigate(`/explore?id=${encodeURIComponent(entityId)}`);

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-xl font-bold mb-4 shrink-0">Wiki</h2>

      <div className="flex-1 flex gap-4 min-h-0">
        {/* Tree */}
        <aside className="w-72 shrink-0 bg-white rounded-lg shadow flex flex-col min-h-0">
          <div className="p-2 border-b border-gray-100 shrink-0">
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter..."
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-2 mt-1.5">
              <button onClick={expandAll} className="text-xs text-gray-400 hover:text-gray-600">Expand all</button>
              <button onClick={collapseAll} className="text-xs text-gray-400 hover:text-gray-600">Collapse all</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 min-h-0">
            {isLoading && <p className="text-gray-400 text-sm px-1.5">Loading...</p>}
            {error && <p className="text-red-500 text-sm px-1.5">Error: {String(error)}</p>}
            {artifacts && artifacts.length === 0 && <p className="text-gray-400 text-sm px-1.5">No artifacts yet</p>}
            {tree.length > 0 && (
              <TreeView nodes={tree} selectedId={selectedId} onSelect={selectArtifact} expanded={expanded} onToggle={toggleFolder} />
            )}
          </div>
        </aside>

        {/* Viewer */}
        <section className="flex-1 min-w-0 overflow-y-auto">
          {!selectedId && (
            <div className="bg-white rounded-lg shadow p-8 text-center text-gray-400 text-sm">
              Select a page from the tree to view it.
            </div>
          )}
          {selectedId && <ArtifactViewer id={selectedId} onNavigateEntity={navigateToEntity} />}
        </section>
      </div>
    </div>
  );
}
