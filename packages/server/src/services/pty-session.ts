import { spawn } from 'node-pty';
import { v4 as uuid } from 'uuid';

export type PtySessionStatus = 'idle' | 'running' | 'exited' | 'closed';

export interface PtySessionInfo {
  id: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  status: PtySessionStatus;
  exitCode?: number;
  createdAt: number;
  exitedAt?: number;
}

export interface PtySessionOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  name?: string;
}

export interface PtySessionEvent {
  type: 'data' | 'exit' | 'error';
  data?: string;
  exitCode?: number;
  error?: string;
}

/**
 * PtySessionManager manages pseudoterminal sessions using node-pty.
 *
 * Each session is a real PTY-backed process (typically a shell) that supports
 * interactive input/output. Sessions persist independently of client connections
 * and can be reattached.
 *
 * Windows support uses ConPTY via node-pty's built-in Windows implementation.
 */
export class PtySessionManager {
  private sessions = new Map<string, any>();
  private sessionInfo = new Map<string, PtySessionInfo>();
  private eventListeners = new Map<string, Set<(event: PtySessionEvent) => void>>();
  private closedSessions = new Set<string>();

  /** List all active session IDs. */
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Get session info by ID. */
  getSessionInfo(id: string): PtySessionInfo | undefined {
    return this.sessionInfo.get(id);
  }

  /** Check if a session exists (regardless of running state). */
  hasSession(id: string): boolean {
    return this.sessions.has(id) && !this.closedSessions.has(id);
  }

  /**
   * Create a new PTY session.
   *
   * On Windows, uses ConPTY. On Linux/macOS, uses forkpty.
   */
  createSession(options: PtySessionOptions = {}): PtySessionInfo {
    const id = `pty-${uuid()}`;
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const env = options.env || { ...process.env };

    // Use cmd.exe on Windows, bash/sh on Unix
    const command = process.platform === 'win32' ? 'cmd.exe' : 'bash';

    const pty = spawn(command, [], {
      cwd,
      cols,
      rows,
      env,
      name: options.name || 'agentboard-pty',
    });

    const now = Date.now();
    const info: PtySessionInfo = {
      id,
      pid: pty.pid,
      cwd,
      cols,
      rows,
      status: 'running',
      createdAt: now,
    };

    this.sessions.set(id, pty);
    this.sessionInfo.set(id, info);
    this.eventListeners.set(id, new Set());

    // Set up data listener via onData
    pty.onData((data: string) => {
      const listeners = this.eventListeners.get(id);
      if (listeners) {
        for (const listener of listeners) {
          listener({ type: 'data', data });
        }
      }
    });

    // Set up exit listener via onExit
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      const info = this.sessionInfo.get(id);
      if (info) {
        info.status = 'exited';
        info.exitCode = exitCode;
        info.exitedAt = Date.now();
      }
      this.closedSessions.add(id);
      const listeners = this.eventListeners.get(id);
      if (listeners) {
        for (const listener of listeners) {
          listener({ type: 'exit', exitCode });
        }
      }
    });

    return info;
  }

  /**
   * Send input data to a PTY session.
   */
  sendInput(id: string, data: string): boolean {
    const pty = this.sessions.get(id);
    if (!pty || this.closedSessions.has(id)) return false;
    pty.write(data);
    return true;
  }

  /** Resize a PTY session's terminal. */
  resize(id: string, cols: number, rows: number): boolean {
    const pty = this.sessions.get(id);
    if (!pty || this.closedSessions.has(id)) return false;
    pty.resize(cols, rows);
    const info = this.sessionInfo.get(id);
    if (info) {
      info.cols = cols;
      info.rows = rows;
    }
    return true;
  }

  /** Kill a PTY session. */
  kill(id: string, signal = 'SIGTERM'): boolean {
    const pty = this.sessions.get(id);
    if (!pty || this.closedSessions.has(id)) return false;
    try {
      pty.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Close (destroy) a PTY session. */
  close(id: string): boolean {
    const pty = this.sessions.get(id);
    if (!pty || this.closedSessions.has(id)) return false;
    try {
      pty.kill('SIGKILL');
      return true;
    } catch {
      return false;
    }
  }

  /** Subscribe to session events. Returns an unsubscribe function. */
  subscribe(id: string, listener: (event: PtySessionEvent) => void): () => void {
    const listeners = this.eventListeners.get(id);
    if (!listeners) {
      return () => {};
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Get all session info. */
  getAllSessionInfo(): PtySessionInfo[] {
    return Array.from(this.sessionInfo.values());
  }

  /** Clean up all sessions. */
  shutdownAll(): void {
    for (const [id, pty] of this.sessions) {
      if (!this.closedSessions.has(id)) {
        try { pty.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
    this.sessions.clear();
    this.sessionInfo.clear();
    this.eventListeners.clear();
    this.closedSessions.clear();
  }
}

/** Singleton instance. */
export const ptySessionManager = new PtySessionManager();
