import { useState } from 'react';
import { api } from '../lib/api';
import { redactText } from '../lib/variables';
import { useRunChannel } from '../hooks/useRunChannel';

interface Props {
  runId: string;
  knownSecrets: string[]; // session-typed secret plaintexts, defense-in-depth redaction
  onBack: () => void;
}

const TERMINAL_LABEL: Record<string, string> = {
  queued: 'Queued', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled',
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
    <section data-testid="run-progress" style={{ padding: 16 }}>
      <button type="button" onClick={onBack}>← Back to builder</button>
      <h3>Run <code>{runId}</code></h3>
      <p>
        Status: <strong data-testid="run-status">{run ? TERMINAL_LABEL[run.status] ?? run.status : 'loading…'}</strong>
        {' · '}WS: {connected ? 'connected' : 'reconnecting…'}
        {error && <span style={{ color: 'crimson' }}> · {redactText(error, knownSecrets)}</span>}
      </p>
      <div style={{ background: '#e5e7eb', borderRadius: 6, height: 10, maxWidth: 480 }}>
        <div data-testid="run-progress-bar" style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: run?.status === 'failed' ? '#dc2626' : '#16a34a', transition: 'width .3s' }} />
      </div>
      <p style={{ fontSize: 13, color: '#6b7280' }}>{done}/{steps.length} steps · {pct}%</p>
      {live && <button type="button" onClick={() => void cancel()} disabled={cancelling} data-testid="cancel-btn">{cancelling ? 'Cancelling…' : 'Cancel run'}</button>}

      <h4>Timeline (realtime)</h4>
      {steps.length === 0 && <p style={{ color: '#6b7280' }}>Waiting for steps…</p>}
      <ol>
        {steps.map((s) => (
          <li key={s.id} data-testid={`step-${s.stepId}`}>
            <code>{s.stepId}</code> — {s.status}
            {s.errorMessage && <pre style={errStyle}>{redactText(s.errorMessage, knownSecrets)}</pre>}
          </li>
        ))}
      </ol>

      <h4>Events (informational)</h4>
      <ul style={{ fontSize: 13, color: '#374151' }}>
        {events.slice(-20).map((e, i) => (
          <li key={i}><code>{e.event}</code>{e.payload.stepId ? ` ${e.payload.stepId}` : ''}</li>
        ))}
      </ul>
      {run?.errorSummary && <><h4>Error</h4><pre style={errStyle}>{redactText(run.errorSummary, knownSecrets)}</pre></>}
    </section>
  );
}

const errStyle: React.CSSProperties = { background: '#fef2f2', border: '1px solid #fecaca', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' };
