import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent, TaskRelationship, ExecutionAttempt, MCPTool } from '../types.js';
import type { TaskRepository, ContinuationEligibility } from './types.js';
import type { MCPServerRecord, MCPToolRecord, MCPPermissionRecord, MCPRepository } from './mcp-types.js';
import type { SyncConnectionRecord, SyncFieldMapping, SyncConflict, SyncState, SyncRepository } from './mcp-sync-types.js';
import { errorMessage } from '../utils.js';
import { credentialService } from '../services/credential-service.js';
import type { AgentProfile } from '@ai-agent-board/shared/types.js';

interface AgentProfileRow {
  id: string; name: string; provider: string; model: string | null;
  instructions: string | null; command: string | null; mcp_server_ids: string | null;
  skill_ids: string | null; enabled: number;
  created_at: number; updated_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  column_id: ColumnId;
  agent_status: AgentStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  worktree_path: string | null;
  agent_type: AgentType;
  archived: number;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: number | null; run_claimed_at: number | null;
  timeout_minutes: number | null;
  agent_session_id: string | null;
  agent_profile_id: string | null;
  agent_profile_snapshot: string | null;
}

interface AgentProfileRow {
  id: string; name: string; provider: string; model: string | null;
  instructions: string | null; command: string | null; mcp_server_ids: string | null;
  skill_ids: string | null; enabled: number;
  created_at: number; updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    columnId: row.column_id,
    agentStatus: row.agent_status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree != null ? Boolean(row.use_worktree) : undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type,
    archived: Boolean(row.archived),
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null,
    externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at ?? undefined, runClaimedAt: row.run_claimed_at ?? undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
    agentSessionId: row.agent_session_id ?? undefined,
    agentProfileId: row.agent_profile_id ?? undefined,
    agentProfileSnapshot: row.agent_profile_snapshot ? JSON.parse(row.agent_profile_snapshot) : undefined,
  };
}

interface AttemptRow {
  id: string; task_id: string; external_source: string; external_key: string;
  title_snapshot: string; description_snapshot: string; agent_type: AgentType;
  related_task_id: string | null; auto_start: number; timeout_minutes: number | null;
  request_snapshot: string;
  status: ExecutionAttempt['status']; created_at: number;
}

function rowToAttempt(row: AttemptRow): ExecutionAttempt {
  return { id: row.id, taskId: row.task_id, externalSource: row.external_source, externalKey: row.external_key,
    titleSnapshot: row.title_snapshot, descriptionSnapshot: row.description_snapshot, agentType: row.agent_type,
    relatedTaskId: row.related_task_id ?? undefined, autoStart: Boolean(row.auto_start),
    timeoutMinutes: row.timeout_minutes ?? undefined, requestSnapshot: row.request_snapshot,
    status: row.status, createdAt: row.created_at };
}

