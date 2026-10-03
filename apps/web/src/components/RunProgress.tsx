import { useState } from 'react';
import { api } from '../lib/api';
import { redactText } from '../lib/variables';
import { useRunChannel } from '../hooks/useRunChannel';
import { Button } from './ui';

interface Props {
  runId: string;
  knownSecrets: string[]; // session-typed secret plaintexts, defense-in-depth redaction
  onBack: () => void;
}

const TERMINAL_LABEL: Record<string, string> = {
  queued: 'Queued', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled',
};

const STATUS_DOT: Record<string, string> = {
  queued: 'bg-slate-400',
  running: 'bg-indigo-500 animate-pulse',
  passed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-amber-500',
  skipped: 'bg-slate-300',
};

/** Live run progress: WS timeline + progress bar + cancel. DB is authoritative. */
export function RunProgress({ runId, knownSecrets, onBack }: Props) {
  const { run, events, connected, error, refetch } = useRunChannel(runId);
  const [cancelling, setCancelling] = useState(false);

  async function cancel() {
    setCancelling(true);
    try {
      await api.post(`/runs/${runId}/cancel`, {});
      await refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Cancel failed');
    } finally { setCancelling(false); }
  }

  const steps = [...(run?.steps ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const done = steps.filter((s) => ['passed', 'failed', 'skipped'].includes(s.status)).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : run && ['passed', 'failed', 'cancelled'].includes(run.status) ? 100 : 0;
  const live = run && (run.status === 'queued' || run.status === 'running');

  return (
    <section data-testid="run-progress" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>← Back to builder</Button>
        <span className="flex items-center gap-1.5 text-xs text-slate-500" title={connected ? "Live events connected" : "Reconnecting — DB state shown"}>
          <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
          WS: {connected ? 'connected' : 'reconnecting…'}
        </span>
      </div>
      <h3 className="text-sm font-semibold">Run <code className="rounded bg-slate-100 px-1 font-mono text-xs">{runId.slice(0, 12)}…</code></h3>
      <p className="text-sm">
        Status: <strong data-testid="run-status">{run ? TERMINAL_LABEL[run.status] ?? run.status : 'loading…'}</strong>
        {error && <span className="text-red-700"> · {redactText(error, knownSecrets)}</span>}
      </p>
      <div className="h-2.5 max-w-xl overflow-hidden rounded-full bg-slate-200">
        <div data-testid="run-progress-bar" style={{ width: `${pct}%` }} className={`h-full rounded-full transition-all ${run?.status === 'failed' ? 'bg-red-500' : 'bg-green-500'}`} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-500">{done}/{steps.length} steps · {pct}%</p>
        {live && (
          <Button type="button" size="sm" variant="outline" onClick={() => void cancel()} disabled={cancelling} data-testid="cancel-btn">
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </Button>
        )}
      </div>

      <h4 className="pt-1 text-sm font-semibold text-slate-700">Timeline (realtime)</h4>
      {steps.length === 0 && <p className="text-sm text-slate-500">Waiting for steps…</p>}
      <ol className="space-y-1">
        {steps.map((s) => (
          <li key={s.id} data-testid={`step-${s.stepId}`} className="flex items-start gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-[13px]">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status] ?? 'bg-slate-400'}`} />
            <code className="font-mono text-xs text-slate-600">{s.stepId}</code>
            <span className="font-medium capitalize">{s.status}</span>
            {s.errorMessage && <pre className="mt-1 w-full whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-2 text-xs">{redactText(s.errorMessage, knownSecrets)}</pre>}
          </li>
        ))}
      </ol>

      <h4 className="pt-1 text-sm font-semibold text-slate-700">Events <span className="font-normal text-slate-500">(informational)</span></h4>
      <ul className="space-y-0.5 font-mono text-xs text-slate-600">
        {events.slice(-20).map((e, i) => (
          <li key={i}><code className="rounded bg-slate-100 px-1">{e.event}</code>{e.payload.stepId ? ` ${e.payload.stepId}` : ''}</li>
        ))}
      </ul>
      {run?.errorSummary && <><h4 className="pt-1 text-sm font-semibold text-slate-700">Error</h4><pre className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-2 text-xs">{redactText(run.errorSummary, knownSecrets)}</pre></>}
    </section>
  );
}
