import { useEffect, useState } from 'react';
import { api, isNotImplemented, type AuthProfile, type DataSet, type Environment } from '../lib/api';
import { Advanced, Button, Checkbox, Field, Select, Dialog } from './ui';

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

/** Responsive presets (Playwright viewport override for this run). */
const VIEWPORTS: Array<{ label: string; value: string; dims?: { width: number; height: number } }> = [
  { label: "Test default", value: "" },
  { label: "Desktop 1440×900", value: "1440x900", dims: { width: 1440, height: 900 } },
  { label: "Laptop 1280×720", value: "1280x720", dims: { width: 1280, height: 720 } },
  { label: "Tablet 768×1024", value: "768x1024", dims: { width: 768, height: 1024 } },
  { label: "Mobile 375×667", value: "375x667", dims: { width: 375, height: 667 } },
  { label: "Mobile 390×844", value: "390x844", dims: { width: 390, height: 844 } },
];

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
  const [healWithAlternatives, setHealWithAlternatives] = useState(false);
  const [observe, setObserve] = useState(false);
  const [debug, setDebug] = useState(false);
  const [viewport, setViewport] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = datasets.find((d) => d.id === datasetId);
  const viewportPreset = VIEWPORTS.find((v) => v.value === viewport);

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
          ...(healWithAlternatives ? { healWithAlternatives: true } : {}),
        });
        (onSuiteStarted ?? onStarted)(res.suiteRunId);
        return;
      }
      const run = await api.createRun(testId, {
        environmentId, browser, headed: headed || observe || debug,
        ...(viewportPreset?.dims ? { viewport: viewportPreset.dims } : {}),
        ...(datasetId ? { datasetId } : {}),
        ...(row !== undefined ? { rowIndex: row } : {}),
        ...(profileId ? { profileId } : {}),
        ...(healWithAlternatives ? { healWithAlternatives: true } : {}),
        // Chế độ quan sát kỹ (≈ playwright --ui ở mức xem lại): hiện trình
        // duyệt + chạy chậm từng thao tác + giữ trace/video kể cả khi pass.
        ...(observe ? { slowMoMs: 500, artifacts: { trace: 'on' as const, video: 'on' as const, screenshot: 'on' as const } } : {}),
        // Debug (≈ playwright --debug): headed + PWDEBUG=1, Inspector mở trên
        // host; run treo ở running tới khi đóng browser/Inspector hoặc Cancel.
        ...(debug ? { debug: true } : {}),
      });
      onStarted(run.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to start run');
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={suiteId ? 'Run suite' : 'Run test'}>
      <div data-testid="run-modal" className="space-y-4 px-4 py-4">
        {err && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Environment">
            <Select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </Field>
          <Field label="Browser">
            <Select value={browser} onChange={(e) => setBrowser(e.target.value)}>
              <option value="chromium">chromium</option>
              <option value="firefox">firefox</option>
              <option value="webkit">webkit</option>
            </Select>
          </Field>
        </div>
        <Field label="Viewport (responsive)" hint="Để trống = cỡ mặc định của test.">
          <Select value={viewport} onChange={(e) => setViewport(e.target.value)} aria-label="Viewport">
            {VIEWPORTS.map((v) => (
              <option key={v.value} value={v.value}>{v.label}</option>
            ))}
          </Select>
        </Field>
        {!profilesUnsupported && profiles !== null && profiles.length > 0 && (
          <Field label="Auth profile" hint="Fresh browser khi để trống.">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="Auth profile">
              <option value="">No profile (fresh browser)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.hasStorageState ? '' : ' (no saved login)'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {profiles === null && projectId ? (
          <p className="text-xs text-slate-500">Loading auth profiles…</p>
        ) : null}
        {datasets.length > 0 && !suiteId && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Dataset">
              <Select
                value={datasetId}
                onChange={(e) => { setDatasetId(e.target.value); setRowIndex(''); }}
                aria-label="Dataset"
              >
                <option value="">No dataset (single run)</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.rows.length} rows)</option>
                ))}
              </Select>
            </Field>
            {selected && (
              <Field label="Row">
                <Select value={rowIndex} onChange={(e) => setRowIndex(e.target.value)} aria-label="Row">
                  <option value="">All rows ({selected.rows.length})</option>
                  {selected.rows.map((_, i) => (
                    <option key={i} value={String(i)}>Row {i}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
        <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-600">Chế độ chạy</legend>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <Checkbox checked={headed} onChange={(e) => setHeaded(e.target.checked)} />
            <span>Hiện trình duyệt <span className="text-slate-500">(headed — xem trực tiếp)</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700" title="Hiện trình duyệt + chạy chậm 500ms mỗi thao tác + lưu trace/video kể cả khi pass (xem lại như playwright --ui)">
            <Checkbox checked={observe} onChange={(e) => setObserve(e.target.checked)} />
            <span>Quan sát kỹ <span className="text-slate-500">(headed + chậm + lưu trace/video)</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700" title="Mở Playwright Inspector trên máy chạy (≈ playwright --debug): step-through, breakpoint, thử locator trực tiếp; run treo tới khi đóng Inspector hoặc Cancel">
            <Checkbox checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            <span>Debug <span className="text-slate-500">(mở Inspector)</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700" title="Chỉ đề xuất alternatives khi locator hỏng (ghi evidence để review ở Healing) — KHÔNG tự áp dụng">
            <Checkbox checked={healWithAlternatives} onChange={(e) => setHealWithAlternatives(e.target.checked)} />
            <span>Thử alternatives khi locator hỏng <span className="text-slate-500">(đề xuất, không tự áp dụng)</span></span>
          </label>
        </fieldset>
        {suiteId ? (
          <Advanced title="Suite options">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Retries">
                <Select value={retries} onChange={(e) => setRetries(Number(e.target.value))} aria-label="Retries">
                  {[0, 1, 2, 3].map((n) => (
                    <option key={n} value={n}>{n === 0 ? 'No retries' : `${n}x`}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Parallel">
                <Select value={parallel} onChange={(e) => setParallel(Number(e.target.value))} aria-label="Parallel">
                  <option value={2}>2 (queue capacity)</option>
                  <option value={1}>1 (sequential)</option>
                </Select>
              </Field>
            </div>
          </Advanced>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => void start()} disabled={busy || !environmentId}>
            {busy ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
