/**
 * Child-process helpers for Step 5/8 and cancellation (runner-spec.md).
 *
 * Security (11-security/security.md):
 * - Spawn Playwright/Node with ARGUMENT ARRAYS only, shell: false.
 *   Never concatenate user input (URLs, step values, paths) into shell strings.
 * Cancellation:
 * - killProcessTree() terminates the whole Playwright process tree:
 *   Windows -> `taskkill /PID <pid> /T /F` (arg array);
 *   POSIX   -> kill(-pid) so children in the detached group die too.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnResult {
  child: ChildProcess;
  done: Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** line handler for streamed stdout/stderr (already redacted by caller) */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
}

/** Spawn a command with an argument array. shell is ALWAYS false. */
export function spawnArgs(command: string, args: readonly string[], opts: SpawnOptions): SpawnResult {
  const child = spawn(command, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  const flush = (stream: 'stdout' | 'stderr', buf: string): string => {
    const idx = buf.lastIndexOf('\n');
    if (idx === -1) return buf;
    const complete = buf.slice(0, idx);
    for (const line of complete.split('\n')) opts.onOutput?.(stream, line);
    return buf.slice(idx + 1);
  };
  child.stdout?.on('data', (d: Buffer) => {
    stdoutBuf = flush('stdout', stdoutBuf + d.toString('utf8'));
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderrBuf = flush('stderr', stderrBuf + d.toString('utf8'));
  });

  const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.on('close', (exitCode, signal) => {
      if (stdoutBuf.length > 0) opts.onOutput?.('stdout', stdoutBuf);
      if (stderrBuf.length > 0) opts.onOutput?.('stderr', stderrBuf);
      resolve({ exitCode, signal });
    });
  });
  return { child, done };
}

/** Terminate a process TREE (Playwright spawns browser/server children). */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    // taskkill with arg array — no shell, no string concatenation.
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  try {
    // Negative pid targets the detached process group created in spawnArgs.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead — nothing to do
    }
  }
}

/** Cooperative cancellation flag shared between run() and cancelRun(). */
export class CancellationToken {
  private _cancelled = false;
  get cancelled(): boolean {
    return this._cancelled;
  }
  cancel(): void {
    this._cancelled = true;
  }
}
