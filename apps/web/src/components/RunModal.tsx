import { useState } from 'react';
import { api, type Environment } from '../lib/api';

interface Props {
  testId: string;
  envs: Environment[];
  envId: string | null;
  onClose: () => void;
  onStarted: (runId: string) => void;
}

/** POST /tests/:id/runs {environmentId, browser, headed} → runId. */
export function RunModal({ testId, envs, envId, onClose, onStarted }: Props) {
  const [environmentId, setEnvironmentId] = useState(envId ?? envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? '');
  const [browser, setBrowser] = useState('chromium');
  const [headed, setHeaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    if (!environmentId) { setErr('Pick an environment'); return; }
    setBusy(true); setErr(null);
    try {
      const run = await api.post<{ id: string }>(`/tests/${testId}/runs`, { environmentId, browser, headed });
      onStarted(run.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start run');
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} data-testid="run-modal">
        <h3>Run test</h3>
        {err && <p style={{ color: 'crimson' }}>{err}</p>}
        <label style={row}>Environment
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label style={row}>Browser
          <select value={browser} onChange={(e) => setBrowser(e.target.value)}>
            <option value="chromium">chromium</option>
            <option value="firefox">firefox</option>
            <option value="webkit">webkit</option>
          </select>
        </label>
        <label style={row}>
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /> headed
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={() => void start()} disabled={busy || !environmentId}>
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
const dialog: React.CSSProperties = { background: '#fff', padding: 20, borderRadius: 8, minWidth: 320 };
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' };
