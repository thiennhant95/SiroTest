import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../components/ui";
import {
  ApiError,
  api,
  isNotImplemented,
  type Environment,
  type ScheduleRecord,
  type ScheduleRun,
  type SuiteRecord,
  type TestRecord,
} from "../lib/api";
import { CRON_HINT, previewNextRun, validateCron } from "../lib/cron";

/**
 * P1 wave 2 — Schedules (/projects/:id/schedules).
 * CRUD cron (suite/test + env + enabled + retries) + inline next-run preview
 * + per-schedule runs (trigger='schedule') + "Run now".
 */
export function SchedulesPage() {
  const { id: projectId } = useParams();
  const toast = useToast();
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);

  const [envs, setEnvs] = useState<Environment[]>([]);
  const [suites, setSuites] = useState<SuiteRecord[]>([]);
  const [tests, setTests] = useState<TestRecord[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleRecord | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fName, setFName] = useState("");
  const [fKind, setFKind] = useState<"suite" | "test">("suite");
  const [fSuiteId, setFSuiteId] = useState("");
  const [fTestId, setFTestId] = useState("");
  const [fEnvId, setFEnvId] = useState("");
  const [fCron, setFCron] = useState("0 9 * * 1-5");
  const [fEnabled, setFEnabled] = useState(true);
  const [fRetries, setFRetries] = useState(0);
  const [fNotify, setFNotify] = useState(false);

  const [runsOpenId, setRunsOpenId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduleRun[] | null>>({});
  const [runsError, setRunsError] = useState<Record<string, string>>({});

  const cronError = useMemo(() => validateCron(fCron), [fCron]);
  const nextRun = useMemo(() => (cronError ? null : previewNextRun(fCron)), [fCron, cronError]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError("");
    setUnsupported(false);
    try {
      const [list, environments, suiteList, testList] = await Promise.all([
        api.listSchedules(projectId),
        api.listEnvironments(projectId).catch(() => [] as Environment[]),
        api.listSuites(projectId).catch(() => [] as SuiteRecord[]),
        api.listTests(projectId).catch(() => [] as TestRecord[]),
      ]);
      setSchedules(list);
      setEnvs(environments);
      setSuites(suiteList);
      setTests(testList);
    } catch (e) {
      if (isNotImplemented(e)) {
        setUnsupported(true);
        setSchedules([]);
      } else {
        setError(e instanceof ApiError ? e.message : "Couldn't load schedules");
        setSchedules([]);
      }
    }
  }, [projectId]);

  useEffect(() => {
    setSchedules(null);
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setFName("");
    setFKind(suites.length > 0 ? "suite" : "test");
    setFSuiteId(suites[0]?.id ?? "");
    setFTestId(tests[0]?.id ?? "");
    setFEnvId(envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? "");
    setFCron("0 9 * * 1-5");
    setFEnabled(true);
    setFRetries(0);
    setFNotify(false);
    setFormError("");
    setDialogOpen(true);
  }

  function openEdit(s: ScheduleRecord) {
    setEditing(s);
    setFName(s.name ?? "");
    setFKind(s.suiteId ? "suite" : "test");
    setFSuiteId(s.suiteId ?? suites[0]?.id ?? "");
    setFTestId(s.testId ?? tests[0]?.id ?? "");
    setFEnvId(s.environmentId);
    setFCron(s.cron);
    setFEnabled(s.enabled);
    setFRetries(s.retries ?? 0);
    setFNotify(s.notifyOnFailure ?? false);
    setFormError("");
    setDialogOpen(true);
  }

  async function save() {
    if (!projectId) return;
    if (!fEnvId) {
      setFormError("Select an environment to run in.");
      return;
    }
    const v = validateCron(fCron);
    if (v) {
      setFormError(v);
      return;
    }
    if (fKind === "suite" && !fSuiteId) {
      setFormError("Select a suite to schedule.");
      return;
    }
    if (fKind === "test" && !fTestId) {
      setFormError("Select a test to schedule.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        ...(fName.trim() ? { name: fName.trim() } : {}),
        ...(fKind === "suite" ? { suiteId: fSuiteId } : { testId: fTestId }),
        environmentId: fEnvId,
        cron: fCron.trim(),
        enabled: fEnabled,
        retries: Math.max(0, Math.min(5, fRetries)),
        notifyOnFailure: fNotify,
      };
      if (editing) {
        const saved = await api.updateSchedule(editing.id, {
          name: fName.trim() || null,
          suiteId: fKind === "suite" ? fSuiteId : null,
          testId: fKind === "test" ? fTestId : null,
          environmentId: fEnvId,
          cron: fCron.trim(),
          enabled: fEnabled,
          retries: Math.max(0, Math.min(5, fRetries)),
          notifyOnFailure: fNotify,
        });
        setSchedules((prev) => prev?.map((x) => (x.id === saved.id ? saved : x)) ?? [saved]);
        toast.push("success", "Saved schedule.");
      } else {
        const created = await api.createSchedule(projectId, payload);
        setSchedules((prev) => (prev ? [created, ...prev] : [created]));
        toast.push("success", "Created schedule.");
      }
      setDialogOpen(false);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Save failed";
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove(s: ScheduleRecord) {
    const label = s.name || s.suiteName || s.testName || s.id;
    if (!window.confirm(`Delete schedule “${label}”? Past runs keep their history.`)) return;
    try {
      await api.deleteSchedule(s.id);
      setSchedules((prev) => prev?.filter((x) => x.id !== s.id) ?? []);
      toast.push("success", "Deleted schedule.");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Deletion failed");
    }
  }

  async function toggleEnabled(s: ScheduleRecord) {
    try {
      const saved = await api.updateSchedule(s.id, { enabled: !s.enabled });
      setSchedules((prev) => prev?.map((x) => (x.id === saved.id ? saved : x)) ?? []);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Couldn't change status");
    }
  }

  async function toggleRuns(s: ScheduleRecord) {
    if (runsOpenId === s.id) {
      setRunsOpenId(null);
      return;
    }
    setRunsOpenId(s.id);
    if (runs[s.id] !== undefined) return;
    setRuns((prev) => ({ ...prev, [s.id]: null }));
    try {
      const list = await api.listScheduleRuns(s.id);
      setRuns((prev) => ({ ...prev, [s.id]: list.filter((r) => !r.trigger || r.trigger === "schedule") }));
    } catch (e) {
      setRuns((prev) => ({ ...prev, [s.id]: [] }));
      setRunsError((prev) => ({ ...prev, [s.id]: e instanceof ApiError ? e.message : "Couldn't load runs" }));
    }
  }

  async function runNow(s: ScheduleRecord) {
    try {
      const res = await api.runScheduleNow(s.id);
      setRuns((prev) => {
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
      toast.push("success", `Triggered a manual run (${res.suiteRunId ?? res.runId ?? s.id}).`);
      if (runsOpenId === s.id) {
        setRuns((prev) => ({ ...prev, [s.id]: null }));
        try {
          const list = await api.listScheduleRuns(s.id);
          setRuns((prev) => ({ ...prev, [s.id]: list }));
        } catch {
          /* keep toast; runs refresh optional */
        }
      }
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Run now failed");
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <Link to={`/projects/${projectId}`} className="text-sm text-slate-500 hover:text-slate-800">
        ← Project
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Schedules</h1>
        <span className="flex gap-3 text-sm">
          <Link to={`/projects/${projectId}/profiles`} className="text-indigo-700 hover:underline">Profiles</Link>
          <Link to={`/projects/${projectId}/files`} className="text-indigo-700 hover:underline">Files</Link>
        </span>
      </div>
      <p className="text-sm text-slate-500">
        Run suites/tests on a schedule (cron). The server is the only trigger — the preview below is for checking only.
      </p>

      {unsupported ? (
        <EmptyState
          title="Backend schedules not supported (API 404)"
          hint="UI is ready per contract GET/POST /projects/:id/schedules. Waiting on P1 wave 2 backend — reload later."
        />
      ) : schedules === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div>
            <Button size="sm" onClick={openCreate}>+ New schedule</Button>
          </div>
          {schedules.length === 0 ? (
            <EmptyState title="No schedules yet" hint="Create your first schedule: pick a suite/test + environment + cron." />
          ) : (
            <ul className="space-y-2">
              {schedules.map((s) => {
                const target = s.suiteId ? `Suite ${s.suiteName ?? s.suiteId}` : `Test ${s.testName ?? s.testId}`;
                const open = runsOpenId === s.id;
                const list = runs[s.id];
                return (
                  <li key={s.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{s.name || target}</strong>
                      {s.enabled ? <Badge tone="green">enabled</Badge> : <Badge>disabled</Badge>}
                      <Badge>{s.cron}</Badge>
                      {s.notifyOnFailure ? <Badge tone="slate">notify on failure</Badge> : null}
                      {s.lastStatus === "failed" ? <Badge tone="red">last run failed</Badge> : null}
                      <span className="text-xs text-slate-500">
                        {target} · {s.environmentName ?? s.environmentId}
                        {s.retries ? ` · retries ${s.retries}` : ""}
                        {s.lastStatus ? ` · last ${s.lastStatus}` : ""}
                      </span>
                      <span className="ml-auto flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" className="text-indigo-700" onClick={() => void toggleRuns(s)}>
                          {open ? "Hide runs" : "Runs"}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-indigo-700" onClick={() => void runNow(s)}>Run now</Button>
                        <Button size="sm" variant="ghost" className="text-indigo-700" onClick={() => openEdit(s)}>Edit</Button>
                        <Button size="sm" variant="ghost" className="text-slate-600" onClick={() => void toggleEnabled(s)}>
                          {s.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => void remove(s)}>Delete</Button>
                      </span>
                    </div>
                    {open ? (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        {list === undefined || list === null ? (
                          <Skeleton className="h-10" />
                        ) : runsError[s.id] ? (
                          <p className="text-xs text-red-600">{runsError[s.id]}</p>
                        ) : list.length === 0 ? (
                            <p className="text-xs text-slate-500">No runs from this schedule yet (trigger='schedule').</p>
                        ) : (
                          <DataTable<ScheduleRun>
                            caption={`Runs of this schedule (trigger='schedule')`}
                            emptyText="No runs yet."
                            rows={list}
                            columns={[
                              {
                                key: "status",
                                header: "Status",
                                render: (r) => (
                                  <Badge tone={r.status === "failed" ? "red" : r.status === "passed" ? "green" : "slate"}>
                                    {r.status}
                                  </Badge>
                                ),
                              },
                              {
                                key: "id",
                                header: "Run",
                                render: (r) => (
                                  <Link to={`/runs/${r.id}`} className="font-mono text-indigo-700 hover:underline">
                                    <code>{r.id}</code>
                                  </Link>
                                ),
                              },
                              { key: "trigger", header: "Trigger", render: (r) => <span className="text-xs">{r.trigger ?? "schedule"}</span> },
                              { key: "startedAt", header: "Started", render: (r) => <span className="text-xs">{r.startedAt ?? "—"}</span> },
                            ]}
                          />
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={editing ? "Edit schedule" : "New schedule"} wide>
        <div className="space-y-3">
          <Field label="Name (optional)">
            <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="e.g. Nightly smoke" />
          </Field>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Run">
              <Select value={fKind} onChange={(e) => setFKind(e.target.value as "suite" | "test")}>
                <option value="suite">Suite</option>
                <option value="test">Test</option>
              </Select>
            </Field>
            <Field label="Environment">
              <Select value={fEnvId} onChange={(e) => setFEnvId(e.target.value)}>
                <option value="">— Select —</option>
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          {fKind === "suite" ? (
            <Field label="Suite">
              <Select value={fSuiteId} onChange={(e) => setFSuiteId(e.target.value)}>
                <option value="">— Select suite —</option>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Test">
              <Select value={fTestId} onChange={(e) => setFTestId(e.target.value)}>
                <option value="">— Select test —</option>
                {tests.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Cron" hint={CRON_HINT}>
            <Input value={fCron} onChange={(e) => setFCron(e.target.value)} placeholder="0 9 * * 1-5" className="font-mono" />
          </Field>
          {cronError ? (
            <p role="alert" className="text-xs text-red-700">{cronError}</p>
          ) : nextRun ? (
            <p className="text-xs text-slate-600">
              Next run (preview on your machine): <strong>{nextRun.toLocaleString()}</strong>
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <Checkbox checked={fEnabled} onChange={(e) => setFEnabled(e.target.checked)} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700" title="Post to the project's enabled Slack/Lark integration when a scheduled run fails">
              <Checkbox checked={fNotify} onChange={(e) => setFNotify(e.target.checked)} />
              Notify on failure
            </label>
            <Field label="Retries (0–5)">
              <Input type="number" min={0} max={5} value={fRetries} onChange={(e) => setFRetries(Number(e.target.value))} />
            </Field>
          </div>
          {formError ? (
            <p role="alert" className="text-xs text-red-700">{formError}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : editing ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
