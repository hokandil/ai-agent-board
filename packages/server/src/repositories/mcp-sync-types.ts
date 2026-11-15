import type {
  MCPConnectionStatus,
} from '../types.js';

export interface SyncConnection {
  id: string;
  serverId: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  externalTaskTool: string;
  status: MCPConnectionStatus;
  lastSyncAt?: number;
  lastError?: string;
  syncDirection: 'import_only' | 'export_only' | 'bidirectional';
  conflictPolicy: 'board_wins' | 'external_wins' | 'manual';
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

export interface SyncConnectionRecord {
  id: string;
  serverId: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  externalTaskTool: string;
  status: string;
  lastSyncAt?: number;
  lastError?: string;
  syncDirection: string;
  conflictPolicy: string;
  createdAt: number;
  updatedAt: number;
}

export interface SyncRepository {
  // Connections
  getAllConnections(): Promise<SyncConnectionRecord[]>;
  getConnectionById(id: string): Promise<SyncConnectionRecord | undefined>;
  getConnectionByTaskId(taskId: string): Promise<SyncConnectionRecord | undefined>;
  getConnectionByExternalIdentity(
    externalSource: string,
    externalKey: string,
  ): Promise<SyncConnectionRecord | undefined>;
  createConnection(conn: Omit<SyncConnectionRecord, 'createdAt' | 'updatedAt'>): Promise<SyncConnectionRecord>;
  updateConnection(
    id: string,
    updates: Partial<SyncConnectionRecord>,
  ): Promise<SyncConnectionRecord | undefined>;
  deleteConnection(id: string): Promise<boolean>;

  // Field mappings
  getFieldMappingsByConnection(connectionId: string): Promise<SyncFieldMapping[]>;
  upsertFieldMapping(
    connectionId: string,
    externalField: string,
    boardField: string,
    transform: SyncFieldMapping['transform'],
    defaultValue?: string,
  ): Promise<SyncFieldMapping>;
  deleteFieldMapping(id: string): Promise<boolean>;

  // Conflicts
  getConflictsByConnection(connectionId: string): Promise<SyncConflict[]>;
  createConflict(conflict: Omit<SyncConflict, 'id' | 'createdAt' | 'updatedAt'>): Promise<SyncConflict>;
  resolveConflict(
    id: string,
    resolvedValue: string,
    resolvedBy: string,
  ): Promise<SyncConflict | undefined>;
  ignoreConflict(id: string): Promise<boolean>;

  // Sync state
  getSyncState(connectionId: string): Promise<SyncState | undefined>;
  upsertSyncState(
    connectionId: string,
    state: Partial<SyncState>,
  ): Promise<SyncState>;
}

export interface SyncResult {
  connectionId: string;
  syncedAt: number;
  imported: number;
  exported: number;
  conflicts: number;
  errors: Array<{ field: string; message: string }>;
}

export interface SyncEngine {
  sync(connectionId: string): Promise<SyncResult>;
  importTask(connectionId: string): Promise<{ taskId: string; created: boolean }>;
  exportTask(connectionId: string): Promise<{ updated: boolean }>;
}
