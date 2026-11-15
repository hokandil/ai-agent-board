/**
 * Startup robustness helpers.
 *
 * The dev server historically could "hang" without ever opening its port:
 *  - `server.listen()` ran only after heavy initialization (agent provider
 *    start, worktree reconciliation), so a hang in any of those steps left the
 *    process alive but unreachable, with no diagnostic.
 *  - There was no `server.on('error')` handler, so an `EADDRINUSE` (an orphaned
 *    process still holding the port) surfaced only as an unhandled error and the
 *    process stayed alive without listening.
 *
 * These helpers make startup failures actionable and bound the slow steps so
 * the port always opens. They are intentionally small and pure so they can be
 * unit-tested without booting the whole server.
 */

/** Build an actionable, human-readable message for a `server.listen` failure. */
export function describeListenError(err: NodeJS.ErrnoException, port: number, host: string): string {
  const code = err?.code;
  if (code === 'EADDRINUSE') {
    return (
      `Port ${port} on ${host} is already in use — another Agent Board server or a different process is listening there. ` +
      `This is usually an orphaned process from a previous dev run that did not shut down cleanly. ` +
      `Find it with "netstat -ano | findstr :${port}" (Windows) or "lsof -i :${port}" (macOS/Linux), ` +
      `then stop that process and restart. Alternatively set a different PORT in packages/server/.env.`
    );
  }
  if (code === 'EACCES') {
    return `Permission denied binding ${host}:${port}. Use a port above 1024 or run with appropriate privileges.`;
  }
  if (code === 'EADDRNOTAVAIL') {
    return `Address ${host} is not available on this machine. Check HOST in packages/server/.env (use 127.0.0.1 for local dev).`;
  }
  return `Failed to listen on ${host}:${port}: ${err?.message ?? String(err)}`;
}

/**
 * Race a promise against a timeout. Rejects with a clear, labelled error if the
 * promise does not settle within `ms`. Used to bound slow startup steps (e.g.
 * an agent provider `start()` that spawns a CLI) so one hanging step cannot
 * block the whole server from listening. The underlying promise cannot be
 * cancelled, but the caller treats a timeout as "unavailable" and moves on.
 */
export function withStartupTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface StartupHealth {
  status: 'ok';
  /** True once startup has finished and the server is fully operational. */
  ready: boolean;
  /** Current startup phase (for diagnostics while not yet ready). */
  phase: string;
  uptimeMs: number;
  timestamp: number;
}

/**
 * Tracks startup phases and readiness, and emits timing diagnostics so a slow
 * or stuck phase is visible in the log instead of a silent hang. The health
 * endpoint reports `ready`/`phase` so a client can distinguish "starting" from
 * "fully ready" rather than treating a listening-but-initializing server as down.
 */
export class StartupProgress {
  private phase = 'boot';
  private ready = false;
  private readonly startedAt = Date.now();
  private lastMark = Date.now();

  /** Enter a new startup phase and log elapsed timing. */
  begin(phase: string): void {
    const now = Date.now();
    const total = now - this.startedAt;
    const delta = now - this.lastMark;
    this.lastMark = now;
    this.phase = phase;
    console.log(`[startup] phase=${phase} elapsed=${total}ms (+${delta}ms)`);
  }

  /** Mark startup complete. */
  markReady(): void {
    this.ready = true;
    this.phase = 'ready';
    console.log(`[startup] ready in ${Date.now() - this.startedAt}ms`);
  }

  health(): StartupHealth {
    return {
      status: 'ok',
      ready: this.ready,
      phase: this.phase,
      uptimeMs: Date.now() - this.startedAt,
      timestamp: Date.now(),
    };
  }
}
