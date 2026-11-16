import type { AgentProfile } from '@ai-agent-board/shared/types.js';
import type { Task, AgentEvent, TaskRelationship, ExecutionAttempt, AgentType } from '../types.js';

export interface OrchestrationAggregateResult {
  task: Task;
  attempt: ExecutionAttempt;
  created: boolean;
}

export interface ContinuationEligibility {
  /** Revalidated while the task is locked, not from a stale route read. */
  requiredAgentStatus?: Task['agentStatus'];
  /** Reject a second dispatch while a durable run request is outstanding. */
  requireRunnable?: boolean;
}

export interface TaskRepository {
  getAll(includeArchived?: boolean, projectId?: string): Promise<Task[]>;
  getById(id: string): Promise<Task | undefined>;
  getByExternalIdentity(source: string, key: string): Promise<Task | undefined>;
  /** Resolve an exact id first, otherwise exact title matches in one project. */
  resolve(reference: string, projectId: string): Promise<Task[]>;
  create(task: Task): Promise<Task>;
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
  requestRun(id: string, requestedAt: number): Promise<Task | undefined>;
  claimRun(id: string, claimedAt: number): Promise<Task | undefined>;
  clearRun(id: string): Promise<Task | undefined>;
  getPendingRuns(staleBefore?: number): Promise<Task[]>;
  update(id: string, updates: Partial<Task>): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  // Agent profile CRUD
  getAgentProfile(id: string): Promise<AgentProfile | undefined>;
  getAllAgentProfiles(): Promise<AgentProfile[]>;
  /** The enabled saved configuration for a given execution provider, if any.
   *  Used to resolve per-executor configuration from the single Agent selector. */
  getAgentProfileByProvider(provider: AgentType): Promise<AgentProfile | undefined>;
  createAgentProfile(profile: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgentProfile>;
  updateAgentProfile(id: string, updates: Partial<Pick<AgentProfile, 'name' | 'provider' | 'model' | 'instructions' | 'command' | 'mcpServerIds' | 'skillIds' | 'enabled'>>): Promise<AgentProfile | undefined>;
  deleteAgentProfile(id: string): Promise<boolean>;
  insertEvent(event: AgentEvent): Promise<void>;
  getEventsByTaskId(taskId: string): Promise<AgentEvent[]>;
  deleteEventsByTaskId(taskId: string): Promise<void>;
  getArchivedTasks(projectId?: string): Promise<Task[]>;
  getRelationships(taskId: string): Promise<TaskRelationship[]>;
  createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }>;
  deleteRelationship(taskId: string, relatedTaskId: string): Promise<boolean>;
  getAttemptById(id: string): Promise<ExecutionAttempt | undefined>;
  getAttemptByExternalIdentity(source: string, key: string): Promise<ExecutionAttempt | undefined>;
  getAttemptsByTaskId(taskId: string): Promise<ExecutionAttempt[]>;
  createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }>;
  /** Atomically persist a new task, its first attempt, and optional relationship. */
  createOrchestration(task: Task, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt?: number): Promise<OrchestrationAggregateResult>;
  /** Atomically persist an attempt, optional relationship, task reset, and run request. */
  continueOrchestration(taskId: string, updates: Partial<Task>, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt?: number, eligibility?: ContinuationEligibility): Promise<OrchestrationAggregateResult | undefined>;
}
