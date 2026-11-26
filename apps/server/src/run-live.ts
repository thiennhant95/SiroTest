/**
 * Read-only live view for a running test (run page).
 *
 * The runner spawns Playwright with `--remote-debugging-port=<port>`; this
 * module attaches over CDP, streams JPEG frames to WS peers subscribed to the
 * runId, and detaches when the run is terminal. It NEVER sends input: a run
 * must stay deterministic (record mode is the interactive surface).
 */
import { chromium } from 'playwright-core';

type Broadcast = (event: string, payload: unknown) => void;

interface FrameMeta {
  deviceWidth: number;
  deviceHeight: number;
}

const active = new Set<string>();

export function stopRunLiveView(runId: string): void {
  active.delete(runId);
}

/**
 * @param runId   run id (WS fan-out key)
 * @param port    CDP port passed to the runner
 * @param isDone  returns true once the run reached a terminal status
 */
export function startRunLiveView(runId: string, port: number, isDone: () => Promise<boolean>): void {
  const broadcast = (globalThis as { __vvWsBroadcast?: Broadcast }).__vvWsBroadcast;
  if (!broadcast || active.has(runId)) return;
  active.add(runId);

  void (async () => {
    const deadline = Date.now() + 45_000;
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
    while (Date.now() < deadline) {
      if (await isDone().catch(() => false)) return;
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (!browser) return;

    try {
      const ctx = browser.contexts()[0];
      let page = ctx?.pages()[0];
      while (!page && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        page = ctx?.pages()[0];
      }
      if (!page) return;

      const cdp = await ctx.newCDPSession(page);
      let meta: FrameMeta | undefined;
      cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: FrameMeta }) => {
        meta = frame.metadata;
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        broadcast('run.screencast', { runId, data: frame.data, metadata: frame.metadata });
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 55,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 2,
      });

      const timer = setInterval(() => {
        void (async () => {
          if (!(await isDone().catch(() => true))) return;
          clearInterval(timer);
          stopRunLiveView(runId);
          await cdp.send('Page.stopScreencast').catch(() => {});
          await cdp.detach().catch(() => {});
          void meta;
        })();
      }, 2000);
      timer.unref?.();
    } catch {
      stopRunLiveView(runId);
    }
  })();
}
