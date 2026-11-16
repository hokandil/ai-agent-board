export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ColumnId = 'backlog' | 'in-progress' | 'review' | 'done';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete' | 'failed';
export type AgentType = 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes' | 'openclaw' | 'grok';

export interface AgentInfo {
  name: AgentType;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  columnId: ColumnId;
  agentStatus: AgentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  worktreePath?: string;
  agentType?: AgentType;
  archived?: boolean;
  groupId?: string;
  groupOrder?: number;
  attachments?: TaskAttachment[];
  projectId: string;
  summary?: string | null;
  runRequestedAt?: number;
  runClaimedAt?: number;
  externalSource?: string;
  externalKey?: string;
  provenance?: TaskProvenance;
  externalPRUrl?: string;
  externalPRNumber?: number;
  reviewStatus?: "pending" | "approved" | "changes_requested";
  /** Optional execution limit for this task. Omit to use the server default. */
  timeoutMinutes?: number | null;
  /** Provider-side session/conversation id from the last agent run, persisted so
   *  the session can be identified durably and resumed where the provider supports it. */
  agentSessionId?: string | null;
  /** The agent profile this task was assigned to. */
  agentProfileId?: string | null;
  /** Snapshot of the resolved agent profile configuration at task creation time.
   *  Stored so a task keeps using its original configuration even if the profile
   *  is later edited. */
  agentProfileSnapshot?: AgentProfile | null;
}

/** A user-defined agent profile: a reusable configuration referencing an
 *  installed execution provider plus model, persona/instructions, MCP servers
 *  and skills. */
export interface AgentProfile {
  id: string;
  name: string;
  provider: AgentType;
  model?: string | null;
  instructions?: string | null;
  /** Custom executable/command path for providers whose adapter accepts one (hermes/openclaw/grok). */
  command?: string | null;
  mcpServerIds: string[];
  skillIds: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A discovered local skill (Agent Skills convention: <root>/<name>/SKILL.md).
 *  Profile skillIds reference skills by this `name`. */
export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  path: string;
}

/** Per-provider model configuration surfaced honestly to the UI. */
export interface AgentModelInfo {
  /** The actual configured default model per provider; null when none is set. */
  defaultModels: Partial<Record<AgentType, string | null>>;
  /** Convenience model IDs to suggest; availability is not guaranteed. */
  suggestedModels: Record<AgentType, string[]>;
}

/** How a provider accepts model selection (mirrors the server capability matrix).
 *  - 'session': the saved model is forwarded per run and takes effect now.
 *  - 'startup': model is fixed at provider construction (server restart required).
 *  - 'native': the provider reads its own model config; Board selection does not apply. */
export type ModelDelivery = 'session' | 'startup' | 'native';

/** Ground-truth per-provider capabilities that drive which controls the UI renders. */
export interface ProviderCapabilities {
  model: ModelDelivery;
  commandConfigurable: boolean;
  instructions: boolean;
  mcp: boolean;
  skills: boolean;
  limitations: string[];
}

/** One executor for the Agents management screen: detection + supported config + saved config. */
export interface ManagedAgent {
  provider: AgentType;
  detection: AgentInfo | null;
  capabilities: ProviderCapabilities;
  config: AgentProfile | null;
}

/** Input for saving an executor's configuration. */
export interface AgentConfigInput {
  model?: string | null;
  instructions?: string | null;
  command?: string | null;
  mcpServerIds?: string[];
  skillIds?: string[];
  enabled?: boolean;
}

/** A first-class link between two durable Board work items. */
export interface TaskRelationship {
  taskId: string;
  relatedTaskId: string;
  type: 'related';
  createdAt: number;
}

/** Immutable request snapshot for one execution of a durable Board card. */
export interface ExecutionAttempt {
  id: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  titleSnapshot: string;
  descriptionSnapshot: string;
  agentType: AgentType;
  relatedTaskId?: string;
  autoStart: boolean;
  timeoutMinutes?: number | null;
  /** Canonical JSON of every material orchestration request field. */
  requestSnapshot: string;
  status: 'pending' | 'dispatched';
  createdAt: number;
}

export interface TaskProvenance {
  sourceProfile?: string;
  sourcePlatform?: string;
  sourceSession?: string;
  sourceMessage?: string;
  sourceTask?: string;
  requestedBy?: string;
  origin?: Record<string, string | number | boolean | null>;
}

