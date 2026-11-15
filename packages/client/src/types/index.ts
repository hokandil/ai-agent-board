import type { AgentType } from '../../../../shared/types.js';

// Re-export all types and constants from the shared module
export type {
  Priority,
  ColumnId,
  AgentStatus,
  AgentType,
  AgentInfo,
  Project,
  ProjectTaskCounts,
  ProjectConfig,
  ProjectPathValidation,
  GitHubAuthStatus,
  ProjectRepoStatus,
  ProjectRepoStatusResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  Task,
  TaskAttachment,
  TaskGroup,
  TaskTemplate,
  AgentEventType,
  AgentEvent,
  Column,
  WSMessage,
} from '../../../../shared/types.js';

export { VALID_TRANSITIONS, MAX_GROUP_CHILDREN, MIN_GROUP_CHILDREN } from '../../../../shared/constants.js';

// ─── MCP types ───────────────────────────────────────────────────────────────

export type MCPTransportType = 'stdio' | 'streamable-http' | 'sse';

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface MCPServer {
  id: string;
  name: string;
  transport: MCPTransportType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  status: MCPConnectionStatus;
  last_connected_at?: number;
  last_error?: string;
  created_at: number;
  updated_at: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface MCPListToolsResult {
  tools: MCPTool[];
}

export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface MCPPermission {
  id: string;
  serverId: string;
  agentType: string;
  toolName: string;
  allowed: boolean;
}

// ─── MCP Sync types ──────────────────────────────────────────────────────

export type SyncDirection = 'import_only' | 'export_only' | 'bidirectional';
export type ConflictPolicy = 'board_wins' | 'external_wins' | 'manual';
export type SyncConnectionStatus = 'connected' | 'error' | 'disconnected';

export interface SyncConnection {
  id: string;
  serverId: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  externalTaskTool: string;
  status: SyncConnectionStatus;
  lastSyncAt?: number;
  lastError?: string;
  syncDirection: SyncDirection;
  conflictPolicy: ConflictPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface SyncFieldMapping {
  id: string;
  connectionId: string;
  externalField: string;
  boardField: string;
  transform: 'identity' | 'lowercase' | 'uppercase' | 'capitalize' | 'trim';
  defaultValue?: string;
}

export interface SyncConflict {
  id: string;
  connectionId: string;
  externalField: string;
  boardField: string;
  externalValue?: string;
  boardValue?: string;
  resolvedValue?: string;
  resolvedAt?: number;
  resolvedBy?: string;
  status: 'pending' | 'resolved' | 'ignored';
  createdAt: number;
  updatedAt: number;
}

export interface SyncState {
  id: string;
  connectionId: string;
  lastExternalSyncedAt?: number;
  lastBoardSyncedAt?: number;
  syncCount: number;
  updatedAt: number;
}

export interface SyncResult {
  connectionId: string;
  syncedAt: number;
  imported: number;
  exported: number;
  conflicts: number;
  errors: Array<{ field: string; message: string }>;
}

// ─── Agent Session types ─────────────────────────────────────────────────

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

// ─── PTY Session types ──────────────────────────────────────────────────────

export type PtySessionStatus = 'idle' | 'running' | 'exited' | 'closed';

export interface PtySession {
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




