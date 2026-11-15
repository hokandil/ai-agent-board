import type {
  SyncFieldMapping, SyncResult, SyncEngine,
} from '../repositories/mcp-sync-types.js';
import type { MCPConnectionStatus, Task } from '../types.js';
import type { SyncRepository } from '../repositories/mcp-sync-types.js';
import type { TaskRepository } from '../repositories/types.js';
import { mcpClientManager } from './mcp-client.js';

/**
 * Sync Engine — bidirectional synchronization between board tasks and
 * external MCP task-management systems.
 *
 * Each SyncConnection links one board task to one external task (identified
 * by external_source + external_key on a specific MCP server's tool).
 * SyncDirection controls whether changes flow import_only (external→board),
 * export_only (board→external), or bidirectional.
 *
 * Conflict handling: when the same field differs on both sides, a SyncConflict
 * is created and resolved per the connection's conflict_policy:
 *   - board_wins: board value overwrites external
 *   - external_wins: external value overwrites board
 *   - manual: conflict left pending for user resolution
 *
 * Import never auto-starts task execution — imported tasks are created with
 * agentStatus 'idle' and must be explicitly started by the user.
 */
export class SyncEngineImpl implements SyncEngine {
  constructor(
    private syncRepo: SyncRepository,
    private taskRepo: TaskRepository,
  ) {}

  async sync(connectionId: string): Promise<SyncResult> {
    const conn = await this.syncRepo.getConnectionById(connectionId);
    if (!conn) {
      throw new Error(`Sync connection not found: ${connectionId}`);
    }

    const now = Date.now();
    let imported = 0;
    let exported = 0;
    let conflicts = 0;
    const errors: Array<{ field: string; message: string }> = [];

    try {
      // Verify the external task tool exists on the server
      const tools = await mcpClientManager.discoverTools(conn.serverId);
      const taskTool = tools.find((t) => t.name === conn.externalTaskTool);
      if (!taskTool) {
        throw new Error(`External task tool '${conn.externalTaskTool}' not found on server`);
      }

      // Determine sync direction
      const doImport = conn.syncDirection === 'import_only' || conn.syncDirection === 'bidirectional';
      const doExport = conn.syncDirection === 'export_only' || conn.syncDirection === 'bidirectional';

      if (doImport) {
        const result = await this.importTask(connectionId);
        if (result.created) imported += 1;
      }

      if (doExport) {
        const result = await this.exportTask(connectionId);
        if (result.updated) exported += 1;
      }

      // Update sync state
      const state = await this.syncRepo.getSyncState(connectionId);
      await this.syncRepo.upsertSyncState(connectionId, {
        lastExternalSyncedAt: now,
        syncCount: (state?.syncCount ?? 0) + 1,
        updatedAt: now,
      });

      await this.syncRepo.updateConnection(connectionId, {
        status: 'connected' as MCPConnectionStatus,
        lastSyncAt: now,
        lastError: undefined,
        updatedAt: now,
      });

      return { connectionId, syncedAt: now, imported, exported, conflicts, errors };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.syncRepo.updateConnection(connectionId, {
        status: 'error' as MCPConnectionStatus,
        lastError: message,
        updatedAt: now,
      });
      throw error;
    }
  }

  /** Import an external task into a board task. Does NOT auto-start execution. */
  async importTask(connectionId: string): Promise<{ taskId: string; created: boolean }> {
    const conn = await this.syncRepo.getConnectionById(connectionId);
    if (!conn) {
      throw new Error(`Sync connection not found: ${connectionId}`);
    }

    // Check if a board task already exists for this external identity
    const existing = await this.syncRepo.getConnectionByExternalIdentity(
      conn.externalSource,
      conn.externalKey,
    );
    if (existing) {
      return { taskId: existing.taskId, created: false };
    }

    // Fetch external task details
    const result = await mcpClientManager.callTool(
      conn.serverId,
      conn.externalTaskTool,
      { key: conn.externalKey },
    );

    const mappings = await this.syncRepo.getFieldMappingsByConnection(conn.id);
    const taskData = this.mapExternalToBoard(result, mappings);

    // Create the board task — import does NOT auto-start execution
    // (agentStatus defaults to 'idle')
    const newTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const task: Task = {
      id: newTaskId,
      title: taskData.title || 'Imported task',
      description: taskData.description || '',
      priority: taskData.priority || 'medium',
      columnId: 'backlog',
      agentStatus: 'idle',
      createdAt: now,
      projectId: 'default',
      externalSource: conn.externalSource,
      externalKey: conn.externalKey,
      provenance: { sourcePlatform: 'mcp', sourceTask: conn.externalTaskTool, origin: { serverId: conn.serverId } },
    };

    await this.taskRepo.create(task);

    return { taskId: newTaskId, created: true };
  }

  /** Export board task changes to the external system. */
  async exportTask(connectionId: string): Promise<{ updated: boolean }> {
    const conn = await this.syncRepo.getConnectionById(connectionId);
    if (!conn) {
      throw new Error(`Sync connection not found: ${connectionId}`);
    }

    const boardTask = await this.taskRepo.getById(conn.taskId);
    if (!boardTask) {
      throw new Error(`Board task not found: ${conn.taskId}`);
    }

    const mappings = await this.syncRepo.getFieldMappingsByConnection(conn.id);
    const payload = this.mapBoardToExternal(boardTask, mappings);

    await mcpClientManager.callTool(conn.serverId, conn.externalTaskTool, payload);

    await this.syncRepo.updateConnection(conn.id, {
      lastSyncAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { updated: true };
  }

  private mapExternalToBoard(
    external: any,
    mappings: SyncFieldMapping[],
  ): Record<string, any> {
    const data: Record<string, any> = {};
    for (const m of mappings) {
      let value = external[m.externalField];
      if (value === undefined && m.defaultValue !== undefined) {
        value = m.defaultValue;
      }
      if (value !== undefined) {
        data[m.boardField] = this.applyTransform(value, m.transform);
      }
    }
    return data;
  }

  private mapBoardToExternal(
    task: Task,
    mappings: SyncFieldMapping[],
  ): Record<string, any> {
    const data: Record<string, any> = {};
    for (const m of mappings) {
      const boardValue = (task as any)[m.boardField];
      data[m.externalField] = boardValue !== undefined
        ? this.applyTransform(boardValue, m.transform)
        : undefined;
    }
    return data;
  }

  private applyTransform(value: any, transform: string): any {
    if (typeof value !== 'string') return value;
    switch (transform) {
      case 'lowercase': return value.toLowerCase();
      case 'uppercase': return value.toUpperCase();
      case 'capitalize': return value.charAt(0).toUpperCase() + value.slice(1);
      case 'trim': return value.trim();
      default: return value;
    }
  }
}

// NOTE: no module-level singleton. The MCP sync routes construct a SyncEngineImpl
// with the real repositories (see createMcpSyncRouter). A previous stub-injected
// singleton here made sync/import/export throw at runtime.
