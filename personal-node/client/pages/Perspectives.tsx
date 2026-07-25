import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listPerspectives, createPerspective, updatePerspective, deletePerspective, type Perspective } from '../api.js';

export default function Perspectives() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Perspective | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    id: '', name: '', description: '', system_prompt: '',
    node_types: '', relation_types: '',
    chunk_size: 4000, llm_model: 'sonnet', temperature: 0,
  });

  const { data: perspectives } = useQuery({
    queryKey: ['perspectives'],
    queryFn: listPerspectives,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['perspectives'] });

  const createMut = useMutation({
    mutationFn: () => createPerspective({
      ...form,
      node_types: form.node_types.split(',').map(s => s.trim()).filter(Boolean),
      relation_types: form.relation_types.split(',').map(s => s.trim()).filter(Boolean),
    }),
    onSuccess: () => { invalidate(); setCreating(false); resetForm(); },
  });

  const updateMut = useMutation({
    mutationFn: () => updatePerspective(editing!.id, {
      ...form,
      node_types: form.node_types.split(',').map(s => s.trim()).filter(Boolean),
      relation_types: form.relation_types.split(',').map(s => s.trim()).filter(Boolean),
    }),
    onSuccess: () => { invalidate(); setEditing(null); resetForm(); },
  });

  const deleteMut = useMutation({ mutationFn: deletePerspective, onSuccess: invalidate });

  const resetForm = () => setForm({ id: '', name: '', description: '', system_prompt: '', node_types: '', relation_types: '', chunk_size: 4000, llm_model: 'sonnet', temperature: 0 });

  const startEdit = (p: Perspective) => {
    setEditing(p);
    setCreating(false);
    setForm({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      system_prompt: p.system_prompt,
      node_types: p.node_types.join(', '),
      relation_types: p.relation_types.join(', '),
      chunk_size: p.chunk_size,
      llm_model: p.llm_model,
      temperature: p.temperature,
    });
  };

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    resetForm();
  };

  const isFormOpen = editing || creating;

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Perspectives</h2>
        <button onClick={startCreate} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
          New Perspective
        </button>
      </div>

      {/* Form */}
      {isFormOpen && (
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <h3 className="font-semibold mb-3">{editing ? `Edit: ${editing.name}` : 'New Perspective'}</h3>
          <div className="grid grid-cols-2 gap-3">
            {creating && (
              <input value={form.id} onChange={e => setForm({...form, id: e.target.value})} placeholder="ID (slug, e.g. arxiv-ml)" className="border rounded px-2 py-1.5 text-sm" />
            )}
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Display Name" className="border rounded px-2 py-1.5 text-sm" />
            <input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Description" className="border rounded px-2 py-1.5 text-sm col-span-2" />
            <input value={form.node_types} onChange={e => setForm({...form, node_types: e.target.value})} placeholder="Node types (comma-separated)" className="border rounded px-2 py-1.5 text-sm" />
            <input value={form.relation_types} onChange={e => setForm({...form, relation_types: e.target.value})} placeholder="Relation types (comma-separated)" className="border rounded px-2 py-1.5 text-sm" />
            <div className="flex gap-3">
              <input type="number" value={form.chunk_size} onChange={e => setForm({...form, chunk_size: parseInt(e.target.value) || 4000})} className="border rounded px-2 py-1.5 text-sm w-24" />
              <select value={form.llm_model} onChange={e => setForm({...form, llm_model: e.target.value})} className="border rounded px-2 py-1.5 text-sm">
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
              <input type="number" step="0.1" min="0" max="1" value={form.temperature} onChange={e => setForm({...form, temperature: parseFloat(e.target.value) || 0})} className="border rounded px-2 py-1.5 text-sm w-20" />
            </div>
          </div>
          <textarea value={form.system_prompt} onChange={e => setForm({...form, system_prompt: e.target.value})} rows={8} placeholder="System prompt template..." className="w-full border rounded px-2 py-1.5 text-sm font-mono mt-3" />
          <div className="flex gap-2 mt-3">
            <button onClick={() => editing ? updateMut.mutate() : createMut.mutate()} className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
              {editing ? 'Update' : 'Create'}
            </button>
            <button onClick={() => { setEditing(null); setCreating(false); resetForm(); }} className="px-4 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {perspectives?.map(p => (
          <div key={p.id} className={`bg-white rounded-lg shadow p-4 ${!p.enabled ? 'opacity-50' : ''}`}>
            <div className="flex justify-between items-start">
              <div>
                <h4 className="font-semibold">{p.name}</h4>
                <p className="text-xs text-gray-500 font-mono">{p.id}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded ${p.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {p.enabled ? 'active' : 'disabled'}
              </span>
            </div>
            {p.description && <p className="text-sm text-gray-600 mt-2">{p.description}</p>}
            <div className="mt-3 flex flex-wrap gap-1">
              {p.node_types.map(t => (
                <span key={t} className="text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{t}</span>
              ))}
            </div>
            <div className="mt-2 text-xs text-gray-500">
              {p.llm_model} | chunk: {p.chunk_size} | temp: {p.temperature}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => startEdit(p)} className="text-xs text-blue-600 hover:underline">Edit</button>
              <button onClick={() => deleteMut.mutate(p.id)} className="text-xs text-red-600 hover:underline">
                {p.enabled ? 'Disable' : 'Delete'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
