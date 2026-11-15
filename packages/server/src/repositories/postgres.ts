import { Pool } from 'pg';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent, TaskRelationship, ExecutionAttempt, MCPTool } from '../types.js';
import type { TaskRepository, ContinuationEligibility } from './types.js';
import type { MCPServerRecord, MCPToolRecord, MCPPermissionRecord, MCPRepository } from './mcp-types.js';
import type { SyncConnectionRecord, SyncFieldMapping, SyncConflict, SyncState, SyncRepository } from './mcp-sync-types.js';
import { isValidPriority, isValidColumnId, isValidAgentStatus, isValidAgentType } from '@ai-agent-board/shared/constants.js';
import { errorMessage } from '../utils.js';
import { credentialService } from '../services/credential-service.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: string;
  column_id: string;
  agent_status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: boolean | null;
  worktree_path: string | null;
  agent_type: string;
  archived: boolean;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: string | null; run_claimed_at: string | null;
  timeout_minutes: number | null;
}

function rowToTask(row: TaskRow): Task {
  // Validate and log warnings for invalid values
  if (!isValidPriority(row.priority)) {
    console.warn(`[postgres] Invalid priority in database: ${row.priority} for task ${row.id}, using 'medium' as default`);
    row.priority = 'medium';
  }

  if (!isValidColumnId(row.column_id)) {
    console.warn(`[postgres] Invalid column_id in database: ${row.column_id} for task ${row.id}, using 'backlog' as default`);
    row.column_id = 'backlog';
  }

  if (!isValidAgentStatus(row.agent_status)) {
    console.warn(`[postgres] Invalid agent_status in database: ${row.agent_status} for task ${row.id}, using 'idle' as default`);
    row.agent_status = 'idle';
  }

  if (!isValidAgentType(row.agent_type)) {
    console.warn(`[postgres] Invalid agent_type in database: ${row.agent_type} for task ${row.id}, using 'copilot' as default`);
    row.agent_type = 'copilot';
  }

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    columnId: row.column_id as ColumnId,
    agentStatus: row.agent_status as AgentStatus,
    createdAt: Number(row.created_at),
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type as AgentType,
    archived: row.archived,
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null, externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at != null ? Number(row.run_requested_at) : undefined, runClaimedAt: row.run_claimed_at != null ? Number(row.run_claimed_at) : undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
  };
}

interface AttemptRow {
  id: string; task_id: string; external_source: string; external_key: string;
  title_snapshot: string; description_snapshot: string; agent_type: AgentType;
  related_task_id: string | null; auto_start: boolean; timeout_minutes: number | null;
  request_snapshot: string;
  status: ExecutionAttempt['status']; created_at: string;
}

function rowToAttempt(row: AttemptRow): ExecutionAttempt {
  return { id: row.id, taskId: row.task_id, externalSource: row.external_source, externalKey: row.external_key,
    titleSnapshot: row.title_snapshot, descriptionSnapshot: row.description_snapshot, agentType: row.agent_type,
    relatedTaskId: row.related_task_id ?? undefined, autoStart: row.auto_start,
    timeoutMinutes: row.timeout_minutes ?? undefined, requestSnapshot: row.request_snapshot,
    status: row.status, createdAt: Number(row.created_at) };
}

