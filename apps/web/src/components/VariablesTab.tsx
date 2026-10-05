import { useMemo, useState } from 'react';
import { ApiError, api, type Variable } from '../lib/api';
import { interpolatePreview, codePreviewFor, secretKeysOf, SECRET_MASK } from '../lib/variables';
import { Badge, Button, Checkbox, DataTable, Dialog, Field, Input, useToast } from './ui';

interface Props {
  projectId: string;
  envId: string | null;
  envName: string;
  variables: Variable[];
  onChanged: () => void;
  /** Report session-typed secret plaintext so App can redact it from logs (defense-in-depth). */
  onSecretTyped?: (plaintext: string) => void;
}

/**
 * Variables tab: table scoped to selected environment (+ shared rows),
 * CRUD, secret badge, password input, interpolate preview + redacted code preview.
 */
export function VariablesTab({ projectId, envId, envName, variables, onChanged, onSecretTyped }: Props) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState('{{BASE_URL}}/login — user {{USERNAME}}');
  // Inline edit (Dialog pattern from ProfilesPage): value-only, secrets stay write-only.
  const [editing, setEditing] = useState<Variable | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);

  const scoped = useMemo(
    () => variables.filter((v) => v.environmentId === envId || v.environmentId === null),
    [variables, envId],
  );
  const secrets = useMemo(() => secretKeysOf(variables), [variables]);

  async function create() {
    if (!key.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.post(`/projects/${projectId}/variables`, {
        environmentId: envId, key: key.trim(), value, isSecret,
      });
      // Secret plaintext must not linger: report for log-redaction, then clear the form.
      if (isSecret && value) onSecretTyped?.(value);
      setKey(''); setValue(''); setIsSecret(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this variable?')) return;
    await api.del(`/variables/${id}`);
    onChanged();
  }

  function openEdit(v: Variable) {
    setEditing(v);
    // Secrets are write-only: never prefill plaintext (server masks them as null).
    setEditValue(v.isSecret ? '' : (v.value ?? ''));
    setEditError('');
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    setEditError('');
    try {
      await api.patch(`/variables/${editing.id}`, { value: editValue });
      // Secret plaintext must not linger: report for log-redaction, then clear.
      if (editing.isSecret && editValue) onSecretTyped?.(editValue);
      setEditing(null);
      setEditValue('');
      toast.push('success', `Saved variable “${editing.key}”.`);
      onChanged();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      setEditError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="variables-tab" className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Variables — {envName || '(select environment)'}</h3>
      <p className="text-[13px] text-slate-500">
        Env-scoped rows override shared rows. Secret values are write-only: they never display
        as plaintext after creation.
      </p>
      {err && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {err}
        </p>
      )}
      <DataTable<Variable>
        caption={`Variables for ${envName || 'selected environment'} (env-scoped overrides shared)`}
        emptyText="No variables in this scope yet."
        rows={scoped}
        columns={[
          { key: 'key', header: 'Key', render: (v) => <code className="rounded bg-slate-100 px-1 text-xs">{v.key}</code> },
          {
            key: 'value', header: 'Value',
            render: (v) => (v.isSecret ? <span title="Secret is masked">{SECRET_MASK}</span> : <code className="text-xs">{v.value}</code>),
          },
          {
            key: 'environmentId', header: 'Scope',
            render: (v) => <span className="text-xs text-slate-500">{v.environmentId ? 'environment' : 'shared'}</span>,
          },
          {
            key: 'isSecret', header: 'Type',
            render: (v) => (v.isSecret ? <Badge tone="amber">secret</Badge> : <Badge tone="indigo">plain</Badge>),
          },
          {
            key: 'id', header: '',
            render: (v) => (
              <span className="flex gap-1.5">
                <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(v)}>Edit</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(v.id)}>Delete</Button>
              </span>
            ),
          },
        ]}
      />

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Edit variable “${editing.key}”` : 'Edit variable'}>
        <div className="space-y-3">
          <Field
            label={editing?.isSecret ? 'New secret value (empty = keep current)' : 'Value'}
            hint={editing?.isSecret ? 'Secret is write-only — the old value is never shown again.' : undefined}
          >
            <Input
              type={editing?.isSecret ? 'password' : 'text'}
              autoComplete="off"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder={editing?.isSecret ? 'new secret (never shown again)' : 'value'}
            />
          </Field>
          {editError ? (
            <p role="alert" className="text-xs text-red-700">{editError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Dialog>

      <h4 className="text-sm font-semibold text-slate-700">Add variable to {envName || 'selected environment'}</h4>
      <div className="grid grid-cols-[160px_1fr_auto_auto] items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
        <Field label="Key">
          <Input placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} className="font-mono" />
        </Field>
        <Field label="Value">
          <Input
            placeholder={isSecret ? 'secret value (never shown again)' : 'value'}
            type={isSecret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-1.5 pb-2 text-sm text-slate-600">
          <Checkbox checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} /> secret
        </label>
        <Button type="button" onClick={() => void create()} disabled={busy || !key.trim()}>Add</Button>
      </div>

      <h4 className="text-sm font-semibold text-slate-700">Interpolate preview <span className="font-normal text-slate-500">(resolves against {envName || 'selected env'})</span></h4>
      <Input value={sample} onChange={(e) => setSample(e.target.value)} className="font-mono" />
      <pre data-testid="interp-preview" className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs">{interpolatePreview(sample, variables, envId)}</pre>

      <h4 className="text-sm font-semibold text-slate-700">Code preview <span className="font-normal text-slate-500">(redacted — secrets compile to runtime helpers)</span></h4>
      <pre data-testid="code-preview" className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs">{codePreviewFor(sample, secrets)}</pre>
    </section>
  );
}
