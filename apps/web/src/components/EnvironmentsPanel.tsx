import { useState } from 'react';
import { api, type Environment } from '../lib/api';

interface Props {
  projectId: string;
  envs: Environment[];
  onChanged: () => void;
  onClose: () => void;
}

/** Environment CRUD (settings view / manage dialog). Switching env re-resolves variables. */
export function EnvironmentsPanel({ projectId, envs, onChanged, onClose }: Props) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setErr(null);
    try {
      await api.post(`/projects/${projectId}/environments`, {
        name: name.trim(), baseUrl: baseUrl.trim() || undefined, isDefault,
      });
      setName(''); setBaseUrl(''); setIsDefault(false);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Create failed'); }
  }

  async function setDefault(id: string) {
    await api.patch(`/environments/${id}`, { isDefault: true });
    onChanged();
  }

  async function remove(id: string) {
    if (!confirm('Delete this environment and its scoped variables?')) return;
    await api.del(`/environments/${id}`);
    onChanged();
  }

  return (
    <section data-testid="envs-panel" style={{ padding: 16 }}>
      <h3>Environments</h3>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      <ul>
        {envs.map((e) => (
          <li key={e.id} style={{ marginBottom: 6 }}>
            <strong>{e.name}</strong>
            {e.isDefault && <span style={{ marginLeft: 6, fontSize: 12, background: '#dcfce7', padding: '1px 8px', borderRadius: 10 }}>default</span>}
            {e.baseUrl && <span style={{ marginLeft: 8, color: '#6b7280', fontSize: 13 }}>{e.baseUrl}</span>}
            {!e.isDefault && <button type="button" style={{ marginLeft: 8 }} onClick={() => void setDefault(e.id)}>Set default</button>}
            <button type="button" style={{ marginLeft: 8 }} onClick={() => void remove(e.id)}>Delete</button>
          </li>
        ))}
        {envs.length === 0 && <li style={{ color: '#6b7280' }}>No environments — create Staging first.</li>}
      </ul>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <input placeholder="Name (e.g. Staging)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Base URL https://…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: 260 }} />
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> default
        </label>
        <button type="button" onClick={() => void create()}>Add</button>
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </section>
  );
}
