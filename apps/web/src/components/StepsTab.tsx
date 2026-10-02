import { interpolatePreview } from '../lib/variables';
import type { Variable } from '../lib/api';

export interface BuilderStep { id: string; type: string; enabled: boolean; [k: string]: unknown }

interface Props {
  steps: BuilderStep[];
  envId: string | null;
  variables: Variable[];
  onChange: (steps: BuilderStep[]) => void;
}

/** Minimal steps editor (Day 5 shell): reorder/disable/delete + dirty tracking lives in App. */
export function StepsTab({ steps, envId, variables, onChange }: Props) {
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  function renderValue(v: unknown): string {
    if (typeof v !== 'string') return '';
    return interpolatePreview(v, variables, envId);
  }

  return (
    <section data-testid="steps-tab">
      <h3>Steps ({steps.length})</h3>
      {steps.length === 0 && <p style={{ color: '#6b7280' }}>No steps yet.</p>}
      <ol>
        {steps.map((s, i) => (
          <li key={s.id} style={{ marginBottom: 8, opacity: s.enabled ? 1 : 0.55 }}>
            <code>{s.type}</code> <span style={{ color: '#6b7280' }}>{s.id}</span>
            {typeof s.value === 'string' && s.value.includes('{{') && (
              <div style={{ fontSize: 13 }}>→ <code>{renderValue(s.value)}</code> <span style={{ color: '#6b7280' }}>(resolved)</span></div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
              <button type="button" onClick={() => onChange(steps.map((x) => x.id === s.id ? { ...x, enabled: !x.enabled } : x))}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              <button type="button" onClick={() => onChange(steps.filter((x) => x.id !== s.id))}>Delete</button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
