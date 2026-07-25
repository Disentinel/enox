import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listTasks, getQueueStats, createTask, deleteTask, pauseTask, resumeTask, bulkCreateTasks } from '../api.js';
import StatusBadge from '../components/StatusBadge.js';

const STATUSES = ['', 'pending', 'running', 'completed', 'failed', 'paused', 'dead_letter'];
const TASK_TYPES = ['extract', 'fetch_papers', 'canonicalize', 'dedup', 'embed', 'review', 'custom'];

export default function Queue() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkForm, setShowBulkForm] = useState(false);
  const [newTask, setNewTask] = useState({ type: 'extract', source_url: '', perspective: '', priority: 0 });
  const [bulkUrls, setBulkUrls] = useState('');

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', statusFilter],
    queryFn: () => listTasks({ status: statusFilter || undefined, limit: 100 }),
    refetchInterval: 5_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['queueStats'],
    queryFn: getQueueStats,
    refetchInterval: 5_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
    queryClient.invalidateQueries({ queryKey: ['queueStats'] });
  };

  const addMutation = useMutation({
    mutationFn: () => createTask(newTask),
    onSuccess: () => { invalidate(); setShowAddForm(false); setNewTask({ type: 'extract', source_url: '', perspective: '', priority: 0 }); },
  });

  const bulkMutation = useMutation({
    mutationFn: () => {
      const urls = bulkUrls.split('\n').map(u => u.trim()).filter(Boolean);
      return bulkCreateTasks(urls.map(url => ({ type: 'extract', source_url: url })));
    },
    onSuccess: () => { invalidate(); setShowBulkForm(false); setBulkUrls(''); },
  });

  const deleteMutation = useMutation({ mutationFn: deleteTask, onSuccess: invalidate });
  const pauseMutation = useMutation({ mutationFn: pauseTask, onSuccess: invalidate });
  const resumeMutation = useMutation({ mutationFn: resumeTask, onSuccess: invalidate });

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Task Queue</h2>
        <div className="flex gap-2">
          <button onClick={() => setShowAddForm(!showAddForm)} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
            Add Task
          </button>
          <button onClick={() => setShowBulkForm(!showBulkForm)} className="px-3 py-1.5 bg-gray-600 text-white rounded text-sm hover:bg-gray-700">
            Bulk Add
          </button>
        </div>
      </div>

      {/* Add task form */}
      {showAddForm && (
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h3 className="font-semibold mb-2">New Task</h3>
          <div className="grid grid-cols-2 gap-3">
            <select value={newTask.type} onChange={e => setNewTask({...newTask, type: e.target.value})} className="border rounded px-2 py-1.5 text-sm">
              {TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={newTask.source_url} onChange={e => setNewTask({...newTask, source_url: e.target.value})} placeholder="Source URL / arxiv ID" className="border rounded px-2 py-1.5 text-sm" />
            <input value={newTask.perspective} onChange={e => setNewTask({...newTask, perspective: e.target.value})} placeholder="Perspective (optional)" className="border rounded px-2 py-1.5 text-sm" />
            <input type="number" value={newTask.priority} onChange={e => setNewTask({...newTask, priority: parseInt(e.target.value) || 0})} placeholder="Priority" className="border rounded px-2 py-1.5 text-sm" />
          </div>
          <button onClick={() => addMutation.mutate()} disabled={addMutation.isPending} className="mt-3 px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {addMutation.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}

      {/* Bulk add form */}
      {showBulkForm && (
        <div className="bg-white rounded-lg shadow p-4 mb-4">
          <h3 className="font-semibold mb-2">Bulk Add (one URL per line)</h3>
          <textarea value={bulkUrls} onChange={e => setBulkUrls(e.target.value)} rows={5} className="w-full border rounded px-2 py-1.5 text-sm font-mono" placeholder="https://arxiv.org/abs/2301.00001&#10;https://arxiv.org/abs/2301.00002" />
          <button onClick={() => bulkMutation.mutate()} disabled={bulkMutation.isPending} className="mt-2 px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {bulkMutation.isPending ? 'Creating...' : `Add ${bulkUrls.split('\n').filter(u => u.trim()).length} tasks`}
          </button>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {STATUSES.map(s => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded text-sm ${statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          >
            {s || 'All'} {stats && s && stats[s] ? `(${stats[s]})` : stats && !s ? `(${Object.values(stats).reduce((a: number, b: number) => a + b, 0)})` : ''}
          </button>
        ))}
      </div>

      {/* Task table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-3 py-2 text-left">ID</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Worker</th>
              <th className="px-3 py-2 text-left">Created</th>
              <th className="px-3 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">Loading...</td></tr>
            ) : tasks?.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">No tasks</td></tr>
            ) : (
              tasks?.map(task => (
                <tr key={task.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{task.id.slice(0, 8)}</td>
                  <td className="px-3 py-2">{task.type}</td>
                  <td className="px-3 py-2 truncate max-w-48" title={task.source_url ?? ''}>{task.source_url?.slice(0, 40) ?? '-'}</td>
                  <td className="px-3 py-2"><StatusBadge status={task.status} /></td>
                  <td className="px-3 py-2 text-xs text-gray-500">{task.assigned_to?.slice(0, 10) ?? '-'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{new Date(task.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {task.status === 'pending' && (
                        <button onClick={() => pauseMutation.mutate(task.id)} className="text-xs text-yellow-600 hover:underline">Pause</button>
                      )}
                      {task.status === 'paused' && (
                        <button onClick={() => resumeMutation.mutate(task.id)} className="text-xs text-blue-600 hover:underline">Resume</button>
                      )}
                      {['pending', 'failed', 'dead_letter'].includes(task.status) && (
                        <button onClick={() => deleteMutation.mutate(task.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
