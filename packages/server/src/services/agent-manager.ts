import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task, TaskGroup, AgentEvent, AgentType, SessionStatus, AgentSession, SessionConcurrencyLimits } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProvider, AgentSession as CoreAgentSession, AgentInfo, AgentAttachment } from '@codewithdan/agent-sdk-core';
import type { AgentEvent as CoreAgentEvent } from '@codewithdan/agent-sdk-core';
import { CopilotProvider, ClaudeProvider, CodexProvider, OpenCodeProvider, HermesProvider, OpenClawProvider, GrokProvider } from '@codewithdan/agent-sdk-core';
import { broadcast } from '../websocket.js';
import {
  cleanupTaskWorktree,
  inspectTaskWorktree,
  type WorktreeCleanupInspection,
  type WorktreeCleanupResult,
} from './worktree-cleanup.js';
import { UPLOADS_DIR } from '../routes/attachments.js';
import type { AttachmentStore } from '../repositories/attachment-types.js';
import { errorMessage } from '../utils.js';
import { gitExecFileSync } from '../routes/helpers.js';
import { detectAvailableAgents } from './agent-detection.js';
import { resolveTaskTimeoutMs } from './agent-timeout.js';
import { withStartupTimeout } from '../startup.js';

/** Max time to wait for a single agent provider's start() during boot. */
const AGENT_START_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AGENT_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

/** Structured log entry for agent lifecycle events. */
interface AgentLogEntry {
  level: 'info' | 'warn' | 'error';
  component: 'agent-manager';
  agentType?: AgentType;
  sessionId?: string;
  taskId?: string;
  correlationId?: string;
  errorCategory?: 'cli_missing' | 'startup_failure' | 'execution_failure' | 'persist_failure' | 'worktree_failure' | 'unhandled';
  message: string;
  error?: string;
}

/** Emit a structured log entry as a single-line JSON object. */
function agentLog(entry: AgentLogEntry): void {
  console.log(JSON.stringify(entry));
}

