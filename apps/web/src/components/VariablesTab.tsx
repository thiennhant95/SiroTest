import { useMemo, useState } from 'react';
import { api, type Variable } from '../lib/api';
import { interpolatePreview, codePreviewFor, secretKeysOf, SECRET_MASK } from '../lib/variables';
import { DataTable } from './ui';

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
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState('{{BASE_URL}}/login — user {{USERNAME}}');

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

  return (
    <section data-testid="variables-tab">
      <h3>Variables — {envName || '(select environment)'}</h3>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        Env-scoped rows override shared rows. Secret values are write-only: they never display
        as plaintext after creation.
      </p>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      <DataTable<Variable>
        caption={`Biến cho ${envName || 'môi trường đã chọn'} (env-scoped ghi đè shared)`}
        emptyText="No variables in this scope yet."
        rows={scoped}
        columns={[
          { key: 'key', header: 'Key', render: (v) => <code>{v.key}</code> },
          {
            key: 'value', header: 'Value',
            render: (v) => (v.isSecret ? <span title="Secret is masked">{SECRET_MASK}</span> : <code>{v.value}</code>),
          },
          {
            key: 'environmentId', header: 'Scope',
            render: (v) => <span style={{ fontSize: 12, color: '#6b7280' }}>{v.environmentId ? 'environment' : 'shared'}</span>,
          },
          {
            key: 'isSecret', header: 'Type',
            render: (v) => (v.isSecret ? <span style={badge}>secret</span> : <span style={{ ...badge, background: '#eef2ff', color: '#3730a3' }}>plain</span>),
          },
          {
            key: 'id', header: '',
            render: (v) => <button type="button" onClick={() => void remove(v.id)}>Delete</button>,
          },
        ]}
      />

      <h4>Add variable to {envName || 'selected environment'}</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} style={{ width: 160 }} />
        <input
          placeholder={isSecret ? 'secret value (never shown again)' : 'value'}
          type={isSecret ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: 260 }}
        />
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={isSecret} onChange={(e) => setIsSecret(e.target.checked)} /> secret
        </label>
        <button type="button" onClick={() => void create()} disabled={busy || !key.trim()}>Add</button>
      </div>

      <h4>Interpolate preview (resolves against {envName || 'selected env'})</h4>
      <input value={sample} onChange={(e) => setSample(e.target.value)} style={{ width: '100%', maxWidth: 560 }} />
      <pre data-testid="interp-preview" style={preview}>{interpolatePreview(sample, variables, envId)}</pre>

      <h4>Code preview (redacted — secrets compile to runtime helpers)</h4>
      <pre data-testid="code-preview" style={preview}>{codePreviewFor(sample, secrets)}</pre>
    </section>
  );
}

const badge: React.CSSProperties = { background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '1px 8px', fontSize: 12 };
const preview: React.CSSProperties = { background: '#f8fafc', border: '1px solid #e5e7eb', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' };
