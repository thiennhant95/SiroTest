import { useState } from 'react';
import { api, type Environment } from '../lib/api';
import { Badge, Button, Checkbox, Field, Input } from './ui';

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
    <section data-testid="envs-panel" className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Environments</h3>
      {err && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {err}
        </p>
      )}
      {envs.length === 0 ? (
        <p className="text-sm text-slate-500">No environments — create Staging first.</p>
      ) : (
        <ul className="space-y-2">
          {envs.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <strong className="text-sm">{e.name}</strong>
              {e.isDefault && <Badge tone="green">default</Badge>}
              {e.baseUrl && <span className="font-mono text-xs text-slate-500">{e.baseUrl}</span>}
              <span className="ml-auto flex gap-1.5">
                {!e.isDefault && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void setDefault(e.id)}>
                    Set default
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(e.id)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-[1fr_1.4fr_auto] items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
        <Field label="Name">
          <Input placeholder="Staging" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input placeholder="https://…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" />
        </Field>
        <label className="flex items-center gap-1.5 pb-2 text-sm text-slate-600">
          <Checkbox checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> default
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
        <Button type="button" onClick={() => void create()} disabled={!name.trim()}>Add environment</Button>
      </div>
    </section>
  );
}
