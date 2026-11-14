import type { MCPTool } from '../types.js';

export interface MCPServerRecord {
  id: string;
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  status: string;
  last_connected_at?: number;
  last_error?: string;
  created_at: number;
  updated_at: number;
}

export interface MCPToolRecord {
  id: string;
  server_id: string;
  name: string;
  description: string;
  input_schema: unknown;
  output_schema?: unknown;
  annotations?: unknown;
  discovered_at: number;
}

export interface MCPPermissionRecord {
  id: string;
  server_id: string;
  agent_type: string;
  tool_name: string;
  allowed: boolean;
}

export interface MCPRepository {
  // Server CRUD
  getAllServers(): Promise<MCPServerRecord[]>;
  getServerById(id: string): Promise<MCPServerRecord | undefined>;
  createServer(server: Omit<MCPServerRecord, 'created_at' | 'updated_at'>): Promise<MCPServerRecord>;
  updateServer(id: string, updates: Partial<MCPServerRecord>): Promise<MCPServerRecord | undefined>;
  deleteServer(id: string): Promise<boolean>;

  // Tool catalog
  getToolsByServer(serverId: string): Promise<MCPToolRecord[]>;
  upsertTools(serverId: string, tools: MCPTool[]): Promise<void>;
  deleteToolsByServer(serverId: string): Promise<void>;

  // Permissions
  getPermissionsByServer(serverId: string): Promise<MCPPermissionRecord[]>;
  getPermission(serverId: string, agentType: string, toolName: string): Promise<MCPPermissionRecord | undefined>;
  setPermission(serverId: string, agentType: string, toolName: string, allowed: boolean): Promise<MCPPermissionRecord>;
  deletePermission(serverId: string, agentType: string, toolName: string): Promise<boolean>;

  // Permission check
  isToolAllowed(serverId: string, agentType: string, toolName: string): Promise<boolean>;
}
