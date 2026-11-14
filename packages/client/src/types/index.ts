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