export class SqliteTaskRepository implements TaskRepository, MCPRepository, SyncRepository {
  private db: Database.Database;
  private stmts: {
    getAll: Database.Statement;
    getAllIncludingArchived: Database.Statement;
    getArchived: Database.Statement;
    getById: Database.Statement;
    insert: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    count: Database.Statement;
    insertEvent: Database.Statement;
    getEventsByTaskId: Database.Statement;
    deleteEventsByTaskId: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getAll: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 0 AND group_id IS NULL ORDER BY created_at ASC'),
      getAllIncludingArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND group_id IS NULL ORDER BY created_at ASC'),
      getArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 1 ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      insert: db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at, started_at, completed_at,
          repo_path, branch_name, base_branch, use_worktree, worktree_path, archived, group_id, group_order, summary, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes, agent_session_id, agent_profile_id, agent_profile_snapshot)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @agent_status, @agent_type, @created_at, @started_at, @completed_at,
          @repo_path, @branch_name, @base_branch, @use_worktree, @worktree_path, @archived, @group_id, @group_order, @summary, @external_source, @external_key, @provenance, @run_requested_at, @run_claimed_at, @timeout_minutes, @agent_session_id, @agent_profile_id, @agent_profile_snapshot)
      `),
      update: db.prepare(`
        UPDATE tasks SET
          title = @title,
          description = @description,
          priority = @priority,
          column_id = @column_id,
          agent_status = @agent_status,
          agent_type = @agent_type,
          started_at = @started_at,
          completed_at = @completed_at,
          repo_path = @repo_path,
          branch_name = @branch_name,
          base_branch = @base_branch,
          use_worktree = @use_worktree,
          worktree_path = @worktree_path,
          archived = @archived,
          summary = @summary, run_requested_at = @run_requested_at, run_claimed_at = @run_claimed_at,
          timeout_minutes = @timeout_minutes, agent_session_id = @agent_session_id,
          agent_profile_id = @agent_profile_id, agent_profile_snapshot = @agent_profile_snapshot
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) as cnt FROM tasks'),
      insertEvent: db.prepare(`
        INSERT INTO events (id, task_id, type, content, timestamp, metadata)
        VALUES (@id, @task_id, @type, @content, @timestamp, @metadata)
      `),
      getEventsByTaskId: db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC, rowid ASC'),
      deleteEventsByTaskId: db.prepare('DELETE FROM events WHERE task_id = ?'),
    };
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const stmt = includeArchived ? this.stmts.getAllIncludingArchived : this.stmts.getAll;
    return (stmt.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const row = this.stmts.getById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE external_source = ? AND external_key = ?').get(source, key) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async resolve(reference: string, projectId: string): Promise<Task[]> {
    const needle = reference.trim();
    const exact = this.stmts.getById.get(needle) as TaskRow | undefined;
    if (exact) return exact.project_id === projectId ? [rowToTask(exact)] : [];
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND lower(title) = lower(?) ORDER BY created_at, id').all(projectId, needle) as TaskRow[]).map(rowToTask);
  }

  async create(task: Task): Promise<Task> {
    this.insertTask(task);
    return task;
  }

  private insertTask(task: Task): void {
    this.stmts.insert.run({
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      column_id: task.columnId,
      agent_status: task.agentStatus,
      agent_type: task.agentType ?? 'copilot',
      created_at: task.createdAt,
      started_at: task.startedAt ?? null,
      completed_at: task.completedAt ?? null,
      repo_path: task.repoPath ?? null,
      branch_name: task.branchName ?? null,
      base_branch: task.baseBranch ?? null,
      use_worktree: task.useWorktree != null ? (task.useWorktree ? 1 : 0) : null,
      worktree_path: task.worktreePath ?? null,
      archived: task.archived ? 1 : 0,
      group_id: task.groupId ?? null,
      group_order: task.groupOrder ?? null,
      summary: task.summary ?? null, external_source: task.externalSource ?? null, external_key: task.externalKey ?? null,
      provenance: task.provenance ? JSON.stringify(task.provenance) : null, run_requested_at: task.runRequestedAt ?? null, run_claimed_at: task.runClaimedAt ?? null,
      timeout_minutes: task.timeoutMinutes ?? null,
      agent_session_id: task.agentSessionId ?? null,
      agent_profile_id: task.agentProfileId ?? null,
      agent_profile_snapshot: task.agentProfileSnapshot ? JSON.stringify(task.agentProfileSnapshot) : null,
    });
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return { task, created: true }; } catch (err) {
      if (task.externalSource && task.externalKey && err instanceof Error && err.message.includes('UNIQUE')) {
        const existing = await this.getByExternalIdentity(task.externalSource, task.externalKey); if (existing) return { task: existing, created: false };
      } throw err;
    }
  }
  async requestRun(id: string, at: number) { this.db.prepare('UPDATE tasks SET run_requested_at=?, run_claimed_at=NULL WHERE id=?').run(at,id); return this.getById(id); }
  async claimRun(id: string, at: number) { const staleBefore=at-30_000; const r=this.db.prepare("UPDATE tasks SET run_claimed_at=? WHERE id=? AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning')").run(at,id,staleBefore); return r.changes ? this.getById(id) : undefined; }
  async clearRun(id: string) { this.db.prepare('UPDATE tasks SET run_requested_at=NULL, run_claimed_at=NULL WHERE id=?').run(id); return this.getById(id); }
  async getPendingRuns(staleBefore = Date.now()-30_000) { return (this.db.prepare("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning') ORDER BY run_requested_at").all(staleBefore) as TaskRow[]).map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    return this.db.transaction(() => {
      const row = this.stmts.getById.get(id) as TaskRow | undefined;
      const existing = row ? rowToTask(row) : undefined;
      if (!existing) return undefined;
      return this.updateExisting(existing, updates);
    })();
  }

  private updateExisting(existing: Task, updates: Partial<Task>): Task {
      const merged = { ...existing, ...updates };
      this.stmts.update.run({
        id: existing.id,
        title: merged.title,
        description: merged.description,
        priority: merged.priority,
        column_id: merged.columnId,
        agent_status: merged.agentStatus,
        agent_type: merged.agentType,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        repo_path: merged.repoPath ?? null,
        branch_name: merged.branchName ?? null,
        base_branch: merged.baseBranch ?? null,
        use_worktree: merged.useWorktree != null ? (merged.useWorktree ? 1 : 0) : null,
        worktree_path: merged.worktreePath ?? null,
        archived: merged.archived ? 1 : 0,
        summary: merged.summary ?? null, run_requested_at: merged.runRequestedAt ?? null, run_claimed_at: merged.runClaimedAt ?? null,
        timeout_minutes: merged.timeoutMinutes ?? null,
        agent_session_id: merged.agentSessionId ?? null,
        agent_profile_id: merged.agentProfileId ?? null,
        agent_profile_snapshot: merged.agentProfileSnapshot ? JSON.stringify(merged.agentProfileSnapshot) : null,
      });
      return merged;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = this.stmts.count.get() as { cnt: number };
    return row.cnt;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.stmts.insertEvent.run({
      id: event.id,
      task_id: event.taskId,
      type: event.type,
      content: event.content,
      timestamp: event.timestamp,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const rows = this.stmts.getEventsByTaskId.all(taskId) as Array<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: number;
      metadata: string | null;
    }>;
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[sqlite] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: row.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.stmts.deleteEventsByTaskId.run(taskId);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    return (this.stmts.getArchived.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getRelationships(taskId: string): Promise<TaskRelationship[]> {
    const rows = this.db.prepare(`SELECT task_id, related_task_id, type, created_at FROM task_relationships
      WHERE task_id = ? OR related_task_id = ? ORDER BY created_at, task_id, related_task_id`).all(taskId, taskId) as Array<{ task_id: string; related_task_id: string; type: 'related'; created_at: number }>;
    return rows.map((row) => ({ taskId, relatedTaskId: row.task_id === taskId ? row.related_task_id : row.task_id, type: row.type, createdAt: row.created_at }));
  }

  async createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_relationships (task_id, related_task_id, type, created_at)
      SELECT ?, ?, 'related', ? FROM tasks a JOIN tasks b ON b.id = ? WHERE a.id = ? AND a.project_id = b.project_id`).run(left, right, createdAt, right, left);
    const row = this.db.prepare('SELECT created_at FROM task_relationships WHERE task_id = ? AND related_task_id = ?').get(left, right) as { created_at: number } | undefined;
    if (!row) throw new Error('tasks must exist in the same project');
    return { relationship: { taskId, relatedTaskId, type: 'related', createdAt: row.created_at }, created: result.changes > 0 };
  }

  async deleteRelationship(taskId: string, relatedTaskId: string): Promise<boolean> {
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    return this.db.prepare('DELETE FROM task_relationships WHERE task_id = ? AND related_task_id = ?').run(left, right).changes > 0;
  }

  async getAttemptById(id: string): Promise<ExecutionAttempt | undefined> {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE id=?').get(id) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  async getAttemptByExternalIdentity(source: string, key: string): Promise<ExecutionAttempt | undefined> {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?').get(source, key) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  async getAttemptsByTaskId(taskId: string): Promise<ExecutionAttempt[]> {
    return (this.db.prepare('SELECT * FROM execution_attempts WHERE task_id=? ORDER BY created_at,id').all(taskId) as AttemptRow[]).map(rowToAttempt);
  }

  async createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }> {
    const result = this.db.prepare(`INSERT OR IGNORE INTO execution_attempts
      (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(attempt.id, attempt.taskId, attempt.externalSource, attempt.externalKey,
        attempt.titleSnapshot, attempt.descriptionSnapshot, attempt.agentType, attempt.relatedTaskId ?? null,
        attempt.autoStart ? 1 : 0, attempt.timeoutMinutes ?? null, attempt.requestSnapshot, attempt.status, attempt.createdAt);
    if (result.changes) return { attempt, created: true };
    const existing = await this.getAttemptByExternalIdentity(attempt.externalSource, attempt.externalKey);
    if (!existing) throw new Error('failed to persist execution attempt');
    return { attempt: existing, created: false };
  }

  async createOrchestration(task: Task, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now()) {
    return this.db.transaction(() => {
      const replayRow = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?')
        .get(attempt.externalSource, attempt.externalKey) as AttemptRow | undefined;
      if (replayRow) {
        const replay = rowToAttempt(replayRow);
        const taskRow = this.stmts.getById.get(replay.taskId) as TaskRow | undefined;
        if (!taskRow) throw new Error('execution attempt references a missing task');
        return { task: rowToTask(taskRow), attempt: replay, created: false };
      }
      this.insertTask(task);
      const persistedAttempt = { ...attempt, taskId: task.id };
      const inserted = this.db.prepare(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(persistedAttempt.id, persistedAttempt.taskId, persistedAttempt.externalSource, persistedAttempt.externalKey,
          persistedAttempt.titleSnapshot, persistedAttempt.descriptionSnapshot, persistedAttempt.agentType, persistedAttempt.relatedTaskId ?? null,
          persistedAttempt.autoStart ? 1 : 0, persistedAttempt.timeoutMinutes ?? null, persistedAttempt.requestSnapshot, persistedAttempt.status, persistedAttempt.createdAt);
      if (inserted.changes !== 1) throw new Error('failed to persist execution attempt');
      if (relatedTaskId) this.insertRelationship(task.id, relatedTaskId, relationshipCreatedAt);
      return { task, attempt: persistedAttempt, created: true };
    }).immediate();
  }

  async continueOrchestration(taskId: string, updates: Partial<Task>, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now(), eligibility?: ContinuationEligibility) {
    // Acquire the writer lock before reading eligibility so separate SQLite
    // connections cannot both decide from the same stale task snapshot.
    return this.db.transaction(() => {
      const taskRow = this.stmts.getById.get(taskId) as TaskRow | undefined;
      if (!taskRow) return undefined;
      const replayRow = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?')
        .get(attempt.externalSource, attempt.externalKey) as AttemptRow | undefined;
      if (replayRow) {
        const replay = rowToAttempt(replayRow);
        const replayTaskRow = this.stmts.getById.get(replay.taskId) as TaskRow | undefined;
        if (!replayTaskRow) throw new Error('execution attempt references a missing task');
        return { task: rowToTask(replayTaskRow), attempt: replay, created: false };
      }
      const current = rowToTask(taskRow);
      if (eligibility?.requiredAgentStatus && current.agentStatus !== eligibility.requiredAgentStatus) return undefined;
      if (eligibility?.requireRunnable
        && ((current.runRequestedAt !== undefined && (current.runClaimedAt === undefined || current.agentStatus === 'idle'))
          || current.agentStatus === 'planning' || current.agentStatus === 'executing')) return undefined;
      const persistedAttempt = { ...attempt, taskId };
      this.db.prepare(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(persistedAttempt.id, taskId, persistedAttempt.externalSource, persistedAttempt.externalKey,
          persistedAttempt.titleSnapshot, persistedAttempt.descriptionSnapshot, persistedAttempt.agentType, persistedAttempt.relatedTaskId ?? null,
          persistedAttempt.autoStart ? 1 : 0, persistedAttempt.timeoutMinutes ?? null, persistedAttempt.requestSnapshot, persistedAttempt.status, persistedAttempt.createdAt);
      if (relatedTaskId) this.insertRelationship(taskId, relatedTaskId, relationshipCreatedAt);
      this.updateExisting(current, updates);
      const updatedRow = this.stmts.getById.get(taskId) as TaskRow | undefined;
      if (!updatedRow) throw new Error('failed to reset orchestration task');
      return { task: rowToTask(updatedRow), attempt: persistedAttempt, created: true };
    }).immediate();
  }

  private insertRelationship(taskId: string, relatedTaskId: string, createdAt: number): void {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    this.db.prepare(`INSERT OR IGNORE INTO task_relationships (task_id, related_task_id, type, created_at)
      SELECT ?, ?, 'related', ? FROM tasks a JOIN tasks b ON b.id = ? WHERE a.id = ? AND a.project_id = b.project_id`).run(left, right, createdAt, right, left);
    const exists = this.db.prepare('SELECT 1 FROM task_relationships WHERE task_id=? AND related_task_id=?').get(left, right);
    if (!exists) throw new Error('tasks must exist in the same project');
  }

  // ─── MCP server repository ───────────────────────────────────────────────

  async getAllServers(): Promise<MCPServerRecord[]> {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as Array<{
      id: string; name: string; transport: string; command: string | null;
      args: string | null; url: string | null; env: string | null;
      cwd: string | null; headers: string | null; status: string;
      last_connected_at: number | null; last_error: string | null;
      created_at: number; updated_at: number;
    }>;
    return rows.map(row => {
      const envRaw = row.env ?? '{}';
      const headersRaw = row.headers ?? '{}';
      const env = row.env && credentialService.isValueEncrypted(row.env)
        ? credentialService.decryptCredentials(row.env)
        : JSON.parse(envRaw);
      const headers = row.headers && credentialService.isValueEncrypted(row.headers)
        ? credentialService.decryptCredentials(row.headers)
        : JSON.parse(headersRaw);
      return {
        id: row.id, name: row.name, transport: row.transport,
        command: row.command ?? undefined,
        args: row.args ? JSON.parse(row.args) : undefined,
        url: row.url ?? undefined,
        env,
        cwd: row.cwd ?? undefined,
        headers,
        status: row.status as MCPServerRecord['status'],
        last_connected_at: row.last_connected_at ?? undefined,
        last_error: row.last_error ?? undefined,
        created_at: row.created_at, updated_at: row.updated_at,
      };
    });
  }

  async getServerById(id: string): Promise<MCPServerRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
      id: string; name: string; transport: string; command: string | null;
      args: string | null; url: string | null; env: string | null;
      cwd: string | null; headers: string | null; status: string;
      last_connected_at: number | null; last_error: string | null;
      created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    const envRaw = row.env ?? '{}';
    const headersRaw = row.headers ?? '{}';
    const env = row.env && credentialService.isValueEncrypted(row.env)
      ? credentialService.decryptCredentials(row.env)
      : JSON.parse(envRaw);
    const headers = row.headers && credentialService.isValueEncrypted(row.headers)
      ? credentialService.decryptCredentials(row.headers)
      : JSON.parse(headersRaw);
    return {
      id: row.id, name: row.name, transport: row.transport,
      command: row.command ?? undefined,
      args: row.args ? JSON.parse(row.args) : undefined,
      url: row.url ?? undefined,
      env,
      cwd: row.cwd ?? undefined,
      headers,
      status: row.status as MCPServerRecord['status'],
      last_connected_at: row.last_connected_at ?? undefined,
      last_error: row.last_error ?? undefined,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  async createServer(server: Omit<MCPServerRecord, 'created_at' | 'updated_at'>): Promise<MCPServerRecord> {
    const now = Date.now();
    const record: MCPServerRecord = {
      ...server, created_at: now, updated_at: now,
    };
    const encryptedEnv = record.env ? credentialService.encryptCredentials(record.env) : null;
    const encryptedHeaders = record.headers ? credentialService.encryptCredentials(record.headers) : null;
    this.db.prepare(`
      INSERT INTO mcp_servers (id,name,transport,command,args,url,env,cwd,headers,status,last_connected_at,last_error,created_at,updated_at)
      VALUES (@id,@name,@transport,@command,@args,@url,@env,@cwd,@headers,@status,@last_connected_at,@last_error,@created_at,@updated_at)
    `).run({
      id: record.id, name: record.name, transport: record.transport,
      command: record.command ?? null,
      args: record.args ? JSON.stringify(record.args) : null,
      url: record.url ?? null,
      env: encryptedEnv ?? (record.env ? JSON.stringify(record.env) : '{}'),
      cwd: record.cwd ?? null,
      headers: encryptedHeaders ?? (record.headers ? JSON.stringify(record.headers) : '{}'),
      status: record.status,
      last_connected_at: record.last_connected_at ?? null,
      last_error: record.last_error ?? null,
      created_at: record.created_at, updated_at: record.updated_at,
    });
    return record;
  }

  async updateServer(id: string, updates: Partial<MCPServerRecord>): Promise<MCPServerRecord | undefined> {
    const existing = await this.getServerById(id);
    if (!existing) return undefined;
    const now = Date.now();
    const merged: MCPServerRecord = { ...existing, ...updates, updated_at: now };
    const encryptedEnv = merged.env ? credentialService.encryptCredentials(merged.env) : null;
    const encryptedHeaders = merged.headers ? credentialService.encryptCredentials(merged.headers) : null;
    this.db.prepare(`
      UPDATE mcp_servers SET
        name = @name, transport = @transport, command = @command,
        args = @args, url = @url, env = @env, cwd = @cwd,
        headers = @headers, status = @status,
        last_connected_at = @last_connected_at, last_error = @last_error,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: merged.id, name: merged.name, transport: merged.transport,
      command: merged.command ?? null,
      args: merged.args ? JSON.stringify(merged.args) : null,
      url: merged.url ?? null,
      env: encryptedEnv ?? (merged.env ? JSON.stringify(merged.env) : '{}'),
      cwd: merged.cwd ?? null,
      headers: encryptedHeaders ?? (merged.headers ? JSON.stringify(merged.headers) : '{}'),
      status: merged.status,
      last_connected_at: merged.last_connected_at ?? null,
      last_error: merged.last_error ?? null,
      created_at: merged.created_at, updated_at: merged.updated_at,
    });
    return merged;
  }

  async deleteServer(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Agent profile CRUD ───────────────────────────────────────────────

  async getAgentProfile(id: string): Promise<AgentProfile | undefined> {
    const row = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as AgentProfileRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id, name: row.name, provider: row.provider as AgentProfile['provider'],
      model: row.model ?? undefined, instructions: row.instructions ?? undefined,
      command: row.command ?? undefined,
      mcpServerIds: row.mcp_server_ids ? JSON.parse(row.mcp_server_ids) : [],
      skillIds: row.skill_ids ? JSON.parse(row.skill_ids) : [],
      enabled: Boolean(row.enabled),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async getAllAgentProfiles(): Promise<AgentProfile[]> {
    const rows = this.db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC').all() as AgentProfileRow[];
    return rows.map(row => ({
      id: row.id, name: row.name, provider: row.provider as AgentProfile['provider'],
      model: row.model ?? undefined, instructions: row.instructions ?? undefined,
      command: row.command ?? undefined,
      mcpServerIds: row.mcp_server_ids ? JSON.parse(row.mcp_server_ids) : [],
      skillIds: row.skill_ids ? JSON.parse(row.skill_ids) : [],
      enabled: Boolean(row.enabled),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async getAgentProfileByProvider(provider: AgentType): Promise<AgentProfile | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM agent_profiles WHERE provider = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1',
    ).get(provider) as AgentProfileRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id, name: row.name, provider: row.provider as AgentProfile['provider'],
      model: row.model ?? undefined, instructions: row.instructions ?? undefined,
      command: row.command ?? undefined,
      mcpServerIds: row.mcp_server_ids ? JSON.parse(row.mcp_server_ids) : [],
      skillIds: row.skill_ids ? JSON.parse(row.skill_ids) : [],
      enabled: Boolean(row.enabled),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async createAgentProfile(profile: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentProfile> {
    const id = `agent-profile:${randomUUID()}`;
    const now = Date.now();
    const record: AgentProfile = { ...profile, id, createdAt: now, updatedAt: now };
    this.db.prepare(`
      INSERT INTO agent_profiles (id,name,provider,model,instructions,command,mcp_server_ids,skill_ids,enabled,created_at,updated_at)
      VALUES (@id,@name,@provider,@model,@instructions,@command,@mcp_server_ids,@skill_ids,@enabled,@created_at,@updated_at)
    `).run({
      id: record.id, name: record.name, provider: record.provider,
      model: record.model ?? null, instructions: record.instructions ?? null,
      command: record.command ?? null,
      mcp_server_ids: JSON.stringify(record.mcpServerIds), skill_ids: JSON.stringify(record.skillIds),
      enabled: record.enabled ? 1 : 0,
      created_at: record.createdAt, updated_at: record.updatedAt,
    });
    return record;
  }

  async updateAgentProfile(id: string, updates: Partial<Pick<AgentProfile, 'name' | 'provider' | 'model' | 'instructions' | 'command' | 'mcpServerIds' | 'skillIds' | 'enabled'>>): Promise<AgentProfile | undefined> {
    const existing = await this.getAgentProfile(id);
    if (!existing) return undefined;
    const now = Date.now();
    // Ignore keys with undefined values so PATCH-style updates only change supplied fields.
    const filtered = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined)) as typeof updates;
    const merged: AgentProfile = { ...existing, ...filtered, updatedAt: now };
    this.db.prepare(`
      UPDATE agent_profiles SET
        name = @name, provider = @provider, model = @model, instructions = @instructions,
        command = @command,
        mcp_server_ids = @mcp_server_ids, skill_ids = @skill_ids, enabled = @enabled,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: merged.id, name: merged.name, provider: merged.provider,
      model: merged.model ?? null, instructions: merged.instructions ?? null,
      command: merged.command ?? null,
      mcp_server_ids: JSON.stringify(merged.mcpServerIds), skill_ids: JSON.stringify(merged.skillIds),
      enabled: merged.enabled ? 1 : 0,
      updated_at: merged.updatedAt,
    });
    return merged;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getToolsByServer(serverId: string): Promise<MCPToolRecord[]> {
    const rows = this.db.prepare('SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name ASC').all(serverId) as Array<{
      id: string; server_id: string; name: string; description: string;
      input_schema: string; output_schema: string | null;
      annotations: string | null; discovered_at: number;
    }>;
    return rows.map(row => ({
      id: row.id, server_id: row.server_id, name: row.name,
      description: row.description,
      input_schema: JSON.parse(row.input_schema),
      output_schema: row.output_schema ? JSON.parse(row.output_schema) : undefined,
      annotations: row.annotations ? JSON.parse(row.annotations) : undefined,
      discovered_at: row.discovered_at,
    }));
  }

  async upsertTools(serverId: string, tools: MCPTool[]): Promise<void> {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM mcp_tools WHERE server_id = ?').run(serverId);
      const insert = this.db.prepare(`
        INSERT INTO mcp_tools (id, server_id, name, description, input_schema, output_schema, annotations, discovered_at)
        VALUES (@id, @server_id, @name, @description, @input_schema, @output_schema, @annotations, @discovered_at)
      `);
      const now = Date.now();
      for (const tool of tools) {
        insert.run({
          id: `${serverId}:${tool.name}`,
          server_id: serverId, name: tool.name, description: tool.description,
          input_schema: JSON.stringify(tool.inputSchema),
          output_schema: tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
          discovered_at: now,
        });
      }
    }).immediate();
  }

  async deleteToolsByServer(serverId: string): Promise<void> {
    this.db.prepare('DELETE FROM mcp_tools WHERE server_id = ?').run(serverId);
  }

  async getPermissionsByServer(serverId: string): Promise<MCPPermissionRecord[]> {
    const rows = this.db.prepare('SELECT * FROM mcp_permissions WHERE server_id = ? ORDER BY agent_type, tool_name').all(serverId) as Array<{
      id: string; server_id: string; agent_type: string; tool_name: string; allowed: number;
    }>;
    return rows.map(row => ({
      id: row.id, server_id: row.server_id, agent_type: row.agent_type,
      tool_name: row.tool_name, allowed: Boolean(row.allowed),
    }));
  }

  async getPermission(serverId: string, agentType: string, toolName: string): Promise<MCPPermissionRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM mcp_permissions WHERE server_id=? AND agent_type=? AND tool_name=?')
      .get(serverId, agentType, toolName) as {
        id: string; server_id: string; agent_type: string; tool_name: string; allowed: number;
      } | undefined;
    if (!row) return undefined;
    return { id: row.id, server_id: row.server_id, agent_type: row.agent_type, tool_name: row.tool_name, allowed: Boolean(row.allowed) };
  }

  async setPermission(serverId: string, agentType: string, toolName: string, allowed: boolean): Promise<MCPPermissionRecord> {
    const existing = await this.getPermission(serverId, agentType, toolName);
    if (existing) {
      this.db.prepare('UPDATE mcp_permissions SET allowed = ? WHERE id = ?').run(allowed ? 1 : 0, existing.id);
      return { ...existing, allowed };
    }
    const id = `mcp-perm:${serverId}:${agentType}:${toolName}`;
    this.db.prepare('INSERT INTO mcp_permissions (id, server_id, agent_type, tool_name, allowed) VALUES (?,?,?,?,?)')
      .run(id, serverId, agentType, toolName, allowed ? 1 : 0);
    return { id, server_id: serverId, agent_type: agentType, tool_name: toolName, allowed };
  }

  async deletePermission(serverId: string, agentType: string, toolName: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM mcp_permissions WHERE server_id=? AND agent_type=? AND tool_name=?')
      .run(serverId, agentType, toolName);
    return result.changes > 0;
  }

  async isToolAllowed(serverId: string, agentType: string, toolName: string): Promise<boolean> {
    const perm = await this.getPermission(serverId, agentType, toolName);
    return perm?.allowed ?? false;
  }

  async getOAuthData(serverId: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT data FROM mcp_oauth WHERE server_id = ?').get(serverId) as { data: string | null } | undefined;
    return row?.data ?? undefined;
  }

  async setOAuthData(serverId: string, data: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO mcp_oauth (server_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(serverId, data, Date.now());
  }

  async deleteOAuthData(serverId: string): Promise<void> {
    this.db.prepare('DELETE FROM mcp_oauth WHERE server_id = ?').run(serverId);
  }

  // ─── MCP Sync repository ──────────────────────────────────────────────

  async getAllConnections(): Promise<SyncConnectionRecord[]> {
    const rows = this.db.prepare('SELECT * FROM mcp_sync_connections ORDER BY created_at ASC').all() as Array<{
      id: string; server_id: string; task_id: string; external_source: string; external_key: string;
      external_task_tool: string; status: string; last_sync_at: number | null; last_error: string | null;
      sync_direction: string; conflict_policy: string; created_at: number; updated_at: number;
    }>;
    return rows.map(row => ({
      id: row.id, serverId: row.server_id, taskId: row.task_id,
      externalSource: row.external_source, externalKey: row.external_key,
      externalTaskTool: row.external_task_tool,
      status: row.status as SyncConnectionRecord['status'],
      lastSyncAt: row.last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
      syncDirection: row.sync_direction as SyncConnectionRecord['syncDirection'],
      conflictPolicy: row.conflict_policy as SyncConnectionRecord['conflictPolicy'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async getConnectionById(id: string): Promise<SyncConnectionRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM mcp_sync_connections WHERE id = ?').get(id) as {
      id: string; server_id: string; task_id: string; external_source: string; external_key: string;
      external_task_tool: string; status: string; last_sync_at: number | null; last_error: string | null;
      sync_direction: string; conflict_policy: string; created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, serverId: row.server_id, taskId: row.task_id,
      externalSource: row.external_source, externalKey: row.external_key,
      externalTaskTool: row.external_task_tool,
      status: row.status as SyncConnectionRecord['status'],
      lastSyncAt: row.last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
      syncDirection: row.sync_direction as SyncConnectionRecord['syncDirection'],
      conflictPolicy: row.conflict_policy as SyncConnectionRecord['conflictPolicy'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async getConnectionByTaskId(taskId: string): Promise<SyncConnectionRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM mcp_sync_connections WHERE task_id = ?').get(taskId) as {
      id: string; server_id: string; task_id: string; external_source: string; external_key: string;
      external_task_tool: string; status: string; last_sync_at: number | null; last_error: string | null;
      sync_direction: string; conflict_policy: string; created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, serverId: row.server_id, taskId: row.task_id,
      externalSource: row.external_source, externalKey: row.external_key,
      externalTaskTool: row.external_task_tool,
      status: row.status as SyncConnectionRecord['status'],
      lastSyncAt: row.last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
      syncDirection: row.sync_direction as SyncConnectionRecord['syncDirection'],
      conflictPolicy: row.conflict_policy as SyncConnectionRecord['conflictPolicy'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async getConnectionByExternalIdentity(
    externalSource: string,
    externalKey: string,
  ): Promise<SyncConnectionRecord | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM mcp_sync_connections WHERE external_source = ? AND external_key = ?',
    ).get(externalSource, externalKey) as {
      id: string; server_id: string; task_id: string; external_source: string; external_key: string;
      external_task_tool: string; status: string; last_sync_at: number | null; last_error: string | null;
      sync_direction: string; conflict_policy: string; created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, serverId: row.server_id, taskId: row.task_id,
      externalSource: row.external_source, externalKey: row.external_key,
      externalTaskTool: row.external_task_tool,
      status: row.status as SyncConnectionRecord['status'],
      lastSyncAt: row.last_sync_at ?? undefined,
      lastError: row.last_error ?? undefined,
      syncDirection: row.sync_direction as SyncConnectionRecord['syncDirection'],
      conflictPolicy: row.conflict_policy as SyncConnectionRecord['conflictPolicy'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async createConnection(conn: Omit<SyncConnectionRecord, 'createdAt' | 'updatedAt'>): Promise<SyncConnectionRecord> {
    const now = Date.now();
    const record: SyncConnectionRecord = { ...conn, createdAt: now, updatedAt: now };
    this.db.prepare(`
      INSERT INTO mcp_sync_connections
      (id, server_id, task_id, external_source, external_key, external_task_tool,
       status, last_sync_at, last_error, sync_direction, conflict_policy, created_at, updated_at)
      VALUES (@id,@serverId,@taskId,@externalSource,@externalKey,@externalTaskTool,
       @status,@lastSyncAt,@lastError,@syncDirection,@conflictPolicy,@createdAt,@updatedAt)
    `).run({
      id: record.id, serverId: record.serverId, taskId: record.taskId,
      externalSource: record.externalSource, externalKey: record.externalKey,
      externalTaskTool: record.externalTaskTool,
      status: record.status,
      lastSyncAt: record.lastSyncAt ?? null,
      lastError: record.lastError ?? null,
      syncDirection: record.syncDirection,
      conflictPolicy: record.conflictPolicy,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
    return record;
  }

  async updateConnection(
    id: string,
    updates: Partial<SyncConnectionRecord>,
  ): Promise<SyncConnectionRecord | undefined> {
    const existing = await this.getConnectionById(id);
    if (!existing) return undefined;
    const now = Date.now();
    const merged: SyncConnectionRecord = { ...existing, ...updates, updatedAt: now };
    this.db.prepare(`
      UPDATE mcp_sync_connections SET
        server_id = @serverId, task_id = @taskId, external_source = @externalSource,
        external_key = @externalKey, external_task_tool = @externalTaskTool,
        status = @status, last_sync_at = @lastSyncAt, last_error = @lastError,
        sync_direction = @syncDirection, conflict_policy = @conflictPolicy,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: merged.id, serverId: merged.serverId, taskId: merged.taskId,
      externalSource: merged.externalSource, externalKey: merged.externalKey,
      externalTaskTool: merged.externalTaskTool,
      status: merged.status,
      lastSyncAt: merged.lastSyncAt ?? null,
      lastError: merged.lastError ?? null,
      syncDirection: merged.syncDirection,
      conflictPolicy: merged.conflictPolicy,
      createdAt: merged.createdAt, updatedAt: merged.updatedAt,
    });
    return merged;
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM mcp_sync_connections WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getFieldMappingsByConnection(connectionId: string): Promise<SyncFieldMapping[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sync_field_mappings WHERE connection_id = ? ORDER BY external_field ASC',
    ).all(connectionId) as Array<{
      id: string; connection_id: string; external_field: string; board_field: string;
      transform: string; default_value: string | null;
    }>;
    return rows.map(row => ({
      id: row.id, connectionId: row.connection_id, externalField: row.external_field,
      boardField: row.board_field,
      transform: row.transform as SyncFieldMapping['transform'],
      defaultValue: row.default_value ?? undefined,
    }));
  }

  async upsertFieldMapping(
    connectionId: string,
    externalField: string,
    boardField: string,
    transform: SyncFieldMapping['transform'],
    defaultValue?: string,
  ): Promise<SyncFieldMapping> {
    const existing = (this.db.prepare(
      'SELECT * FROM sync_field_mappings WHERE connection_id = ? AND external_field = ?',
    ).get(connectionId, externalField) as {
      id: string; connection_id: string; external_field: string; board_field: string;
      transform: string; default_value: string | null;
    } | undefined);
    if (existing) {
      this.db.prepare(
        'UPDATE sync_field_mappings SET board_field = ?, transform = ?, default_value = ? WHERE id = ?',
      ).run(boardField, transform, defaultValue ?? null, existing.id);
      return {
        id: existing.id, connectionId: existing.connection_id,
        externalField: existing.external_field, boardField,
        transform, defaultValue: existing.default_value ?? undefined,
      };
    }
    const id = `sync-map:${connectionId}:${externalField}`;
    this.db.prepare(
      'INSERT INTO sync_field_mappings (id, connection_id, external_field, board_field, transform, default_value) VALUES (?,?,?,?,?,?)',
    ).run(id, connectionId, externalField, boardField, transform, defaultValue ?? null);
    return { id, connectionId, externalField, boardField, transform, defaultValue };
  }

  async deleteFieldMapping(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM sync_field_mappings WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async getConflictsByConnection(connectionId: string): Promise<SyncConflict[]> {
    const rows = this.db.prepare(
      'SELECT * FROM sync_conflicts WHERE connection_id = ? ORDER BY created_at DESC',
    ).all(connectionId) as Array<{
      id: string; connection_id: string; external_field: string; board_field: string;
      external_value: string | null; board_value: string | null; resolved_value: string | null;
      resolved_at: number | null; resolved_by: string | null; status: string;
      created_at: number; updated_at: number;
    }>;
    return rows.map(row => ({
      id: row.id, connectionId: row.connection_id, externalField: row.external_field,
      boardField: row.board_field,
      externalValue: row.external_value ?? undefined,
      boardValue: row.board_value ?? undefined,
      resolvedValue: row.resolved_value ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      status: row.status as SyncConflict['status'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  async createConflict(conflict: Omit<SyncConflict, 'id' | 'createdAt' | 'updatedAt'>): Promise<SyncConflict> {
    const now = Date.now();
    const id = `sync-conflict:${now}-${Math.random().toString(36).slice(2)}`;
    const record: SyncConflict = { ...conflict, id, createdAt: now, updatedAt: now };
    this.db.prepare(`
      INSERT INTO sync_conflicts
      (id, connection_id, external_field, board_field, external_value, board_value,
       resolved_value, resolved_at, resolved_by, status, created_at, updated_at)
      VALUES (@id,@connectionId,@externalField,@boardField,@externalValue,@boardValue,
       @resolvedValue,@resolvedAt,@resolvedBy,@status,@createdAt,@updatedAt)
    `).run({
      id: record.id, connectionId: record.connectionId, externalField: record.externalField,
      boardField: record.boardField,
      externalValue: record.externalValue ?? null,
      boardValue: record.boardValue ?? null,
      resolvedValue: record.resolvedValue ?? null,
      resolvedAt: record.resolvedAt ?? null,
      resolvedBy: record.resolvedBy ?? null,
      status: record.status,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
    return record;
  }

  async resolveConflict(id: string, resolvedValue: string, resolvedBy: string): Promise<SyncConflict | undefined> {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE sync_conflicts SET resolved_value = ?, resolved_at = ?, resolved_by = ?,
       status = 'resolved', updated_at = ? WHERE id = ?
    `).run(resolvedValue, now, resolvedBy, now, id);
    if (!result.changes) return undefined;
    const row = this.db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as {
      id: string; connection_id: string; external_field: string; board_field: string;
      external_value: string | null; board_value: string | null; resolved_value: string | null;
      resolved_at: number | null; resolved_by: string | null; status: string;
      created_at: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, connectionId: row.connection_id, externalField: row.external_field,
      boardField: row.board_field,
      externalValue: row.external_value ?? undefined,
      boardValue: row.board_value ?? undefined,
      resolvedValue: row.resolved_value ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
      status: row.status as SyncConflict['status'],
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async ignoreConflict(id: string): Promise<boolean> {
    const now = Date.now();
    const result = this.db.prepare(
      'UPDATE sync_conflicts SET status = ?, updated_at = ? WHERE id = ?',
    ).run('ignored', now, id);
    return result.changes > 0;
  }

  async getSyncState(connectionId: string): Promise<SyncState | undefined> {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE connection_id = ?').get(connectionId) as {
      id: string; connection_id: string; last_external_synced_at: number | null;
      last_board_synced_at: number | null; sync_count: number; updated_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id, connectionId: row.connection_id,
      lastExternalSyncedAt: row.last_external_synced_at ?? undefined,
      lastBoardSyncedAt: row.last_board_synced_at ?? undefined,
      syncCount: row.sync_count, updatedAt: row.updated_at,
    };
  }

  async upsertSyncState(connectionId: string, state: Partial<SyncState>): Promise<SyncState> {
    const existing = await this.getSyncState(connectionId);
    const now = Date.now();
    if (existing) {
      const merged: SyncState = { ...existing, ...state, updatedAt: now };
      this.db.prepare(
        'UPDATE sync_state SET last_external_synced_at = ?, last_board_synced_at = ?, sync_count = ?, updated_at = ? WHERE connection_id = ?',
      ).run(
        merged.lastExternalSyncedAt ?? null, merged.lastBoardSyncedAt ?? null,
        merged.syncCount, merged.updatedAt, connectionId,
      );
      return merged;
    }
    const id = `sync-state:${connectionId}`;
    const record: SyncState = {
      id, connectionId,
      lastExternalSyncedAt: state.lastExternalSyncedAt,
      lastBoardSyncedAt: state.lastBoardSyncedAt,
      syncCount: state.syncCount ?? 0, updatedAt: now,
    };
    this.db.prepare(
      'INSERT INTO sync_state (id, connection_id, last_external_synced_at, last_board_synced_at, sync_count, updated_at) VALUES (?,?,?,?,?,?)',
    ).run(
      record.id, record.connectionId, record.lastExternalSyncedAt ?? null,
      record.lastBoardSyncedAt ?? null, record.syncCount, record.updatedAt,
    );
    return record;
  }
}