export class PostgresTaskRepository implements TaskRepository, MCPRepository, SyncRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const query = includeArchived
      ? 'SELECT * FROM tasks WHERE project_id = $1 AND group_id IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM tasks WHERE project_id = $1 AND archived = FALSE AND group_id IS NULL ORDER BY created_at ASC';
    const { rows } = await this.pool.query<TaskRow>(query, [projectId]);
    return rows.map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE external_source=$1 AND external_key=$2', [source,key]); return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async resolve(reference: string, projectId: string): Promise<Task[]> {
    const needle = reference.trim();
    const exact = await this.getById(needle);
    if (exact) return exact.projectId === projectId ? [exact] : [];
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE project_id=$1 AND lower(title)=lower($2) ORDER BY created_at,id', [projectId, needle]);
    return rows.map(rowToTask);
  }

  async create(task: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type,
        created_at, started_at, completed_at, repo_path, branch_name, base_branch, use_worktree, worktree_path, archived,
        group_id, group_order, summary, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
      [
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.priority,
        task.columnId,
        task.agentStatus,
        task.agentType ?? 'copilot',
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.repoPath ?? null,
        task.branchName ?? null,
        task.baseBranch ?? null,
        task.useWorktree ?? null,
        task.worktreePath ?? null,
        task.archived ?? false,
        task.groupId ?? null,
        task.groupOrder ?? null,
        task.summary ?? null, task.externalSource ?? null, task.externalKey ?? null, task.provenance ? JSON.stringify(task.provenance) : null, task.runRequestedAt ?? null, task.runClaimedAt ?? null, task.timeoutMinutes ?? null,
      ]
    );
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return {task,created:true}; } catch (err: any) {
      if (err?.code === '23505' && task.externalSource && task.externalKey) { const existing=await this.getByExternalIdentity(task.externalSource,task.externalKey); if(existing) return {task:existing,created:false}; } throw err;
    }
  }
  async requestRun(id:string,at:number) { const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=$1,run_claimed_at=NULL WHERE id=$2 RETURNING *',[at,id]); return rows[0]?rowToTask(rows[0]):undefined; }
  async claimRun(id:string,at:number) { const staleBefore=at-30_000; const {rows}=await this.pool.query<TaskRow>("UPDATE tasks SET run_claimed_at=$1 WHERE id=$2 AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $3) AND agent_status IN ('idle','planning') RETURNING *",[at,id,staleBefore]); return rows[0]?rowToTask(rows[0]):undefined; }
  async clearRun(id:string) { const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=NULL,run_claimed_at=NULL WHERE id=$1 RETURNING *',[id]); return rows[0]?rowToTask(rows[0]):undefined; }
  async getPendingRuns(staleBefore=Date.now()-30_000) { const {rows}=await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $1) AND agent_status IN ('idle','planning') ORDER BY run_requested_at",[staleBefore]); return rows.map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<TaskRow>(
        'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const existing = rowToTask(rows[0]);
      const merged = { ...existing, ...updates };
      await client.query(
        `UPDATE tasks SET
          title = $1, description = $2, priority = $3, column_id = $4,
          agent_status = $5, agent_type = $6, started_at = $7, completed_at = $8,
          repo_path = $9, branch_name = $10, base_branch = $11, use_worktree = $12,
          worktree_path = $13, archived = $14, summary = $15, run_requested_at=$16, run_claimed_at=$17,
          timeout_minutes=$18
        WHERE id = $19`,
        [
          merged.title,
          merged.description,
          merged.priority,
          merged.columnId,
          merged.agentStatus,
          merged.agentType,
          merged.startedAt ?? null,
          merged.completedAt ?? null,
          merged.repoPath ?? null,
          merged.branchName ?? null,
          merged.baseBranch ?? null,
          merged.useWorktree ?? null,
          merged.worktreePath ?? null,
          merged.archived ?? false,
          merged.summary ?? null, merged.runRequestedAt ?? null, merged.runClaimedAt ?? null, merged.timeoutMinutes ?? null,
          id,
        ]
      );
      await client.query('COMMIT');
      return merged;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ cnt: string }>(
      'SELECT COUNT(*) as cnt FROM tasks'
    );
    return Number(rows[0].cnt);
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (id, task_id, type, content, timestamp, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.id,
        event.taskId,
        event.type,
        event.content,
        event.timestamp,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]
    );
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: string;
      metadata: string | null;
    }>(
      'SELECT * FROM events WHERE task_id = $1 ORDER BY timestamp ASC, ctid ASC',
      [taskId]
    );
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[postgres] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: Number(row.timestamp),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM events WHERE task_id = $1', [taskId]);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE project_id = $1 AND archived = TRUE ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map(rowToTask);
  }

  async getRelationships(taskId: string): Promise<TaskRelationship[]> {
    const { rows } = await this.pool.query<{ task_id: string; related_task_id: string; type: 'related'; created_at: string }>(
      'SELECT task_id, related_task_id, type, created_at FROM task_relationships WHERE task_id=$1 OR related_task_id=$1 ORDER BY created_at, task_id, related_task_id', [taskId]);
    return rows.map((row) => ({ taskId, relatedTaskId: row.task_id === taskId ? row.related_task_id : row.task_id, type: row.type, createdAt: Number(row.created_at) }));
  }

  async createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    const { rows } = await this.pool.query<{ created_at: string }>(`INSERT INTO task_relationships(task_id,related_task_id,type,created_at)
      SELECT $1,$2,'related',$3 FROM tasks a JOIN tasks b ON b.id=$2 WHERE a.id=$1 AND a.project_id=b.project_id
      ON CONFLICT(task_id,related_task_id) DO NOTHING RETURNING created_at`, [left, right, createdAt]);
    const persisted = rows[0] ?? (await this.pool.query<{ created_at: string }>('SELECT created_at FROM task_relationships WHERE task_id=$1 AND related_task_id=$2', [left, right])).rows[0];
    if (!persisted) throw new Error('tasks must exist in the same project');
    return { relationship: { taskId, relatedTaskId, type: 'related', createdAt: Number(persisted.created_at) }, created: rows.length > 0 };
  }

  async deleteRelationship(taskId: string, relatedTaskId: string): Promise<boolean> {
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    return ((await this.pool.query('DELETE FROM task_relationships WHERE task_id=$1 AND related_task_id=$2', [left, right])).rowCount ?? 0) > 0;
  }

  async getAttemptById(id: string): Promise<ExecutionAttempt | undefined> {
    const { rows } = await this.pool.query<AttemptRow>('SELECT * FROM execution_attempts WHERE id=$1', [id]);
    return rows[0] ? rowToAttempt(rows[0]) : undefined;
  }

  async getAttemptByExternalIdentity(source: string, key: string): Promise<ExecutionAttempt | undefined> {
    const { rows } = await this.pool.query<AttemptRow>('SELECT * FROM execution_attempts WHERE external_source=$1 AND external_key=$2', [source,key]);
    return rows[0] ? rowToAttempt(rows[0]) : undefined;
  }

  async getAttemptsByTaskId(taskId: string): Promise<ExecutionAttempt[]> {
    const { rows } = await this.pool.query<AttemptRow>('SELECT * FROM execution_attempts WHERE task_id=$1 ORDER BY created_at,id', [taskId]);
    return rows.map(rowToAttempt);
  }

  async createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }> {
    const { rows } = await this.pool.query<AttemptRow>(`INSERT INTO execution_attempts
      (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(external_source,external_key) DO NOTHING RETURNING *`,
      [attempt.id,attempt.taskId,attempt.externalSource,attempt.externalKey,attempt.titleSnapshot,attempt.descriptionSnapshot,
        attempt.agentType,attempt.relatedTaskId ?? null,attempt.autoStart,attempt.timeoutMinutes ?? null,attempt.requestSnapshot,attempt.status,attempt.createdAt]);
    if (rows[0]) return { attempt: rowToAttempt(rows[0]), created: true };
    const existing = await this.getAttemptByExternalIdentity(attempt.externalSource, attempt.externalKey);
    if (!existing) throw new Error('failed to persist execution attempt');
    return { attempt: existing, created: false };
  }

  async createOrchestration(task: Task, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now()) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A missing row cannot be protected with SELECT ... FOR UPDATE. Serialize
      // every operation for this external identity before any task write so a
      // concurrent create/continuation/retry cannot leave an orphan task.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${attempt.externalSource.length}:${attempt.externalSource}${attempt.externalKey}`],
      );
      const replayResult = await client.query<AttemptRow>(
        'SELECT * FROM execution_attempts WHERE external_source=$1 AND external_key=$2 FOR UPDATE',
        [attempt.externalSource, attempt.externalKey],
      );
      if (replayResult.rows[0]) {
        const replay = rowToAttempt(replayResult.rows[0]);
        const replayTaskResult = await client.query<TaskRow>('SELECT * FROM tasks WHERE id=$1', [replay.taskId]);
        if (!replayTaskResult.rows[0]) throw new Error('execution attempt references a missing task');
        await client.query('COMMIT');
        return { task: rowToTask(replayTaskResult.rows[0]), attempt: replay, created: false };
      }
      const taskInsert = await client.query<TaskRow>(`INSERT INTO tasks (id,project_id,title,description,priority,column_id,agent_status,agent_type,
        created_at,started_at,completed_at,repo_path,branch_name,base_branch,use_worktree,worktree_path,archived,group_id,group_order,summary,
        external_source,external_key,provenance,run_requested_at,run_claimed_at,timeout_minutes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT(external_source,external_key)
          WHERE external_source IS NOT NULL AND external_key IS NOT NULL
        DO NOTHING RETURNING *`, [task.id,task.projectId,task.title,task.description,task.priority,task.columnId,
        task.agentStatus,task.agentType ?? 'copilot',task.createdAt,task.startedAt ?? null,task.completedAt ?? null,task.repoPath ?? null,
        task.branchName ?? null,task.baseBranch ?? null,task.useWorktree ?? null,task.worktreePath ?? null,task.archived ?? false,task.groupId ?? null,
        task.groupOrder ?? null,task.summary ?? null,task.externalSource ?? null,task.externalKey ?? null,task.provenance ? JSON.stringify(task.provenance) : null,
        task.runRequestedAt ?? null,task.runClaimedAt ?? null,task.timeoutMinutes ?? null]);
      let persistedTask = taskInsert.rows[0] ? rowToTask(taskInsert.rows[0]) : undefined;
      if (!persistedTask) {
        const existingTask = await client.query<TaskRow>('SELECT * FROM tasks WHERE external_source=$1 AND external_key=$2 FOR UPDATE', [task.externalSource,task.externalKey]);
        persistedTask = existingTask.rows[0] ? rowToTask(existingTask.rows[0]) : undefined;
      }
      if (!persistedTask) throw new Error('failed to persist orchestration task');
      const persistedAttempt = { ...attempt, taskId: persistedTask.id };
      const attemptInsert = await client.query<AttemptRow>(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(external_source,external_key) DO NOTHING RETURNING *`, [persistedAttempt.id,persistedAttempt.taskId,persistedAttempt.externalSource,
        persistedAttempt.externalKey,persistedAttempt.titleSnapshot,persistedAttempt.descriptionSnapshot,persistedAttempt.agentType,
        persistedAttempt.relatedTaskId ?? null,persistedAttempt.autoStart,persistedAttempt.timeoutMinutes ?? null,persistedAttempt.requestSnapshot,
        persistedAttempt.status,persistedAttempt.createdAt]);
      if (!attemptInsert.rows[0]) {
        const replayResult = await client.query<AttemptRow>('SELECT * FROM execution_attempts WHERE external_source=$1 AND external_key=$2', [attempt.externalSource,attempt.externalKey]);
        const replay = replayResult.rows[0] ? rowToAttempt(replayResult.rows[0]) : undefined;
        if (!replay) throw new Error('failed to persist execution attempt');
        const replayTaskResult = await client.query<TaskRow>('SELECT * FROM tasks WHERE id=$1', [replay.taskId]);
        if (!replayTaskResult.rows[0]) throw new Error('execution attempt references a missing task');
        await client.query('COMMIT');
        return { task: rowToTask(replayTaskResult.rows[0]), attempt: replay, created: false };
      }
      if (relatedTaskId) await this.insertRelationshipWithClient(client, persistedTask.id, relatedTaskId, relationshipCreatedAt);
      await client.query('COMMIT');
      return { task: persistedTask, attempt: rowToAttempt(attemptInsert.rows[0]), created: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  async continueOrchestration(taskId: string, updates: Partial<Task>, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now(), eligibility?: ContinuationEligibility) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Distinct idempotency keys still serialize on the task they reset.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`task:${taskId}`],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${attempt.externalSource.length}:${attempt.externalSource}${attempt.externalKey}`],
      );
      const currentResult = await client.query<TaskRow>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      if (!currentResult.rows[0]) { await client.query('ROLLBACK'); return undefined; }
      const current = rowToTask(currentResult.rows[0]);
      const persistedAttempt = { ...attempt, taskId };
      const attemptInsert = await client.query<AttemptRow>(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(external_source,external_key) DO NOTHING RETURNING *`, [persistedAttempt.id,taskId,persistedAttempt.externalSource,persistedAttempt.externalKey,
        persistedAttempt.titleSnapshot,persistedAttempt.descriptionSnapshot,persistedAttempt.agentType,persistedAttempt.relatedTaskId ?? null,
        persistedAttempt.autoStart,persistedAttempt.timeoutMinutes ?? null,persistedAttempt.requestSnapshot,persistedAttempt.status,persistedAttempt.createdAt]);
      if (!attemptInsert.rows[0]) {
        const replayResult = await client.query<AttemptRow>('SELECT * FROM execution_attempts WHERE external_source=$1 AND external_key=$2', [attempt.externalSource,attempt.externalKey]);
        const replay = replayResult.rows[0] ? rowToAttempt(replayResult.rows[0]) : undefined;
        if (!replay) throw new Error('failed to persist execution attempt');
        const replayTask = replay.taskId === current.id ? currentResult.rows[0] : (await client.query<TaskRow>('SELECT * FROM tasks WHERE id=$1', [replay.taskId])).rows[0];
        if (!replayTask) throw new Error('execution attempt references a missing task');
        await client.query('COMMIT');
        return { task: rowToTask(replayTask), attempt: replay, created: false };
      }
      if (eligibility?.requiredAgentStatus && current.agentStatus !== eligibility.requiredAgentStatus) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (eligibility?.requireRunnable
        && ((current.runRequestedAt !== undefined && (current.runClaimedAt === undefined || current.agentStatus === 'idle'))
          || current.agentStatus === 'planning' || current.agentStatus === 'executing')) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (relatedTaskId) await this.insertRelationshipWithClient(client, taskId, relatedTaskId, relationshipCreatedAt);
      const merged = { ...current, ...updates };
      const updated = await client.query<TaskRow>(`UPDATE tasks SET title=$1,description=$2,priority=$3,column_id=$4,agent_status=$5,agent_type=$6,
        started_at=$7,completed_at=$8,repo_path=$9,branch_name=$10,base_branch=$11,use_worktree=$12,worktree_path=$13,archived=$14,
        summary=$15,run_requested_at=$16,run_claimed_at=$17,timeout_minutes=$18 WHERE id=$19 RETURNING *`, [merged.title,merged.description,
        merged.priority,merged.columnId,merged.agentStatus,merged.agentType,merged.startedAt ?? null,merged.completedAt ?? null,merged.repoPath ?? null,
        merged.branchName ?? null,merged.baseBranch ?? null,merged.useWorktree ?? null,merged.worktreePath ?? null,merged.archived ?? false,
        merged.summary ?? null,merged.runRequestedAt ?? null,merged.runClaimedAt ?? null,merged.timeoutMinutes ?? null,taskId]);
      if (!updated.rows[0]) throw new Error('failed to reset orchestration task');
      await client.query('COMMIT');
      return { task: rowToTask(updated.rows[0]), attempt: rowToAttempt(attemptInsert.rows[0]), created: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  private async insertRelationshipWithClient(client: { query: Function }, taskId: string, relatedTaskId: string, createdAt: number): Promise<void> {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left,right] = taskId < relatedTaskId ? [taskId,relatedTaskId] : [relatedTaskId,taskId];
    const result = await client.query(`INSERT INTO task_relationships(task_id,related_task_id,type,created_at)
      SELECT $1,$2,'related',$3 FROM tasks a JOIN tasks b ON b.id=$2 WHERE a.id=$1 AND a.project_id=b.project_id
      ON CONFLICT(task_id,related_task_id) DO NOTHING RETURNING created_at`, [left,right,createdAt]);
    if (!result.rows[0]) {
      const existing = await client.query('SELECT 1 FROM task_relationships WHERE task_id=$1 AND related_task_id=$2', [left,right]);
      if (!existing.rows[0]) throw new Error('tasks must exist in the same project');
    }
  }

  // ─── MCP server repository ───────────────────────────────────────────────

  async getAllServers(): Promise<MCPServerRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM mcp_servers ORDER BY created_at ASC');
    return rows.map((row: any) => {
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
    const { rows } = await this.pool.query('SELECT * FROM mcp_servers WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const row = rows[0];
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
    await this.pool.query(`
      INSERT INTO mcp_servers (id,name,transport,command,args,url,env,cwd,headers,status,last_connected_at,last_error,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [record.id, record.name, record.transport, record.command ?? null,
      record.args ? JSON.stringify(record.args) : null, record.url ?? null,
      encryptedEnv ?? (record.env ? JSON.stringify(record.env) : '{}'), record.cwd ?? null,
      encryptedHeaders ?? (record.headers ? JSON.stringify(record.headers) : '{}'), record.status,
      record.last_connected_at ?? null, record.last_error ?? null,
      record.created_at, record.updated_at]);
    return record;
  }

  async updateServer(id: string, updates: Partial<MCPServerRecord>): Promise<MCPServerRecord | undefined> {
    const existing = await this.getServerById(id);
    if (!existing) return undefined;
    const now = Date.now();
    const merged: MCPServerRecord = { ...existing, ...updates, updated_at: now };
    const encryptedEnv = merged.env ? credentialService.encryptCredentials(merged.env) : null;
    const encryptedHeaders = merged.headers ? credentialService.encryptCredentials(merged.headers) : null;
    await this.pool.query(`
      UPDATE mcp_servers SET
        name = $2, transport = $3, command = $4, args = $5, url = $6,
        env = $7, cwd = $8, headers = $9, status = $10,
        last_connected_at = $11, last_error = $12, updated_at = $13
      WHERE id = $1
    `, [merged.id, merged.name, merged.transport, merged.command ?? null,
      merged.args ? JSON.stringify(merged.args) : null, merged.url ?? null,
      encryptedEnv ?? (merged.env ? JSON.stringify(merged.env) : '{}'), merged.cwd ?? null,
      encryptedHeaders ?? (merged.headers ? JSON.stringify(merged.headers) : '{}'), merged.status,
      merged.last_connected_at ?? null, merged.last_error ?? null,
      merged.updated_at]);
    return merged;
  }

  async deleteServer(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM mcp_servers WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getToolsByServer(serverId: string): Promise<MCPToolRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM mcp_tools WHERE server_id = $1 ORDER BY name ASC', [serverId]);
    return rows.map((row: any) => ({
      id: row.id, server_id: row.server_id, name: row.name,
      description: row.description,
      input_schema: JSON.parse(row.input_schema),
      output_schema: row.output_schema ? JSON.parse(row.output_schema) : undefined,
      annotations: row.annotations ? JSON.parse(row.annotations) : undefined,
      discovered_at: row.discovered_at,
    }));
  }

  async upsertTools(serverId: string, tools: MCPTool[]): Promise<void> {
    await this.pool.query('DELETE FROM mcp_tools WHERE server_id = $1', [serverId]);
    const now = Date.now();
    for (const tool of tools) {
      await this.pool.query(`
        INSERT INTO mcp_tools (id, server_id, name, description, input_schema, output_schema, annotations, discovered_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [`${serverId}:${tool.name}`, serverId, tool.name, tool.description,
        JSON.stringify(tool.inputSchema),
        tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
        tool.annotations ? JSON.stringify(tool.annotations) : null, now]);
    }
  }

  async deleteToolsByServer(serverId: string): Promise<void> {
    await this.pool.query('DELETE FROM mcp_tools WHERE server_id = $1', [serverId]);
  }

  async getPermissionsByServer(serverId: string): Promise<MCPPermissionRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM mcp_permissions WHERE server_id = $1 ORDER BY agent_type, tool_name', [serverId]);
    return rows.map((row: any) => ({
      id: row.id, server_id: row.server_id, agent_type: row.agent_type,
      tool_name: row.tool_name, allowed: Boolean(row.allowed),
    }));
  }

  async getPermission(serverId: string, agentType: string, toolName: string): Promise<MCPPermissionRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM mcp_permissions WHERE server_id=$1 AND agent_type=$2 AND tool_name=$3', [serverId, agentType, toolName]);
    if (!rows[0]) return undefined;
    const row = rows[0];
    return { id: row.id, server_id: row.server_id, agent_type: row.agent_type, tool_name: row.tool_name, allowed: Boolean(row.allowed) };
  }

  async setPermission(serverId: string, agentType: string, toolName: string, allowed: boolean): Promise<MCPPermissionRecord> {
    const existing = await this.getPermission(serverId, agentType, toolName);
    if (existing) {
      await this.pool.query('UPDATE mcp_permissions SET allowed = $1 WHERE id = $2', [allowed ? 1 : 0, existing.id]);
      return { ...existing, allowed };
    }
    const id = `mcp-perm:${serverId}:${agentType}:${toolName}`;
    await this.pool.query('INSERT INTO mcp_permissions (id, server_id, agent_type, tool_name, allowed) VALUES ($1,$2,$3,$4,$5)',
      [id, serverId, agentType, toolName, allowed ? 1 : 0]);
    return { id, server_id: serverId, agent_type: agentType, tool_name: toolName, allowed };
  }

  async deletePermission(serverId: string, agentType: string, toolName: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM mcp_permissions WHERE server_id=$1 AND agent_type=$2 AND tool_name=$3', [serverId, agentType, toolName]);
    return (result.rowCount ?? 0) > 0;
  }

  async isToolAllowed(serverId: string, agentType: string, toolName: string): Promise<boolean> {
    const perm = await this.getPermission(serverId, agentType, toolName);
    return perm?.allowed ?? false;
  }

  // ─── MCP Sync repository ──────────────────────────────────────────────

  async getAllConnections(): Promise<SyncConnectionRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM mcp_sync_connections ORDER BY created_at ASC');
    return rows.map((row: any) => ({
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
    const { rows } = await this.pool.query('SELECT * FROM mcp_sync_connections WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const row = rows[0];
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
    const { rows } = await this.pool.query('SELECT * FROM mcp_sync_connections WHERE task_id = $1', [taskId]);
    if (!rows[0]) return undefined;
    const row = rows[0];
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
    const { rows } = await this.pool.query(
      'SELECT * FROM mcp_sync_connections WHERE external_source = $1 AND external_key = $2',
      [externalSource, externalKey],
    );
    if (!rows[0]) return undefined;
    const row = rows[0];
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
    await this.pool.query(`
      INSERT INTO mcp_sync_connections
      (id, server_id, task_id, external_source, external_key, external_task_tool,
       status, last_sync_at, last_error, sync_direction, conflict_policy, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [record.id, record.serverId, record.taskId, record.externalSource,
      record.externalKey, record.externalTaskTool, record.status,
      record.lastSyncAt ?? null, record.lastError ?? null,
      record.syncDirection, record.conflictPolicy,
      record.createdAt, record.updatedAt]);
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
    await this.pool.query(`
      UPDATE mcp_sync_connections SET
        server_id = $2, task_id = $3, external_source = $4, external_key = $5,
        external_task_tool = $6, status = $7, last_sync_at = $8, last_error = $9,
        sync_direction = $10, conflict_policy = $11, updated_at = $12
      WHERE id = $1
    `, [merged.id, merged.serverId, merged.taskId, merged.externalSource,
      merged.externalKey, merged.externalTaskTool, merged.status,
      merged.lastSyncAt ?? null, merged.lastError ?? null,
      merged.syncDirection, merged.conflictPolicy, merged.updatedAt]);
    return merged;
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM mcp_sync_connections WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getFieldMappingsByConnection(connectionId: string): Promise<SyncFieldMapping[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sync_field_mappings WHERE connection_id = $1 ORDER BY external_field ASC',
      [connectionId],
    );
    return rows.map((row: any) => ({
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
    const { rows } = await this.pool.query(
      'SELECT * FROM sync_field_mappings WHERE connection_id = $1 AND external_field = $2',
      [connectionId, externalField],
    );
    if (rows[0]) {
      const existing = rows[0];
      await this.pool.query(
        'UPDATE sync_field_mappings SET board_field = $1, transform = $2, default_value = $3 WHERE id = $4',
        [boardField, transform, defaultValue ?? null, existing.id],
      );
      return { ...existing, boardField, transform, defaultValue };
    }
    const id = `sync-map:${connectionId}:${externalField}`;
    await this.pool.query(
      'INSERT INTO sync_field_mappings (id, connection_id, external_field, board_field, transform, default_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, connectionId, externalField, boardField, transform, defaultValue ?? null],
    );
    return { id, connectionId, externalField, boardField, transform, defaultValue };
  }

  async deleteFieldMapping(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM sync_field_mappings WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getConflictsByConnection(connectionId: string): Promise<SyncConflict[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sync_conflicts WHERE connection_id = $1 ORDER BY created_at DESC',
      [connectionId],
    );
    return rows.map((row: any) => ({
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
    await this.pool.query(`
      INSERT INTO sync_conflicts
      (id, connection_id, external_field, board_field, external_value, board_value,
       resolved_value, resolved_at, resolved_by, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [record.id, record.connectionId, record.externalField, record.boardField,
      record.externalValue ?? null, record.boardValue ?? null,
      record.resolvedValue ?? null, record.resolvedAt ?? null,
      record.resolvedBy ?? null, record.status, record.createdAt, record.updatedAt]);
    return record;
  }

  async resolveConflict(id: string, resolvedValue: string, resolvedBy: string): Promise<SyncConflict | undefined> {
    const now = Date.now();
    const result = await this.pool.query(`
      UPDATE sync_conflicts SET resolved_value = $1, resolved_at = $2, resolved_by = $3,
       status = 'resolved', updated_at = $4 WHERE id = $5
    `, [resolvedValue, now, resolvedBy, now, id]);
    if ((result.rowCount ?? 0) === 0) return undefined;
    const { rows } = await this.pool.query('SELECT * FROM sync_conflicts WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const row = rows[0];
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
    const result = await this.pool.query(
      'UPDATE sync_conflicts SET status = ?, updated_at = ? WHERE id = ?',
      ['ignored', now, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSyncState(connectionId: string): Promise<SyncState | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM sync_state WHERE connection_id = $1', [connectionId]);
    if (!rows[0]) return undefined;
    const row = rows[0];
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
      await this.pool.query(
        'UPDATE sync_state SET last_external_synced_at = $1, last_board_synced_at = $2, sync_count = $3, updated_at = $4 WHERE connection_id = $5',
        [merged.lastExternalSyncedAt ?? null, merged.lastBoardSyncedAt ?? null,
          merged.syncCount, merged.updatedAt, connectionId],
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
    await this.pool.query(
      'INSERT INTO sync_state (id, connection_id, last_external_synced_at, last_board_synced_at, sync_count, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [record.id, record.connectionId, record.lastExternalSyncedAt ?? null,
        record.lastBoardSyncedAt ?? null, record.syncCount, record.updatedAt],
    );
    return record;
  }
}