export interface TaskGroup {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  columnId: ColumnId;
  repoPath?: string;
  baseBranch?: string;
  maxConcurrency: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  archived?: boolean;
  projectId: string;
}

export interface ProjectTaskCounts {
  backlog: number;
  'in-progress': number;
  review: number;
  done: number;
  total: number;
}

export interface Project {
  id: string;
  name: string;
  repoPath?: string;
  /** Source GitHub/git URL the project's local repo was cloned from, if any. */
  repoUrl?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  taskCounts?: ProjectTaskCounts;
  /** Default task properties for this project. Each is overridable per task. */
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
}

export interface CreateProjectRequest {
  name?: string;
  repoPath?: string;
  /** When provided, the server clones this git URL into the configured clone root and uses it as repoPath. */
  repoUrl?: string;
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string | null;
  repoUrl?: string | null;
  defaultAgentType?: AgentType | null;
  defaultPriority?: Priority | null;
  defaultBaseBranch?: string | null;
  defaultUseWorktree?: boolean | null;
  aliases?: string[];
}

/** Server-side Agent Board configuration (persisted to the config file). */
export interface ProjectConfig {
  /** Absolute path under which repos cloned from a URL are placed. */
  cloneRoot: string;
}

export interface ProjectPathValidation {
  repoPath: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  /** Detected `origin` remote of the checkout, when it is a git repository. */
  remoteUrl?: string;
  /** True when the detected remote points at github.com. */
  isGitHubRemote?: boolean;
  error?: string;
  warning?: string;
}

/** GitHub CLI availability / authentication state for this host. */
export interface GitHubAuthStatus {
  cliAvailable: boolean;
  authenticated: boolean;
  login: string | null;
  error?: string;
}

/** Per-project repository facts reported by GET /api/projects/repo-status. */
export interface ProjectRepoStatus {
  repoPath?: string;
  isGitRepo: boolean;
  /** Remote detected from the local checkout (not a verified GitHub link). */
  remoteUrl: string | null;
  isGitHubRemote: boolean;
  branch: string | null;
}

export interface ProjectRepoStatusResponse {
  statuses: Record<string, ProjectRepoStatus>;
  github: GitHubAuthStatus;
}

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
  | 'error'
  | 'complete'
  | 'audit_log'
  | 'permission_request';

export type SessionStatus = 'idle' | 'planning' | 'executing' | 'complete' | 'failed' | 'stopped';

export interface AgentSession {
  id: string;
  taskId?: string;
  agentType: AgentType;
  status: SessionStatus;
  model?: string;
  worktreePath?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
}

export interface CreateSessionRequest {
  agentType: AgentType;
  taskId?: string;
  model?: string;
  useWorktree?: boolean;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
}

export interface StartSessionRequest {
  taskId?: string;
}

export interface SessionConcurrencyLimits {
  perProvider?: Partial<Record<AgentType, number>>;
  perProject?: Partial<Record<string, number>>;
  global?: number;
}

export interface AgentEvent {
  id: string;
  taskId?: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: {
    file?: string;
    fileEventType?: string;
    language?: string;
    command?: string;
    diff?: string;
    agentType?: AgentType;
    duration?: number;
    error?: string;
    /** Persisted, complete assistant prose used by service integrations. */
    finalOutput?: boolean;
    /** Interactive permission request (type 'permission_request'). */
    permissionRequestId?: string;
    permissionKind?: string;
    permissionTool?: string;
    /** Set on the follow-up event once the request is resolved. */
    permissionDecision?: 'approved' | 'denied' | 'expired' | 'cancelled';
  };
}

export interface Column {
  id: ColumnId;
  title: string;
  color: string;
  icon: string;
}

export interface AgentCompletePayload {
  taskId: string;
  status: 'complete' | 'failed';
  agentType?: AgentType;
  duration: number;
  eventCount: number;
}

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: Priority;
  agentType: AgentType;
  repoPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  createdAt: number;
}

export interface AgentFollowUpPayload {
  taskId: string;
  message: string;
  attachmentIds?: string[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export type WSMessage =
  | { type: 'agent_event'; payload: AgentEvent }
  | { type: 'task_updated'; payload: Task }
  | { type: 'task_deleted'; payload: { id: string } }
  | { type: 'agent_complete'; payload: AgentCompletePayload }
  | { type: 'agent_follow_up'; payload: AgentFollowUpPayload }
  | { type: 'group_updated'; payload: TaskGroup }
  | { type: 'project_updated'; payload: Project }
  | { type: 'project_deleted'; payload: { id: string } };
