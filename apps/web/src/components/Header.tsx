import type { Environment } from '../lib/api';

interface Props {
  envs: Environment[];
  envId: string | null;
  onEnvChange: (id: string) => void;
  onManageEnvs: () => void;
  dirty: boolean;
  onRun: () => void;
  runBusy: boolean;
}

/** Builder header: environment select (Staging default) + Run button (disabled when dirty). */
export function Header({ envs, envId, onEnvChange, onManageEnvs, dirty, onRun, runBusy }: Props) {
  return (
    <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
      <strong>Playwright Studio</strong>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
        Environment
        <select value={envId ?? ''} onChange={(e) => onEnvChange(e.target.value)} data-testid="env-select">
          {envs.length === 0 && <option value="">(no environments)</option>}
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}{e.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onManageEnvs}>Manage</button>
      <span style={{ flex: 1 }} />
      {dirty && <span title="Unsaved changes" style={{ color: '#b45309' }}>● unsaved</span>}
      <button
        type="button"
        onClick={onRun}
        disabled={dirty || runBusy || !envId}
        title={dirty ? 'Save changes before running' : 'Run test'}
        data-testid="run-btn"
        style={{ padding: '6px 18px', fontWeight: 600 }}
      >
        {runBusy ? 'Starting…' : 'Run'}
      </button>
    </header>
  );
}
