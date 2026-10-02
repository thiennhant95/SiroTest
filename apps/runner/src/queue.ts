/**
 * Concurrency gate (runner-spec.md): P0 default 1-2 concurrent runs per host,
 * configurable via RUNNER_MAX_CONCURRENT. Excess runs queue FIFO and emit
 * run.queued. Recorder sessions never share this pool, so execution workers
 * cannot be starved by recording.
 */

export interface QueuedJob<T> {
  runId: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export class RunQueue {
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: Array<QueuedJob<unknown>> = [];
  readonly onQueued?: (runId: string, position: number) => void;

  constructor(maxConcurrent?: number, opts?: { onQueued?: (runId: string, position: number) => void }) {
    const parsed = maxConcurrent ?? Number(process.env.RUNNER_MAX_CONCURRENT ?? 2);
    this.maxConcurrent = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
    this.onQueued = opts?.onQueued;
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  /** Submit a run; resolves/rejects with the job result. Excess jobs wait FIFO. */
  submit<T>(runId: string, execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = { runId, execute, resolve: resolve as (v: T) => void, reject };
      if (this.active < this.maxConcurrent) {
        void this.start(job as QueuedJob<unknown>);
      } else {
        this.waiting.push(job as QueuedJob<unknown>);
        this.onQueued?.(runId, this.waiting.length);
      }
    });
  }

  private async start(job: QueuedJob<unknown>): Promise<void> {
    this.active += 1;
    try {
      const value = await job.execute();
      job.resolve(value);
    } catch (err) {
      job.reject(err);
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) void this.start(next);
    }
  }
}
