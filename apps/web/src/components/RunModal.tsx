import { useEffect, useState } from 'react';
import { api, isNotImplemented, type AuthProfile, type DataSet, type Environment } from '../lib/api';

interface Props {
  testId: string;
  /** P1 suite mode: when set, POSTs /suites/:suiteId/runs instead. */
  suiteId?: string;
  envs: Environment[];
  envId: string | null;
  datasets?: DataSet[];
  /** P1 wave 2: project for loading auth profiles (graceful when API 404). */
  projectId?: string;
  /** Preloaded profiles (Builder may pass); otherwise fetched by projectId. */
  profiles?: AuthProfile[];
  onClose: () => void;
  onStarted: (runId: string) => void;
  onSuiteStarted?: (suiteRunId: string) => void;
}

/** POST /tests/:id/runs {environmentId, browser, headed, datasetId?, rowIndex?, profileId?} → runId. */
export function RunModal({ testId, suiteId, envs, envId, datasets = [], projectId, profiles: preloaded, onClose, onStarted, onSuiteStarted }: Props) {
  const [environmentId, setEnvironmentId] = useState(envId ?? envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? '');
  const [browser, setBrowser] = useState('chromium');
  const [headed, setHeaded] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [rowIndex, setRowIndex] = useState('');
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<AuthProfile[] | null>(preloaded ?? null);
  const [profilesUnsupported, setProfilesUnsupported] = useState(false);
  const [retries, setRetries] = useState(0);
  const [parallel, setParallel] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = datasets.find((d) => d.id === datasetId);

  useEffect(() => {
    if (preloaded) {
      setProfiles(preloaded);
      return;
    }
    if (!projectId) {
      setProfiles([]);
      return;
    }
    let alive = true;
    setProfiles(null);
    setProfilesUnsupported(false);
    api
      .listProfiles(projectId)
      .then((list) => {
        if (alive) setProfiles(list);
      })
      .catch((e) => {
        if (!alive) return;
        if (isNotImplemented(e)) {
          setProfilesUnsupported(true);
          setProfiles([]);
        } else {
          setProfiles([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, preloaded]);

  async function start() {
    if (!environmentId) { setErr('Pick an environment'); return; }
    if (rowIndex !== '' && datasetId === '') { setErr('Pick a dataset to run a single row'); return; }
    let row: number | undefined;
    if (rowIndex !== '') {
      row = Number(rowIndex);
      if (!Number.isInteger(row) || row < 0 || (selected && row >= selected.rows.length)) {
        setErr(`Row must be 0–${(selected?.rows.length ?? 1) - 1}`);
        return;
      }
    }
    setBusy(true); setErr(null);
    try {
      if (suiteId) {
        const res = await api.runSuite(suiteId, {
          environmentId, browser, headed,
          retries: Math.max(0, Math.min(5, retries)),
          parallel: parallel === 1 ? 1 : 2,
          ...(profileId ? { profileId } : {}),
        });
        (onSuiteStarted ?? onStarted)(res.suiteRunId);
        return;
      }
      const run = await api.post<{ id: string }>(`/tests/${testId}/runs`, {
        environmentId, browser, headed,
        ...(datasetId ? { datasetId } : {}),
        ...(row !== undefined ? { rowIndex: row } : {}),
        ...(profileId ? { profileId } : {}),
      });
      onStarted(run.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start run');
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} data-testid="run-modal">
        <h3>{suiteId ? 'Run suite' : 'Run test'}</h3>
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
        {!profilesUnsupported && profiles !== null && profiles.length > 0 && (
          <label style={row}>Auth profile
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="Auth profile">
              <option value="">No profile (fresh browser)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.hasStorageState ? '' : ' (no saved login)'}
                </option>
              ))}
            </select>
          </label>
        )}
        {profiles === null && projectId ? (
          <p style={{ fontSize: 12, color: '#64748b' }}>Loading auth profiles…</p>
        ) : null}
        {datasets.length > 0 && !suiteId && (
          <>
            <label style={row}>Dataset
              <select
                value={datasetId}
                onChange={(e) => { setDatasetId(e.target.value); setRowIndex(''); }}
                aria-label="Dataset"
              >
                <option value="">No dataset (single run)</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.rows.length} rows)</option>
                ))}
              </select>
            </label>
            {selected && (
              <label style={row}>Row
                <select value={rowIndex} onChange={(e) => setRowIndex(e.target.value)} aria-label="Row">
                  <option value="">All rows ({selected.rows.length})</option>
                  {selected.rows.map((_, i) => (
                    <option key={i} value={String(i)}>Row {i}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <label style={row}>
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} /> headed
        </label>
        {suiteId ? (
          <>
            <label style={row}>Retries
              <select value={retries} onChange={(e) => setRetries(Number(e.target.value))} aria-label="Retries">
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>{n === 0 ? 'No retries' : `${n}x`}</option>
                ))}
              </select>
            </label>
            <label style={row}>Parallel
              <select value={parallel} onChange={(e) => setParallel(Number(e.target.value))} aria-label="Parallel">
                <option value={2}>2 (queue capacity)</option>
                <option value={1}>1 (sequential)</option>
              </select>
            </label>
          </>
        ) : null}
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
