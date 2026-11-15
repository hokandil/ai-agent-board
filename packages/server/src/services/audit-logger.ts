import { v4 as uuid } from 'uuid';
import type { TaskRepository } from '../repositories/types.js';

export type AuditAction =
  | 'task.create'
  | 'task.update'
  | 'task.move'
  | 'task.delete'
  | 'task.approve'
  | 'task.reject'
  | 'task.start'
  | 'task.stop'
  | 'task.resume'
  | 'task.execution_complete'
  | 'task.execution_failed'
  | 'task.execution_timeout'
  | 'agent.session_create'
  | 'agent.session_start'
  | 'agent.session_stop'
  | 'agent.session_resume'
  | 'agent.session_complete'
  | 'agent.session_failed'
  | 'mcp.server.connect'
  | 'mcp.server.disconnect'
  | 'mcp.tool.call'
  | 'mcp.sync.create'
  | 'mcp.sync.update'
  | 'mcp.sync.run'
  | 'mcp.sync.import'
  | 'mcp.sync.export'
  | 'mcp.sync.conflict.resolve'
  | 'mcp.sync.conflict.ignore'
  | 'git.worktree.create'
  | 'git.worktree.remove'
  | 'git.merge'
  | 'git.pr.create'
  | 'user.login'
  | 'user.logout'
  | 'permission.denied';

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  actorId?: string;
  actorType: 'user' | 'agent' | 'system' | 'mcp_server';
  action: AuditAction;
  resourceType: 'task' | 'session' | 'mcp_server' | 'sync_connection' | 'worktree' | 'approval';
  resourceId: string;
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** Keys that indicate sensitive values and should be redacted from audit logs. */
const SENSITIVE_KEYS = new Set([
  'apiKey', 'apikey', 'api_key',
  'token', 'access_token', 'refresh_token', 'id_token',
  'password', 'passwd', 'secret', 'private_key', 'client_secret',
  'authorization', 'auth', 'credential', 'credentials',
  'session', 'session_id', 'sessionId',
  'github_token', 'gh_token', 'pat',
]);

/** Redact sensitive values from a record, replacing them with '[REDACTED]'. */
export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Redact strings that look like tokens/keys (long hex/base64 strings)
    if (typeof value === 'string' && value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return '[REDACTED]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactSensitive(val);
      }
    }
    return result;
  }
  return value;
}

export class AuditLogger {
  private repo: TaskRepository;

  constructor(repo: TaskRepository) {
    this.repo = repo;
  }

  async log(params: {
    actorId?: string;
    actorType: AuditLogEntry['actorType'];
    action: AuditAction;
    resourceType: AuditLogEntry['resourceType'];
    resourceId: string;
    previousValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: `audit-${uuid()}`,
      timestamp: Date.now(),
      actorId: params.actorId,
      actorType: params.actorType,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      previousValues: params.previousValues ? (redactSensitive(params.previousValues) as Record<string, unknown>) : undefined,
      newValues: params.newValues ? (redactSensitive(params.newValues) as Record<string, unknown>) : undefined,
      metadata: params.metadata ? (redactSensitive(params.metadata) as Record<string, unknown>) : undefined,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    };

    await this.repo.insertEvent({
      id: entry.id,
      taskId: entry.resourceType === 'task' ? params.resourceId : undefined,
      type: 'audit_log',
      content: JSON.stringify(entry),
      timestamp: entry.timestamp,
      metadata: {},
    });
  }

  async logTaskChange(
    taskId: string,
    action: AuditAction,
    actorId?: string,
    previousValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
    actorType: AuditLogEntry['actorType'] = 'user',
  ): Promise<void> {
    await this.log({
      actorId,
      actorType,
      action,
      resourceType: 'task',
      resourceId: taskId,
      previousValues,
      newValues,
    });
  }

  async logSessionEvent(
    sessionId: string,
    action: AuditAction,
    actorId?: string,
    actorType: AuditLogEntry['actorType'] = 'agent',
    previousValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
  ): Promise<void> {
    await this.log({
      actorId,
      actorType,
      action,
      resourceType: 'session',
      resourceId: sessionId,
      previousValues,
      newValues,
    });
  }

  async logMcpEvent(
    serverId: string,
    action: AuditAction,
    actorId?: string,
    previousValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
  ): Promise<void> {
    await this.log({
      actorId,
      actorType: 'mcp_server',
      action,
      resourceType: 'mcp_server',
      resourceId: serverId,
      previousValues,
      newValues,
    });
  }

  async logSyncEvent(
    connectionId: string,
    action: AuditAction,
    actorId?: string,
    previousValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
  ): Promise<void> {
    await this.log({
      actorId,
      actorType: 'system',
      action,
      resourceType: 'sync_connection',
      resourceId: connectionId,
      previousValues,
      newValues,
    });
  }

  async logAccessDenied(
    actorId: string,
    actorType: AuditLogEntry['actorType'],
    action: AuditAction,
    resourceType: AuditLogEntry['resourceType'],
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await this.log({
      actorId,
      actorType,
      action,
      resourceType,
      resourceId,
      previousValues: { reason },
      newValues: { denied: true },
    });
  }

  async getAuditLog(taskId: string, limit = 50): Promise<any[]> {
    const events = await this.repo.getEventsByTaskId(taskId);
    return events
      .filter((e) => e.type === 'audit_log')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((e) => {
        try {
          return JSON.parse(e.content);
        } catch {
          return { id: e.id, content: e.content, timestamp: e.timestamp };
        }
      });
  }

  async getAllAuditLog(_limit = 100): Promise<any[]> {
    // The repository interface only supports per-task event queries.
    // A production deployment may add a dedicated audit table for global queries.
    // Return empty; callers should use per-task getAuditLog.
    return [];
  }
}