function loadAttachmentAsBase64(filePath: string, displayName: string, mimeType: string): AgentAttachment | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[agent-manager] attachment file not found: ${filePath}`);
      return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    const data = fileBuffer.toString('base64');
    console.log(`[agent-manager] loaded attachment: ${displayName} (${mimeType}, ${fileBuffer.length} bytes, base64 length: ${data.length})`);
    return { type: 'base64_image', data, displayName, mediaType: mimeType };
  } catch (err) {
    console.error(`[agent-manager] failed to load attachment ${filePath}:`, err);
    return null;
  }
}

interface ManagedSession {
  sessionId: string;
  session?: CoreAgentSession;
  taskId?: string;
  agentType: AgentType;
  status: SessionStatus;
  model?: string;
  worktreePath?: string;
  startTime: number;
  completedAt?: number;
  createdAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  /** Task-level status persistence callback (set by startAgent). Invoked on
   *  execution-state transitions and on terminal status so the task's agentStatus
   *  is durably persisted and group queues can drain. */
  onStatusChange?: (status: Task['agentStatus']) => void | Promise<void>;
  /** Persists the worktree path once the worktree is set up (set by startAgent). */
  onWorktreeCreated?: (worktreePath: string) => void | Promise<void>;
  /** Provider-side session id to resume on the next start (set by resumeSession). */
  resumeProviderSessionId?: string;
}

/** A permission request awaiting an explicit user decision (Stage C). */
interface PendingPermission {
  requestId: string;
  taskId: string;
  sessionId: string;
  kind: string;
  tool?: string;
  createdAt: number;
  resolve: (decision: 'approved' | 'denied' | 'expired' | 'cancelled') => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How long a permission request waits for a user decision before expiring. */
const PERMISSION_REQUEST_TTL_MS = 5 * 60_000;

// Event log per task (capped to prevent unbounded growth)
const MAX_EVENTS_PER_TASK = 2000;
const MAX_EVENT_LOG_TASKS = 200;

// Deleted-task guard TTL
const DELETED_TASK_TTL_MS = 60_000;

const STREAM_BUFFER_FLUSH_MS = 40;
const STOPPED_TASK_TTL_MS = 30_000;

// Upper bound on accumulated assistant prose kept for summary extraction.
// We only need the tail (the final <task-summary> block), so cap memory use.
const MAX_SUMMARY_BUFFER = 64_000;
const MAX_RESULT_BUFFER = 512 * 1024;

function extractFullAgentOutput(buffer: string): string | null {
  const summaryStart = buffer.lastIndexOf('<task-summary>');
  const body = (summaryStart >= 0 ? buffer.slice(0, summaryStart) : buffer).trim();
  return body || null;
}

/**
 * Extract the agent-authored task summary from accumulated assistant prose.
 * Returns the trimmed contents of the LAST `<task-summary>…</task-summary>`
 * block, or null when no usable block is present.
 */
function extractTaskSummary(buffer: string): string | null {
  if (!buffer) return null;
  const closed = [...buffer.matchAll(/<task-summary>([\s\S]*?)<\/task-summary>/g)];
  if (closed.length > 0) {
    const body = closed[closed.length - 1][1].trim();
    return body.length > 0 ? body : null;
  }
  // Tolerate a missing closing tag: take everything after the last opening tag.
  const openIdx = buffer.lastIndexOf('<task-summary>');
  if (openIdx >= 0) {
    const body = buffer.slice(openIdx + '<task-summary>'.length).replace(/<\/task-summary>/g, '').trim();
    return body.length > 0 ? body : null;
  }
  return null;
}

function getErrorStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const stderr = (err as Error & { stderr?: Buffer | string }).stderr;
    return stderr?.toString() ?? '';
  }
  return '';
}

interface GroupQueue {
  groupId: string;
  maxConcurrency: number;
  pendingTaskIds: string[];
  runningTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  tasks: Map<string, Task>;
  makeStatusCallback: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>;
  makeWorktreeCallback: (task: Task) => (worktreePath: string) => void | Promise<void>;
  onChildComplete: (taskId: string) => void | Promise<void>;
}

export class AgentManager {
  private providers = new Map<AgentType, AgentProvider>();
  /** Sessions keyed by sessionId (not taskId — multiple sessions per task possible) */
  private sessions = new Map<string, ManagedSession>();
  /** Maps taskId → sessionId (a task can have at most one active session) */
  private taskToSession = new Map<string, string>();
  /** Maps sessionId → taskId (reverse lookup) */
  private sessionToTask = new Map<string, string>();
  private deletedTasks = new Set<string>();
  /** Tasks stopped by user — prevents duplicate agent_complete from terminateOnce */
  private stoppedTasks = new Set<string>();
  /** Permission requests awaiting an explicit user decision, keyed by requestId. */
  private pendingPermissions = new Map<string, PendingPermission>();
  private eventLogs = new Map<string, AgentEvent[]>();
  private eventRepo: TaskRepository | null = null;
  private attachmentStore: AttachmentStore | null = null;
  private availableAgents: AgentInfo[] = [];
  /** Pending coalesced output/thinking broadcast per task */
  private streamBuffer = new Map<string, { event: AgentEvent; timer: ReturnType<typeof setTimeout> }>();
  private groupQueues = new Map<string, GroupQueue>();
  /** Per-repo mutex to serialize git operations (merge, checkout) */
  private repoLocks = new Map<string, Promise<void>>();
  /** Active session count per provider type (for concurrency limits) */
  private providerSessionCounts = new Map<AgentType, number>();
  /** Active session count per project (for concurrency limits) */
  private projectSessionCounts = new Map<string, number>();
  /** Concurrency limits. Undefined = unlimited. */
  private concurrencyLimits: SessionConcurrencyLimits = {};

  /** Call once at startup to enable event persistence. */
  initEventPersistence(repo: TaskRepository): void {
    this.eventRepo = repo;
  }

  initAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  /** Detect available agents, register providers, start the ones that are available. */
  async initialize(): Promise<void> {
    // Register all providers
    this.providers.set('copilot', new CopilotProvider());
    this.providers.set('claude', new ClaudeProvider());
    this.providers.set('codex', new CodexProvider());
    this.providers.set('opencode', new OpenCodeProvider());
    this.providers.set('hermes', new HermesProvider({
      command: process.env.HERMES_COMMAND?.trim() || 'hermes',
    }));
    this.providers.set('openclaw', new OpenClawProvider());
    this.providers.set('grok', new GrokProvider());

    // Detect which agents are actually available on this system
    this.availableAgents = await detectAvailableAgents();
    const available = this.availableAgents.filter(a => a.available);

    console.log(
      `[agent-manager] detected agents: ${this.availableAgents.map(a => `${a.displayName}=${a.available ? 'yes' : 'no'}`).join(', ')}`
    );

    // In test/CI environments there are no real agent credentials, and some
    // provider SDKs spawn a background session on start() that rejects (e.g.
    // Copilot without GitHub auth) as a detached unhandled rejection — which
    // would crash the server. When startup is disabled we skip booting real SDK
    // clients. Because no provider is started, no agent can actually run, so we
    // also report every detected agent as unavailable. This keeps the agents
    // listed in the UI (as "Unavailable") while ensuring real-execution E2E
    // specs skip instead of attempting sessions that would hang or fail — a CLI
    // shim on PATH (e.g. node_modules/.bin/copilot) otherwise makes detection
    // report an agent that cannot be used here as "available".
    const skipAgentStartup =
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === '1' ||
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === 'true';
    if (skipAgentStartup) {
      console.log('[agent-manager] AGENTBOARD_DISABLE_AGENT_STARTUP set — skipping provider start()');
      this.availableAgents = this.availableAgents.map(a => ({
        ...a,
        available: false,
        reason: 'Agent startup disabled (test environment)',
      }));
      return;
    }

    // Start available providers
    for (const info of available) {
      const provider = this.providers.get(info.name);
      if (provider) {
        try {
          await withStartupTimeout(provider.start(), AGENT_START_TIMEOUT_MS, `agent provider "${info.name}" start()`);
        } catch (err: unknown) {
          agentLog({
            level: 'error',
            component: 'agent-manager',
            agentType: info.name as AgentType,
            errorCategory: 'startup_failure',
            message: `Failed to start agent provider: ${info.displayName}`,
            error: errorMessage(err),
          });
          // Mark as unavailable
          const agentInfo = this.availableAgents.find(a => a.name === info.name);
          if (agentInfo) {
            agentInfo.available = false;
            agentInfo.reason = `Failed to start: ${errorMessage(err)}`;
          }
        }
      }
    }
  }

  async refresh(): Promise<AgentInfo[]> {
    const detected = await detectAvailableAgents();
    for (const info of detected) {
      const provider = this.providers.get(info.name);
      if (!info.available || !provider) continue;
      const wasAvailable = this.availableAgents.find((item) => item.name === info.name)?.available;
      if (wasAvailable) continue;
      try {
        await provider.start();
      } catch (err: unknown) {
        info.available = false;
        info.reason = `Failed to start: ${errorMessage(err)}`;
      }
    }
    this.availableAgents = detected;
    return this.getAvailableAgents();
  }

  getAvailableAgents(): AgentInfo[] {
    return [...this.availableAgents];
  }

  // ─── Session Management ──────────────────────────────────────────────

  /** Configure concurrency limits for sessions. */
  setConcurrencyLimits(limits: SessionConcurrencyLimits): void {
    this.concurrencyLimits = { ...limits };
  }

  /** Create a new agent session. Optionally links it to a task without starting execution. */
  createSession(
    agentType: AgentType,
    taskId?: string,
    model?: string,
    _useWorktree = false,
    _repoPath?: string,
    _branchName?: string,
    _baseBranch?: string,
  ): string {
    const sessionId = `session-${uuid()}`;
    const now = Date.now();

    const entry: ManagedSession = {
      sessionId,
      taskId,
      agentType,
      status: 'idle',
      model,
      startTime: now,
      createdAt: now,
    };

    if (taskId) {
      this.taskToSession.set(taskId, sessionId);
      this.sessionToTask.set(sessionId, taskId);
    }

    this.sessions.set(sessionId, entry);
    agentLog({
      level: 'info',
      component: 'agent-manager',
      agentType,
      sessionId,
      taskId: taskId ?? undefined,
      message: `Session created: agent=${agentType}, task=${taskId ?? 'none'}`,
    });
    return sessionId;
  }

  /** Assign a task to an existing idle session without starting execution. */
  assignTaskToSession(sessionId: string, taskId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (entry.taskId && entry.taskId !== taskId) return false; // already assigned to a different task
    if (entry.status !== 'idle' && entry.status !== 'stopped' && entry.status !== 'failed' && entry.status !== 'complete') return false;

    // Unlink any previous task
    if (entry.taskId) {
      this.taskToSession.delete(entry.taskId);
    }
    this.taskToSession.set(taskId, sessionId);
    this.sessionToTask.set(sessionId, taskId);
    entry.taskId = taskId;
    entry.status = 'idle';
    return true;
  }

  /** Start executing a session. Sets up worktree, creates SDK session, runs the prompt. */
  async startSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    if (entry.status === 'executing' || entry.status === 'planning') throw new Error(`Session ${sessionId} is already running`);

    const task = entry.taskId ? await this.getTaskForSession(entry) : undefined;
    if (!task) throw new Error(`Session ${sessionId} has no assigned task`);

    // Check concurrency limits
    this.enforceConcurrencyLimits(task.projectId);

    // Mark as executing
    entry.status = 'planning';
    entry.startTime = Date.now();

    // Clear any prior run's summary
    if (task.summary != null) {
      void this.eventRepo?.update(task.id, { summary: null }).catch(() => {});
    }

    const provider = this.providers.get(entry.agentType);
    if (!provider) {
      entry.status = 'failed';
      agentLog({
        level: 'error',
        component: 'agent-manager',
        agentType: entry.agentType,
        sessionId,
        taskId: task.id,
        errorCategory: 'startup_failure',
        message: `No provider registered for agent type: ${entry.agentType}`,
      });
      this.emitEvent(task.id, {
        id: uuid(), taskId: task.id, type: 'error',
        content: `No provider registered for agent type: ${entry.agentType}`,
        timestamp: Date.now(),
        metadata: { agentType: entry.agentType },
      });
      throw new Error(`No provider registered for agent type: ${entry.agentType}`);
    }

    const agentInfo = this.availableAgents.find(a => a.name === entry.agentType);
    if (!agentInfo?.available) {
      entry.status = 'failed';
      agentLog({
        level: 'error',
        component: 'agent-manager',
        agentType: entry.agentType,
        sessionId,
        taskId: task.id,
        errorCategory: 'startup_failure',
        message: `Agent not available: ${provider.displayName}`,
        error: agentInfo?.reason,
      });
      this.emitEvent(task.id, {
        id: uuid(), taskId: task.id, type: 'error',
        content: `Agent ${provider.displayName} is not available: ${agentInfo?.reason || 'unknown reason'}`,
        timestamp: Date.now(),
        metadata: { agentType: entry.agentType },
      });
      throw new Error(`Agent ${provider.displayName} is not available`);
    }

    // Increment concurrency counters
    this.providerSessionCounts.set(entry.agentType, (this.providerSessionCounts.get(entry.agentType) || 0) + 1);
    if (task.projectId) {
      this.projectSessionCounts.set(task.projectId, (this.projectSessionCounts.get(task.projectId) || 0) + 1);
    }

    let terminated = false;
    const durationStart = Date.now();

    const terminateOnce = async (status: 'complete' | 'failed', errorMessage?: string) => {
      if (terminated) return;
      if (this.stoppedTasks.has(task.id)) { terminated = true; return; }
      terminated = true;
      // Use the captured session entry: the completion/timeout/error paths remove
      // the session from this.sessions BEFORE calling terminateOnce. Re-fetching it
      // here would return undefined and throw before the concurrency counters are
      // released, leaking the active-session count.
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      const duration = Date.now() - durationStart;

      if (status === 'complete') {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'complete',
          content: 'Task completed successfully.',
          timestamp: Date.now(),
          metadata: { agentType: entry.agentType, duration },
        });
      } else {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorMessage || 'Task failed.',
          timestamp: Date.now(),
          metadata: { agentType: entry.agentType, duration, error: errorMessage },
        });
      }

      broadcast({
        type: 'agent_complete',
        payload: {
          taskId: task.id,
          status,
          agentType: entry.agentType,
          duration,
          eventCount: (await this.getEvents(task.id)).length,
        },
      });

      entry.status = status === 'complete' ? 'complete' : 'failed';
      entry.completedAt = Date.now();

      // Decrement concurrency counters
      this.providerSessionCounts.set(entry.agentType, Math.max(0, (this.providerSessionCounts.get(entry.agentType) || 1) - 1));
      if (task.projectId) {
        this.projectSessionCounts.set(task.projectId, Math.max(0, (this.projectSessionCounts.get(task.projectId) || 1) - 1));
      }

      // Clear session from task mapping but keep the session record for history
      if (entry.taskId) {
        this.taskToSession.delete(entry.taskId);
      }
      this.sessionToTask.delete(sessionId);

      // Cancel any permission requests still awaiting a decision for this task.
      this.cancelPendingPermissions(task.id);

      // Capture the provider-side session id (some providers assign it during streaming).
      this.persistProviderSessionId(task.id, entry.session?.sessionId);

      // Persist the terminal task status (and drive group-queue draining) AFTER the
      // concurrency counters are released, so a drained group can start its next
      // child without being blocked by a stale counter.
      try {
        await entry.onStatusChange?.(status);
      } catch (err) {
        agentLog({
          level: 'error',
          component: 'agent-manager',
          agentType: entry.agentType,
          sessionId,
          taskId: task.id,
          errorCategory: 'persist_failure',
          message: `Failed to persist terminal status for task ${task.id}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Set up worktree if configured
    let worktreePath: string | undefined;
    if (task.useWorktree) {
      const priorWorktree = task.worktreePath;
      try {
        worktreePath = this.setupWorktree(task);
        if (worktreePath) {
          task.worktreePath = worktreePath;
          entry.worktreePath = worktreePath;
          // Persist the worktree path durably (previously only set in memory).
          if (entry.onWorktreeCreated) {
            Promise.resolve(entry.onWorktreeCreated(worktreePath)).catch((err) => {
              console.error(`[agent-manager] failed to persist worktree path for task ${task.id}:`, err);
            });
          }
          const reused = priorWorktree != null && path.resolve(priorWorktree) === path.resolve(worktreePath);
          let dirtyHint = '';
          if (reused) {
            try {
              const status = gitExecFileSync(['status', '--porcelain'], {
                cwd: worktreePath, stdio: 'pipe',
              }).toString().trim();
              dirtyHint = status ? '\nNote: worktree has uncommitted changes from a prior run.' : '';
            } catch {
              /* ignore status probe failures */
            }
          }
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `${reused ? 'Reusing existing git worktree at' : 'Git worktree created at'} ${worktreePath}\nBranch: ${task.branchName}\nBase: ${task.baseBranch || 'main'}${dirtyHint}`,
            timestamp: Date.now(),
          });
        }
      } catch (err: unknown) {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: `Worktree setup failed: ${errorMessage(err)}`,
          timestamp: Date.now(),
        });
        entry.status = 'failed';
        terminateOnce('failed', `Worktree setup failed: ${errorMessage(err)}`);
        return;
      }
    }

    // Launch the agent session asynchronously
    (async () => {
      try {
        const workingDirectory = worktreePath || task.repoPath || process.cwd();
        const hasGit = fs.existsSync(path.join(workingDirectory, '.git'));
        const safeTitle = task.title.replace(/[<>]/g, '');
        const systemPrompt = `
<context>
You are a coding agent working on a task in the project directory: ${workingDirectory}
Task: ${safeTitle}
${worktreePath ? `\nIMPORTANT: All file paths MUST be under ${worktreePath}. Do NOT reference or edit files at ${task.repoPath} directly.` : ''}
${!hasGit ? `\nIMPORTANT: This directory is not a git repository. Run \`git init\` first before making any changes, so all work is tracked.` : ''}
Complete the task described in the user prompt. Be thorough — read relevant files,
make precise edits, and verify your changes compile/pass tests when applicable.

When you have finished, end your VERY LAST message with a task summary in EXACTLY this format (keep the tags on their own lines):
<task-summary>
## Completed
A clear description of what you accomplished. This section is required and must not be empty.
## Comments
Optional notes, caveats, decisions, or context. Omit the body if there is nothing to add.
## Remaining
Optional list of any work you did not complete or that should be followed up. Omit the body if everything is done.
</task-summary>
</context>
`;

        let lastFileEventFile: string | null = null;
        let lastFileEventType: string | null = null;
        let summaryBuffer = '';
        let resultBuffer = '';

        const coreSession = await provider.createSession({
          contextId: sessionId,
          workingDirectory,
          repoPath: task.repoPath,
          resumeSessionId: entry.resumeProviderSessionId,
          systemPrompt,
          // Stage C: interactive approval for ACP providers (Hermes/OpenClaw/Grok), Copilot,
          // and Claude. The provider's permission request is routed to the Board and the
          // user's explicit decision is awaited (never auto-approved). The async hook is
          // awaited by the patched providers. OpenCode wiring is Stage C2; Codex exposes
          // only a config approval policy (limitation surfaced, not auto-approved).
          hooks: (['hermes', 'openclaw', 'grok', 'copilot', 'claude'].includes(entry.agentType)
            ? {
                onPermissionRequest: (req: { kind: string; tool?: string }) =>
                  this.requestPermission(task.id, sessionId, req.kind, req.tool).then((decision) => ({
                    kind: decision === 'approved' ? 'approved' : 'denied-by-rules',
                  })),
              }
            : undefined) as any,
          onEvent: (coreEvent: CoreAgentEvent) => {
            try {
              const metadata: Record<string, unknown> = { ...coreEvent.metadata };
              let eventType = coreEvent.type;
              let content = coreEvent.content;

              if (coreEvent.type === 'output') {
                summaryBuffer += content;
                resultBuffer += content;
                if (resultBuffer.length > MAX_RESULT_BUFFER) {
                  resultBuffer = `[Earlier agent output omitted because it exceeded ${MAX_RESULT_BUFFER} characters.]\n\n${resultBuffer.slice(-MAX_RESULT_BUFFER)}`;
                }
                if (summaryBuffer.length > MAX_SUMMARY_BUFFER) {
                  summaryBuffer = summaryBuffer.slice(-MAX_SUMMARY_BUFFER);
                }
                if (content.includes('task-summary')) {
                  content = content.replace(/<\/?task-summary>/g, '');
                }
              }

              if (coreEvent.type === 'command' && metadata.command === 'create') {
                eventType = 'file_write';
              }

              if ((eventType === 'file_write' || eventType === 'file_edit' || eventType === 'file_read') && !metadata.file) {
                const colonIdx = coreEvent.content.indexOf(':');
                if (colonIdx > 0) {
                  try {
                    const args = JSON.parse(coreEvent.content.slice(colonIdx + 1).trim());
                    const filePath = args.path || args.file_path || args.file || args.filename;
                    if (filePath) {
                      metadata.file = filePath;
                      lastFileEventFile = filePath;
                      lastFileEventType = eventType;
                    }
                  } catch { /* not JSON args, skip */ }
                }
              }

              if (coreEvent.type === 'command' && metadata.command === 'bash') {
                const content = coreEvent.content;
                const redirectMatch = content.match(/(?:cat|echo|printf)\s+.*?>\s*(\S+)/);
                const teeMatch = content.match(/tee\s+(\S+)/);
                const filePath = redirectMatch?.[1] || teeMatch?.[1];
                if (filePath && !filePath.startsWith('-')) {
                  metadata.file = filePath.replace(/['"]/g, '');
                  metadata.fileEventType = 'file_write';
                }
              }

              if (coreEvent.type === 'command_output' && lastFileEventFile && lastFileEventType) {
                metadata.file = lastFileEventFile;
                metadata.fileEventType = lastFileEventType;
                lastFileEventFile = null;
                lastFileEventType = null;
              } else if (eventType !== 'file_write' && eventType !== 'file_edit' && eventType !== 'file_read') {
                lastFileEventFile = null;
                lastFileEventType = null;
              }

              this.emitEvent(task.id, {
                id: coreEvent.id,
                taskId: task.id,
                type: eventType as AgentEvent['type'],
                content,
                timestamp: coreEvent.timestamp,
                metadata,
              });
            } catch (err: unknown) {
              agentLog({
                level: 'error',
                component: 'agent-manager',
                agentType: entry.agentType,
                sessionId,
                taskId: task.id,
                errorCategory: 'execution_failure',
                message: 'Error processing agent event',
                error: errorMessage(err),
              });
            }
          },
        });

        entry.session = coreSession;
        entry.status = 'executing';
        if (entry.onStatusChange) {
          Promise.resolve(entry.onStatusChange('executing')).catch(() => {});
        }
        // Consume the one-shot resume request.
        entry.resumeProviderSessionId = undefined;
        // Persist the provider-side session id durably where the provider exposes it
        // at creation time (Copilot/OpenCode/ACP). Providers that assign it later
        // (e.g. Claude) are captured again at termination.
        this.persistProviderSessionId(task.id, coreSession.sessionId);

        // Timeout guard
        const taskTimeoutMs = resolveTaskTimeoutMs(task);
        const timeoutId = setTimeout(() => {
          if (!this.sessions.has(sessionId)) return;
          const timeoutMsg = `Agent timed out after ${Math.round(taskTimeoutMs / 60000)} minutes`;
          agentLog({
            level: 'warn',
            component: 'agent-manager',
            agentType: entry.agentType,
            sessionId,
            taskId: task.id,
            errorCategory: 'execution_failure',
            message: timeoutMsg,
          });
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'error',
            content: timeoutMsg,
            timestamp: Date.now(),
          });
          const entry2 = this.sessions.get(sessionId);
          if (entry2) {
            entry2.session?.abort().catch(() => {});
            entry2.session?.destroy().catch(() => {});
          }
          terminateOnce('failed', timeoutMsg);
        }, taskTimeoutMs);

        entry.timeoutId = timeoutId;

        const safeDescription = (task.description || '').replace(/[<>]/g, '');
        const prompt = `${safeTitle}\n\n${safeDescription}`;

        let agentAttachments: AgentAttachment[] | undefined;
        if (this.attachmentStore) {
          const taskAttachments = await this.attachmentStore.getByTaskId(task.id);
          if (taskAttachments.length > 0) {
            const loaded: AgentAttachment[] = [];
            for (const a of taskAttachments) {
              const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
              const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
              if (att) loaded.push(att);
            }
            if (loaded.length > 0) agentAttachments = loaded;
          }
        }

        console.log(`[agent-manager] executing ${entry.agentType} for task ${task.id} (session ${sessionId})${agentAttachments?.length ? ` with ${agentAttachments.length} image(s)` : ''}`);
        agentLog({
          level: 'info',
          component: 'agent-manager',
          agentType: entry.agentType,
          sessionId,
          taskId: task.id,
          message: `Agent execution started`,
        });
        const result = await coreSession.execute(prompt, agentAttachments);
        console.log(`[agent-manager] ${entry.agentType} ${result.status} for task ${task.id} (session ${sessionId})${result.error ? `: ${result.error}` : ''}`);
        agentLog({
          level: result.status === 'complete' ? 'info' : 'error',
          component: 'agent-manager',
          agentType: entry.agentType,
          sessionId,
          taskId: task.id,
          errorCategory: result.status === 'complete' ? undefined : 'execution_failure',
          message: `Agent execution ${result.status}${result.error ? `: ${result.error}` : ''}`,
          error: result.error,
        });

        clearTimeout(timeoutId);

        // Keep the terminal session in memory so it stays visible/reattachable and
        // resumable; the `terminated` flag (not session deletion) guards against
        // double-processing after a timeout or stop.
        if (!terminated) {
          if (result.status === 'complete') {
            try {
              const summary = extractTaskSummary(summaryBuffer);
              await this.eventRepo?.update(task.id, { summary });
              const fullOutput = extractFullAgentOutput(resultBuffer);
              if (fullOutput && this.eventRepo) {
                await this.eventRepo.insertEvent({
                  id: uuid(), taskId: task.id, type: 'complete', content: fullOutput,
                  timestamp: Date.now(), metadata: { finalOutput: true },
                });
              }
            } catch (err) {
              agentLog({
                level: 'error',
                component: 'agent-manager',
                agentType: entry.agentType,
                sessionId,
                taskId: task.id,
                errorCategory: 'persist_failure',
                message: `Failed to persist result for task ${task.id}`,
                error: errorMessage(err),
              });
            }
          }
          terminateOnce(result.status, result.error);
          coreSession.destroy().catch(() => {});
        }
      } catch (err: unknown) {
        const message = errorMessage(err);
        const isCliMissing =
          message.includes('ENOENT') ||
          message.includes('not found') ||
          message.includes('spawn');

        const errorContent = isCliMissing
          ? `${provider.displayName} CLI is not installed or not found in PATH.`
          : `Failed to start ${provider.displayName} session: ${message}`;

        agentLog({
          level: 'error',
          component: 'agent-manager',
          agentType: entry.agentType,
          sessionId,
          taskId: task.id,
          errorCategory: isCliMissing ? 'cli_missing' : 'startup_failure',
          message: errorContent,
          error: message,
        });

        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorContent,
          timestamp: Date.now(),
        });

        terminateOnce('failed', errorContent);
      }
    })().catch((err: unknown) => {
      agentLog({
        level: 'error',
        component: 'agent-manager',
        agentType: entry.agentType,
        sessionId,
        taskId: task.id,
        errorCategory: 'unhandled',
        message: `Unhandled error in agent session`,
        error: errorMessage(err),
      });
      terminateOnce('failed');
    });
  }

  /** Stop a running session. */
  async stopSession(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    const duration = Date.now() - entry.startTime;
    const { agentType, taskId } = entry;
    this.sessions.delete(sessionId);
    this.stoppedTasks.add(taskId || sessionId);
    setTimeout(() => this.stoppedTasks.delete(taskId || sessionId), STOPPED_TASK_TTL_MS);
    if (taskId) this.cancelPendingPermissions(taskId);

    // Decrement concurrency counters
    this.providerSessionCounts.set(agentType, Math.max(0, (this.providerSessionCounts.get(agentType) || 1) - 1));
    if (entry.taskId) {
      const task = await this.getTaskForSession(entry);
      if (task?.projectId) {
        this.projectSessionCounts.set(task.projectId, Math.max(0, (this.projectSessionCounts.get(task.projectId) || 1) - 1));
      }
      this.taskToSession.delete(entry.taskId);
    }
    this.sessionToTask.delete(sessionId);

    (async () => {
      try { await entry.session?.abort(); } catch { /* ignore */ }
      try { await entry.session?.destroy(); } catch { /* ignore */ }
    })();

    if (taskId) {
      this.emitEvent(taskId, {
        id: uuid(), taskId, type: 'error',
        content: 'Agent stopped by user.',
        timestamp: Date.now(),
        metadata: { agentType, duration, error: 'Agent stopped by user.' },
      });

      broadcast({
        type: 'agent_complete',
        payload: {
          taskId,
          status: 'failed',
          agentType,
          duration,
          eventCount: (await this.getEvents(taskId)).length,
        },
      });

      for (const [groupId, q] of this.groupQueues) {
        if (q.runningTaskIds.delete(taskId)) {
          q.failedTaskIds.add(taskId);
          Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
            console.error('[group] onChildComplete failed:', err),
          );
          if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) {
            this.groupQueues.delete(groupId);
          } else {
            queueMicrotask(() => this.drainGroupQueue(groupId));
          }
          break;
        }
      }
    }

    return true;
  }

  /** Resume a stopped/complete/failed session. When a provider-side session id was
   *  persisted on the task, this resumes that provider conversation (via the SDK's
   *  resumeSessionId) instead of starting a brand-new one. Without a stored id it
   *  starts a fresh execution — that is a re-run, not a conversation resumption. */
  async resumeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    if (entry.status === 'executing' || entry.status === 'planning') throw new Error(`Session ${sessionId} is already running`);

    // Resume the provider conversation where a durable session id exists.
    const task = entry.taskId ? await this.getTaskForSession(entry) : undefined;
    entry.resumeProviderSessionId = task?.agentSessionId ?? undefined;

    // Reset to idle state for re-execution
    entry.status = 'idle';
    entry.startTime = Date.now();
    entry.completedAt = undefined;

    // Re-start using the same logic
    await this.startSession(sessionId);
  }

  /** Get session info by sessionId. */
  getSession(sessionId: string): AgentSession | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    return {
      id: entry.sessionId,
      taskId: entry.taskId,
      agentType: entry.agentType,
      status: entry.status,
      model: entry.model,
      worktreePath: entry.worktreePath,
      startedAt: entry.startTime,
      completedAt: entry.completedAt,
      createdAt: entry.createdAt,
    };
  }

  /** List all sessions. */
  listSessions(): AgentSession[] {
    return [...this.sessions.values()].map((e) => ({
      id: e.sessionId,
      taskId: e.taskId,
      agentType: e.agentType,
      status: e.status,
      model: e.model,
      worktreePath: e.worktreePath,
      startedAt: e.startTime,
      completedAt: e.completedAt,
      createdAt: e.createdAt,
    }));
  }

  /** Get the session assigned to a task, if any. */
  getSessionForTask(taskId: string): AgentSession | undefined {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return undefined;
    return this.getSession(sessionId);
  }

  /** Check if a session is currently running. */
  isSessionRunning(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    return !!entry && (entry.status === 'executing' || entry.status === 'planning');
  }

  /** Check if a task has a running session. */
  isTaskRunning(taskId: string): boolean {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return false;
    return this.isSessionRunning(sessionId);
  }

  /** Enforce concurrency limits before starting a new session. */
  private enforceConcurrencyLimits(projectId?: string): void {
    const limits = this.concurrencyLimits;

    // Global limit
    if (limits.global !== undefined) {
      const totalRunning = [...this.sessions.values()].filter(s => s.status === 'executing' || s.status === 'planning').length;
      if (totalRunning >= limits.global) {
        throw new Error(`Global concurrency limit (${limits.global}) reached`);
      }
    }

    // Per-provider limit
    // Note: this checks the provider of the session about to start, which we don't know yet
    // at this point. The caller should pass the agentType. For now, check all providers.
    for (const [agentType, count] of this.providerSessionCounts) {
      const limit = limits.perProvider?.[agentType];
      if (limit !== undefined && count >= limit) {
        throw new Error(`Concurrency limit (${limit}) reached for provider ${agentType}`);
      }
    }

    // Per-project limit — use the maintained running-session counter (incremented on
    // start, decremented on terminal/stop) so retained terminal sessions are not counted.
    if (projectId && limits.perProject) {
      const limit = limits.perProject[projectId];
      if (limit !== undefined) {
        const projectCount = this.projectSessionCounts.get(projectId) ?? 0;
        if (projectCount >= limit) {
          throw new Error(`Concurrency limit (${limit}) reached for project ${projectId}`);
        }
      }
    }
  }

  /** Get the Task object for a session's taskId. */
  private async getTaskForSession(entry: ManagedSession): Promise<Task | undefined> {
    if (!entry.taskId || !this.eventRepo) return undefined;
    // The eventRepo is a TaskRepository, so we can get the task
    return this.eventRepo.getById(entry.taskId);
  }

  /** Durably store the provider-side session/conversation id on the task so the
   *  session can be identified after completion/restart and resumed where supported. */
  private persistProviderSessionId(taskId: string, providerSessionId: string | null | undefined): void {
    if (!providerSessionId || !this.eventRepo) return;
    void this.eventRepo.update(taskId, { agentSessionId: providerSessionId }).catch((err) => {
      agentLog({
        level: 'error',
        component: 'agent-manager',
        taskId,
        errorCategory: 'persist_failure',
        message: `Failed to persist provider session id for task ${taskId}`,
        error: errorMessage(err),
      });
    });
  }

  // ─── Interactive permission control (Stage C) ─────────────────────

  /** Raise an interactive permission request to the Board and await the user's
   *  decision. Emits a persisted `permission_request` event; resolves when the user
   *  responds, or with 'expired'/'cancelled' on timeout/stop. Never auto-approves. */
  requestPermission(taskId: string, sessionId: string, kind: string, tool?: string): Promise<'approved' | 'denied' | 'expired' | 'cancelled'> {
    const requestId = `perm-${uuid()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settlePermission(requestId, 'expired'), PERMISSION_REQUEST_TTL_MS);
      this.pendingPermissions.set(requestId, { requestId, taskId, sessionId, kind, tool, createdAt: Date.now(), resolve, timer });
      this.emitEvent(taskId, {
        id: uuid(), taskId, type: 'permission_request',
        content: `Agent requests permission: ${tool || kind}`,
        timestamp: Date.now(),
        metadata: { permissionRequestId: requestId, permissionKind: kind, permissionTool: tool },
      });
    });
  }

  /** Resolve a pending permission request with the user's decision. Returns false if
   *  the request is unknown, belongs to a different task, or was already settled. */
  respondToPermission(taskId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.taskId !== taskId) return false;
    this.settlePermission(requestId, approved ? 'approved' : 'denied');
    return true;
  }

  private settlePermission(requestId: string, decision: 'approved' | 'denied' | 'expired' | 'cancelled'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return; // already settled — never reuse a stale approval
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);
    this.emitEvent(pending.taskId, {
      id: uuid(), taskId: pending.taskId, type: 'permission_request',
      content: `Permission ${decision}: ${pending.tool || pending.kind}`,
      timestamp: Date.now(),
      metadata: { permissionRequestId: requestId, permissionKind: pending.kind, permissionTool: pending.tool, permissionDecision: decision },
    });
    pending.resolve(decision);
  }

  /** Cancel all pending permission requests for a task (on stop/destroy). */
  cancelPendingPermissions(taskId: string): void {
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.taskId === taskId) this.settlePermission(requestId, 'cancelled');
    }
  }

  /** Pending permission requests for a task (for UI reattachment). */
  getPendingPermissions(taskId: string): Array<{ requestId: string; kind: string; tool?: string; createdAt: number }> {
    return [...this.pendingPermissions.values()]
      .filter((p) => p.taskId === taskId)
      .map(({ requestId, kind, tool, createdAt }) => ({ requestId, kind, tool, createdAt }));
  }

  // ─── Event Management (moved from copilot.ts) ─────────────────────

  private emitEvent(taskId: string, event: AgentEvent): void {
    if (this.deletedTasks.has(taskId)) return;
    // Drop empty content events — nothing to show
    if (!event.content?.trim() && event.type !== 'complete' && event.type !== 'error') return;

    let log = this.eventLogs.get(taskId) || [];
    log.push(event);
    if (log.length > MAX_EVENTS_PER_TASK) {
      log = log.slice(-MAX_EVENTS_PER_TASK);
    }
    // LRU touch
    this.eventLogs.delete(taskId);
    this.eventLogs.set(taskId, log);
    if (this.eventLogs.size > MAX_EVENT_LOG_TASKS) {
      const oldest = this.eventLogs.keys().next().value;
      if (oldest) this.eventLogs.delete(oldest);
    }
    // Write-through to database
    if (this.eventRepo) {
      this.eventRepo.insertEvent(event).catch((err: unknown) => {
        console.error(`[agent-manager] failed to persist event: ${errorMessage(err)}`);
      });
    }
    const STREAMABLE = new Set(['output', 'thinking']);

    // Events without a task ID (e.g., audit events) bypass stream buffering
    const tid = event.taskId;
    if (!tid) {
      broadcast({ type: 'agent_event', payload: event });
      return;
    }

    const flushBuffer = (taskId: string) => {
      const buf = this.streamBuffer.get(taskId);
      if (buf) {
        clearTimeout(buf.timer);
        broadcast({ type: 'agent_event', payload: buf.event });
        this.streamBuffer.delete(taskId);
      }
    };

    if (STREAMABLE.has(event.type)) {
      const existing = this.streamBuffer.get(tid);
      if (existing && existing.event.type === event.type) {
        // Same type — merge content and reset timer
        clearTimeout(existing.timer);
        existing.event.content += event.content;
        existing.timer = setTimeout(() => flushBuffer(tid), STREAM_BUFFER_FLUSH_MS);
      } else {
        // Different type or no buffer — flush existing, start new buffer
        if (existing) flushBuffer(tid);
        const timer = setTimeout(() => flushBuffer(tid), STREAM_BUFFER_FLUSH_MS);
        this.streamBuffer.set(tid, { event: { ...event }, timer });
      }
    } else {
      // Non-streamable: flush pending buffer first, then broadcast immediately
      flushBuffer(tid);
      broadcast({ type: 'agent_event', payload: event });
    }
  }

  async getEvents(taskId: string): Promise<AgentEvent[]> {
    // Prefer DB (complete, ordered) over in-memory (capped, may be partial)
    if (this.eventRepo) {
      const dbEvents = await this.eventRepo.getEventsByTaskId(taskId);
      if (dbEvents.length > 0) return dbEvents;
    }
    // Fall back to in-memory (task still running, not yet persisted)
    const memEvents = this.eventLogs.get(taskId);
    if (memEvents && memEvents.length > 0) {
      this.eventLogs.delete(taskId);
      this.eventLogs.set(taskId, memEvents);
      return [...memEvents];
    }
    return [];
  }

  clearEvents(taskId: string): void {
    this.deletedTasks.add(taskId);
    setTimeout(() => this.deletedTasks.delete(taskId), DELETED_TASK_TTL_MS);
    this.resetEvents(taskId);
  }

  /** Clear stored events for a task without suppressing future events (used on re-run) */
  resetEvents(taskId: string): void {
    this.eventLogs.delete(taskId);
    if (this.eventRepo) {
      this.eventRepo.deleteEventsByTaskId(taskId).catch((err: unknown) => {
        console.error(`[agent-manager] failed to delete persisted events: ${errorMessage(err)}`);
      });
    }
  }

  // ─── Worktree Management (moved from copilot.ts) ──────────────────

  // Returns true when `worktreePath` is registered with git as a worktree
  // checked out on `branchName`. Used to safely reuse a worktree left over
  // from a prior (e.g. failed) run instead of colliding on the branch.
  private worktreeRegisteredForBranch(repoPath: string, worktreePath: string, branchName: string): boolean {
    try {
      const out = gitExecFileSync(['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        stdio: 'pipe',
      }).toString();
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const target = norm(worktreePath);
      for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const wtLine = lines.find((l) => l.startsWith('worktree '));
        if (!wtLine) continue;
        if (norm(wtLine.slice('worktree '.length)) !== target) continue;
        return lines.includes(`branch refs/heads/${branchName}`);
      }
    } catch {
      /* fall through — treat as not reusable */
    }
    return false;
  }

  setupWorktree(task: Task): string | undefined {
    if (!task.useWorktree) return undefined;
    if (!task.repoPath) throw new Error('Worktree tasks require repoPath');
    if (!task.branchName) throw new Error('Worktree tasks require branchName');

    // Reuse a valid worktree left over from a prior run (e.g. after a failed
    // attempt). Without this, a restart would mint a new temp dir and fail with
    // "branch already used by worktree", since the old worktree still holds the
    // branch — and any in-progress work in it would be stranded.
    if (
      task.worktreePath &&
      path.resolve(task.worktreePath) !== path.resolve(task.repoPath) &&
      fs.existsSync(task.worktreePath) &&
      this.worktreeRegisteredForBranch(task.repoPath, task.worktreePath, task.branchName)
    ) {
      console.log(`[worktree] reusing existing ${task.worktreePath}`);
      return task.worktreePath;
    }

    // Clear stale worktree records (e.g. dirs deleted out from under git) so a
    // fresh add for this branch isn't blocked by a dangling registration.
    try {
      gitExecFileSync(['worktree', 'prune'], { cwd: task.repoPath, stdio: 'pipe' });
    } catch {
      /* best effort */
    }

    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), `agentboard-${task.id}-`));
    const baseBranch = task.baseBranch || 'main';

    try {
      gitExecFileSync(
        ['worktree', 'add', '-b', task.branchName, worktreePath, baseBranch],
        { cwd: task.repoPath, stdio: 'pipe' },
      );
      console.log(`[worktree] created at ${worktreePath} from ${baseBranch}`);
      return worktreePath;
    } catch {
      try {
        gitExecFileSync(
          ['worktree', 'add', worktreePath, task.branchName],
          { cwd: task.repoPath, stdio: 'pipe' },
        );
        console.log(`[worktree] attached existing branch ${task.branchName} at ${worktreePath}`);
        return worktreePath;
      } catch (err2: unknown) {
        console.error(`[worktree] failed:`, errorMessage(err2));
        if (!this.worktreeRegisteredForBranch(task.repoPath, worktreePath, task.branchName)) {
          try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        throw new Error(`Failed to create worktree: ${errorMessage(err2)}`);
      }
    }
  }

  inspectWorktree(task: Task): WorktreeCleanupInspection {
    return inspectTaskWorktree(task);
  }

  removeWorktree(task: Task): WorktreeCleanupResult {
    const result = cleanupTaskWorktree(task);
    if (result.status === 'removed') {
      console.log(`[worktree] removed ${task.worktreePath}; branch ${task.branchName} retained`);
    } else if (result.status === 'blocked') {
      console.warn(`[worktree] retained ${task.worktreePath}: ${result.reason}`);
    }
    return result;
  }

  createPR(task: Task): { url: string } {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const baseBranch = task.baseBranch || 'main';
    const cwd = task.worktreePath || task.repoPath;

    // Check that a remote named 'origin' exists
    try {
      const remoteUrl = gitExecFileSync(['remote', 'get-url', 'origin'], { cwd, stdio: 'pipe' }).toString().trim();
      if (!remoteUrl) throw new Error('empty');
    } catch {
      throw new Error(
        'No git remote "origin" configured. Push your repo to GitHub first:\n' +
        `  cd ${task.repoPath}\n` +
        '  gh repo create <name> --source=. --push'
      );
    }

    try {
      gitExecFileSync(['push', '-u', 'origin', task.branchName], { cwd, stdio: 'pipe' });
      const prTitle = task.title.replace(/[<>]/g, '').slice(0, 200);
      const result = execFileSync(
        'gh',
        ['pr', 'create', '--base', baseBranch, '--head', task.branchName,
         '--title', prTitle, '--body', `Automated PR from Kanban task ${task.id}`, '--'],
        { cwd, stdio: 'pipe' },
      );
      const url = result.toString().trim();
      console.log(`[pr] created: ${url}`);
      return { url };
    } catch (err: unknown) {
      const stderr = getErrorStderr(err);
      const msg = stderr || errorMessage(err);
      console.error(`[pr] creation failed:`, msg);
      throw new Error(`PR creation failed: ${msg.trim()}`);
    }
  }

  private async withRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoPath) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.repoLocks.set(repoPath, lock);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
      if (this.repoLocks.get(repoPath) === lock) this.repoLocks.delete(repoPath);
    }
  }

  async mergeLocal(task: Task): Promise<{ merged: true; baseBranch: string }> {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const repoPath = task.repoPath;
    const branchName = task.branchName;
    const baseBranch = task.baseBranch || 'main';

    return this.withRepoLock(repoPath, () => {
      try {
        gitExecFileSync(['checkout', baseBranch], { cwd: repoPath, stdio: 'pipe' });
        gitExecFileSync(['merge', branchName, '--no-edit'], { cwd: repoPath, stdio: 'pipe' });
        console.log(`[merge] merged ${branchName} into ${baseBranch}`);
        return { merged: true as const, baseBranch };
      } catch (err: unknown) {
        try { gitExecFileSync(['merge', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch { /* already clean */ }
        const stderr = getErrorStderr(err);
        const msg = stderr || errorMessage(err);
        console.error(`[merge] failed:`, msg);
        throw new Error(`Merge failed (conflicts?). Branch ${branchName} was not merged:\n${msg.trim()}`);
      }
    });
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────

  startAgent(
    task: Task,
    onStatusChange: (status: Task['agentStatus']) => void | Promise<void>,
    onWorktreeCreated?: (worktreePath: string) => void | Promise<void>,
  ): void {
    // Get or create a session for this task
    let sessionId = this.taskToSession.get(task.id);
    if (!sessionId) {
      sessionId = this.createSession(task.agentType || 'copilot', task.id);
    }

    // Attach the task-level callbacks to the session so the execution lifecycle
    // persists status/worktree and drives group-queue draining. (Previously these
    // were only invoked on startup failure, so terminal status was never persisted
    // and group queues never drained.)
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.onStatusChange = onStatusChange;
      entry.onWorktreeCreated = onWorktreeCreated;
    }

    // Start the session (fire-and-forget, same as before)
    this.startSession(sessionId).catch((err: unknown) => {
      console.error(`[agent-manager] failed to start session ${sessionId} for task ${task.id}:`, err);
      void onStatusChange('failed');
    });
  }

  async sendMessage(taskId: string, message: string, attachmentIds?: string[]): Promise<boolean> {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return false;
    const entry = this.sessions.get(sessionId);
    if (!entry?.session) return false;

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'command',
      content: `Follow-up message sent: ${message}${attachmentIds?.length ? ` (with ${attachmentIds.length} image(s))` : ''}`,
      timestamp: Date.now(),
    });

    // Load attachments if IDs provided
    let agentAttachments: AgentAttachment[] | undefined;
    if (attachmentIds?.length && this.attachmentStore) {
      const loaded: AgentAttachment[] = [];
      for (const id of attachmentIds) {
        const a = await this.attachmentStore.getById(id);
        if (!a) continue;
        const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
        const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
        if (att) loaded.push(att);
      }
      if (loaded.length > 0) agentAttachments = loaded;
    }

    try {
      await entry.session.send(message, agentAttachments);
    } catch (err: unknown) {
      const providerName = this.providers.get(entry.agentType)?.displayName || entry.agentType;
      throw new Error(`${providerName} failed to process follow-up: ${errorMessage(err)}`);
    }
    return true;
  }

  async stopAgent(taskId: string): Promise<boolean> {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return false;
    return this.stopSession(sessionId);
  }

  /** Stop a session by sessionId. */
  async stopSessionById(sessionId: string): Promise<boolean> {
    return this.stopSession(sessionId);
  }

  isRunning(taskId: string): boolean {
    const sessionId = this.taskToSession.get(taskId);
    if (!sessionId) return false;
    return this.isSessionRunning(sessionId);
  }

  /** Check if a session is running by sessionId. */
  isSessionRunningById(sessionId: string): boolean {
    return this.isSessionRunning(sessionId);
  }

  /** Shut down all sessions and providers. */
  shutdownAll(): void {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.taskToSession.clear();
    this.sessionToTask.clear();

    for (const entry of entries) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      (async () => {
        try { await entry.session?.abort(); } catch { /* ignore */ }
        try { await entry.session?.destroy(); } catch { /* ignore */ }
      })();
    }

    for (const provider of this.providers.values()) {
      provider.stop().catch(() => {});
    }
  }

  // ─── Group Queue ──────────────────────────────────────────────────

  isGroupRunning(groupId: string): boolean {
    return this.groupQueues.has(groupId);
  }

  startGroup(
    group: TaskGroup,
    children: Task[],
    makeStatusCb: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>,
    makeWorktreeCb: (task: Task) => (worktreePath: string) => void | Promise<void>,
    onChildComplete: (taskId: string) => void | Promise<void>,
  ): void {
    if (this.groupQueues.has(group.id)) return;

    const queue: GroupQueue = {
      groupId: group.id,
      maxConcurrency: group.maxConcurrency,
      pendingTaskIds: children.map((c) => c.id),
      runningTaskIds: new Set(),
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      tasks: new Map(children.map((c) => [c.id, c])),
      makeStatusCallback: makeStatusCb,
      makeWorktreeCallback: makeWorktreeCb,
      onChildComplete,
    };

    this.groupQueues.set(group.id, queue);
    this.drainGroupQueue(group.id);
  }

  private drainGroupQueue(groupId: string): void {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Use queueMicrotask to avoid reentrancy issues when startAgent
    // synchronously calls onStatusChange('failed') for unavailable agents
    const startNext = () => {
      const q = this.groupQueues.get(groupId);
      if (!q) return;
      if (q.runningTaskIds.size >= q.maxConcurrency || q.pendingTaskIds.length === 0) return;

      const taskId = q.pendingTaskIds.shift()!;
      const task = q.tasks.get(taskId);
      if (!task) { startNext(); return; }

      q.runningTaskIds.add(taskId);

      const originalStatusCb = q.makeStatusCallback(task);
      const wrappedStatusCb = async (status: Task['agentStatus']) => {
        // Await status persistence so DB is consistent before completion check
        await originalStatusCb(status);

        if (status === 'complete' || status === 'failed') {
          q.runningTaskIds.delete(taskId);
          if (status === 'complete') {
            q.completedTaskIds.add(taskId);
          } else {
            q.failedTaskIds.add(taskId);
          }

          // Notify completion (catch to prevent unhandled rejection crash)
          Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
            console.error('[group] onChildComplete failed:', err),
          );

          // Clean up queue when fully drained
          if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) {
            this.groupQueues.delete(groupId);
          } else {
            queueMicrotask(() => this.drainGroupQueue(groupId));
          }
        }
      };

      this.startAgent(task, wrappedStatusCb, q.makeWorktreeCallback(task));

      // Start more if we haven't hit concurrency limit
      startNext();
    };

    startNext();
  }

  async stopGroup(groupId: string): Promise<void> {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Clear pending
    queue.pendingTaskIds.length = 0;

    // Stop running children
    const running = [...queue.runningTaskIds];
    for (const taskId of running) {
      await this.stopAgent(taskId);
    }

    this.groupQueues.delete(groupId);
  }
}

