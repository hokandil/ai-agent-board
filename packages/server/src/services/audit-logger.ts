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
      previousValues: params.previousValues,
      newValues: params.newValues,
      metadata: params.metadata,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    };

    await this.repo.insertEvent({
      id: entry.id,
      taskId: params.resourceId,
      type: 'audit_log',
      content: JSON.stringify(entry),
      timestamp: entry.timestamp,
      metadata: {
      },
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
}
