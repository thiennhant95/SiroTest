/**
 * normalize.ts — collapse noisy captures into clean semantic steps.
 *  - continuous typing on same input -> ONE fill (debounce, replace value)
 *  - drop click on input when immediately followed by fill on same target
 *    (unless click carries semantic importance, e.g. opens a picker)
 *  - collapse redirect chains: consecutive gotos within window -> keep last,
 *    preserve evidence count in meta
 *  - second masking pass (defense in depth; capture.ts already masks)
 */
import type { CapturedStep } from './types.js';

export interface NormalizerOptions {
  /** ms window for typing debounce. Default 1200 */
  fillDebounceMs?: number;
  /** ms window for redirect collapse. Default 1500 */
  redirectWindowMs?: number;
}

const DEFAULTS: Required<NormalizerOptions> = {
  fillDebounceMs: 1200,
  redirectWindowMs: 1500,
};

function isFillableClick(s: CapturedStep): boolean {
  return s.type === 'click' && !s.meta?.['semantic'];
}

export class StepNormalizer {
  private opts: Required<NormalizerOptions>;
  private steps: CapturedStep[] = [];

  constructor(opts: NormalizerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Streaming entry: push one captured step, returns steps newly finalized. */
  push(step: CapturedStep): CapturedStep[] {
    const last = this.steps[this.steps.length - 1];

    // 1) typing debounce: same elementKey fill within window -> replace value
    if (
      last && last.type === 'fill' && step.type === 'fill' &&
      last.elementKey === step.elementKey &&
      step.at - last.at <= this.opts.fillDebounceMs
    ) {
      last.at = step.at;
      last.value = step.value;
      last.sensitive = last.sensitive || step.sensitive;
      return [];
    }

    // 2) redirect collapse: consecutive goto within window -> keep last
    if (
      last && last.type === 'goto' && step.type === 'goto' &&
      step.at - last.at <= this.opts.redirectWindowMs
    ) {
      const count = Number(last.meta?.['redirectChain'] ?? 1) + 1;
      last.at = step.at;
      last.url = step.url;
      last.value = step.url;
      last.meta = { ...(last.meta ?? {}), redirectChain: count };
      return [];
    }

    this.steps.push({ ...step, meta: { ...(step.meta ?? {}) } });
    return this.finalizeOne();
  }

  /** After push, check whether previous click is now redundant (next is fill). */
  private finalizeOne(): CapturedStep[] {
    const n = this.steps.length;
    if (n >= 2) {
      const prev = this.steps[n - 2]!;
      const cur = this.steps[n - 1]!;
      if (
        isFillableClick(prev) && cur.type === 'fill' &&
        prev.elementKey === cur.elementKey &&
        cur.at - prev.at <= this.opts.fillDebounceMs
      ) {
        // remove the redundant click; emit nothing yet (cur stays pending)
        this.steps.splice(n - 2, 1);
        return [];
      }
    }
    // emit all but the trailing pending step (it may still be collapsed)
    if (this.steps.length > 1) {
      return this.steps.splice(0, this.steps.length - 1);
    }
    return [];
  }

  flush(): CapturedStep[] {
    const out = this.steps;
    this.steps = [];
    return out;
  }

  get draft(): readonly CapturedStep[] {
    return this.steps;
  }
}

/** Batch post-process (used on stop / persist). Pure + deterministic. */
export function normalizeBatch(input: CapturedStep[], opts: NormalizerOptions = {}): CapturedStep[] {
  const norm = new StepNormalizer(opts);
  const out: CapturedStep[] = [];
  for (const s of input) out.push(...norm.push(maskStep(s)));
  out.push(...norm.flush());
  return out;
}

function maskStep(s: CapturedStep): CapturedStep {
  if (s.type === 'fill' && s.sensitive && s.value !== '***MASKED***') {
    return { ...s, value: '***MASKED***' };
  }
  return s;
}
