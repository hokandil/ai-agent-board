import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SyncConnectionRecord } from '../repositories/mcp-sync-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { MCPRepository } from '../repositories/mcp-types.js';
import type { SyncRepository } from '../repositories/mcp-sync-types.js';
import type { AuditLogger } from '../services/audit-logger.js';
import type { MCPTool } from '../types.js';
import type { MCPToolCallResultRaw } from '../services/mcp-client.js';
import { SyncEngineImpl } from '../services/mcp-sync.js';
import { mcpClientManager } from '../services/mcp-client.js';
import {
  extractTaskRecords,
  externalSourceForServer,
  mapExternalPriority,
  mapExternalStatus,
  normalizeExternalTask,
  resultText,
} from '../services/mcp-import.js';
import { isValidColumnId, isValidPriority } from '@ai-agent-board/shared/constants.js';
import { asyncHandler, broadcastTaskUpdate, buildTask } from './helpers.js';

type FullRepo = TaskRepository & MCPRepository & SyncRepository;

const PREVIEW_LIMIT = 200;

export function createMcpSyncRouter(
  repo: FullRepo,
  projectRepo: ProjectRepository,
  auditLogger: AuditLogger,
): Router {
  const router = Router();
  // Construct the sync engine with the real repositories. (Previously a module-level
  // singleton was built with stub repos, so sync/import/export threw at runtime.)
  const syncEngine = new SyncEngineImpl(repo, repo);

  // ─── Task Import (external → board) ──────────────────────────────────
  //
  // Import works without an existing board task: a tool discovered over MCP is
  // invoked read-only, its records are normalized, and the user picks which ones
  // become board tasks. Each created task gets a sync connection so the existing
  // manual linking/sync flows keep working for it.

  // POST /api/mcp/sync/import/preview — call a listing tool and normalize results
  router.post('/import/preview', asyncHandler(async (req: Request, res: Response) => {
    const { serverId, toolName, arguments: toolArgs, externalSource } = req.body ?? {};

    if (typeof serverId !== 'string' || !serverId) {
      res.status(400).json({ error: 'serverId is required' }); return;
    }
    if (typeof toolName !== 'string' || !toolName) {
      res.status(400).json({ error: 'toolName is required' }); return;
    }
    if (toolArgs !== undefined && (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs))) {
      res.status(400).json({ error: 'arguments must be an object' }); return;
    }

    const server = await repo.getServerById(serverId);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    if (!mcpClientManager.isConnected(serverId)) {
      res.status(409).json({
        error: `MCP server "${server.name}" is not connected. Connect it (and complete OAuth if required) on the MCP Servers page, then retry.`,
      });
      return;
    }

    let tools: MCPTool[];
    try {
      tools = await mcpClientManager.discoverTools(serverId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: `Failed to discover tools: ${message}` }); return;
    }

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      res.status(404).json({
        error: `MCP tool "${toolName}" was not found on server "${server.name}".`,
      });
      return;
    }

    let result: MCPToolCallResultRaw;
    try {
      result = await mcpClientManager.callTool(serverId, toolName, toolArgs ?? {});
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await auditLogger.logMcpEvent(serverId, 'mcp.tool.call', undefined, undefined, {
        tool: toolName, error: message, context: 'sync.import.preview',
      });
      res.status(502).json({ error: `Tool call failed: ${message}` }); return;
    }

    await auditLogger.logMcpEvent(serverId, 'mcp.tool.call', undefined, undefined, {
      tool: toolName, context: 'sync.import.preview',
    });

    if (result?.isError) {
      const detail = resultText(result);
      res.status(422).json({
        error: detail
          ? `Tool "${toolName}" returned an error: ${detail}`
          : `Tool "${toolName}" returned an error. Check the tool arguments and schema.`,
      });
      return;
    }

    const found = extractTaskRecords(result);
    const source = typeof externalSource === 'string' && externalSource.trim()
      ? externalSource.trim()
      : externalSourceForServer(server.name);

    if (!found || found.records.length === 0) {
      res.json({
        toolName,
        externalSource: source,
        tasks: [],
        limitation:
          `Tool "${toolName}" did not return recognizable task records. `
          + 'Choose a listing tool that returns objects with an id and title, or inspect the tool output first.',
      });
      return;
    }

    const tasks: Array<Record<string, unknown>> = [];
    for (const record of found.records.slice(0, PREVIEW_LIMIT)) {
      const normalized = normalizeExternalTask(record);
      if (!normalized) continue;
      const existingConnection = await repo.getConnectionByExternalIdentity(source, normalized.externalKey);
      const existingTask = existingConnection
        ? undefined
        : await repo.getByExternalIdentity(source, normalized.externalKey);
      const existingTaskId = existingConnection?.taskId ?? existingTask?.id;
      tasks.push({
        ...normalized,
        alreadyImported: Boolean(existingTaskId),
        existingTaskId,
      });
    }

    if (tasks.length === 0) {
      res.json({
        toolName,
        externalSource: source,
        tasks: [],
        limitation:
          `Tool "${toolName}" returned ${found.records.length} record(s), but none included both an id and a title. `
          + 'Pick a tool that lists tasks with those fields.',
      });
      return;
    }

    res.json({ toolName, externalSource: source, tasks, recordLocation: found.location });
  }));

  // POST /api/mcp/sync/import — create board tasks for selected external records
  router.post('/import', asyncHandler(async (req: Request, res: Response) => {
    const { serverId, projectId, toolName, externalSource, tasks: selected } = req.body ?? {};

    if (typeof serverId !== 'string' || !serverId) {
      res.status(400).json({ error: 'serverId is required' }); return;
    }
    if (typeof toolName !== 'string' || !toolName) {
      res.status(400).json({ error: 'toolName is required' }); return;
    }
    if (!Array.isArray(selected) || selected.length === 0) {
      res.status(400).json({ error: 'tasks must be a non-empty array' }); return;
    }
    if (selected.length > 100) {
      res.status(400).json({ error: 'import limit is 100 tasks' }); return;
    }

    const project = await projectRepo.getById(typeof projectId === 'string' ? projectId : 'default');
    if (!project) { res.status(400).json({ error: 'projectId is invalid' }); return; }

    const server = await repo.getServerById(serverId);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      if (!item || typeof item !== 'object') {
        res.status(400).json({ error: `tasks[${i}] must be an object` }); return;
      }
      if (typeof item.externalKey !== 'string' || !item.externalKey.trim()) {
        res.status(400).json({ error: `tasks[${i}].externalKey is required` }); return;
      }
      if (typeof item.title !== 'string' || !item.title.trim()) {
        res.status(400).json({ error: `tasks[${i}].title is required` }); return;
      }
    }

    const source = typeof externalSource === 'string' && externalSource.trim()
      ? externalSource.trim()
      : externalSourceForServer(server.name);

    const imported: Array<{ taskId: string; externalKey: string; connectionId: string }> = [];
    const skipped: Array<{ externalKey: string; reason: string; taskId?: string }> = [];

    for (const item of selected) {
      const externalKey = String(item.externalKey).trim();
      const title = String(item.title).trim();

      const existingConnection = await repo.getConnectionByExternalIdentity(source, externalKey);
      const existingTask = existingConnection
        ? undefined
        : await repo.getByExternalIdentity(source, externalKey);
      const existingTaskId = existingConnection?.taskId ?? existingTask?.id;
      if (existingTaskId) {
        skipped.push({ externalKey, reason: 'already_imported', taskId: existingTaskId });
        continue;
      }

      const columnId = isValidColumnId(item.columnId)
        ? item.columnId
        : mapExternalStatus(typeof item.status === 'string' ? item.status : undefined);
      const priority = isValidPriority(item.priority)
        ? item.priority
        : mapExternalPriority(typeof item.priority === 'string' ? item.priority : undefined);

      const task = buildTask({
        title,
        description: typeof item.description === 'string' ? item.description : '',
        priority,
        columnId,
        projectId: project.id,
        externalSource: source,
        externalKey,
        provenance: {
          sourcePlatform: 'mcp',
          sourceTask: toolName,
          origin: { serverId, tool: toolName },
        },
      });

      const creation = await repo.createIdempotent(task);
      if (!creation.created) {
        skipped.push({ externalKey, reason: 'already_imported', taskId: creation.task.id });
        continue;
      }

      const now = Date.now();
      const connectionId = `mcp-sync:${randomUUID()}`;
      const connection: SyncConnectionRecord = {
        id: connectionId,
        serverId,
        taskId: creation.task.id,
        externalSource: source,
        externalKey,
        externalTaskTool: toolName,
        status: 'connected',
        lastSyncAt: now,
        syncDirection: 'import_only',
        conflictPolicy: 'board_wins',
        createdAt: now,
        updatedAt: now,
      };
      await repo.createConnection(connection);
      broadcastTaskUpdate(creation.task);
      await auditLogger.logSyncEvent(connectionId, 'mcp.sync.import', undefined, undefined, {
        serverId, taskId: creation.task.id, externalSource: source, externalKey, toolName,
        context: 'sync.import.batch',
      });

      imported.push({ taskId: creation.task.id, externalKey, connectionId });
    }

    res.status(201).json({ externalSource: source, imported, skipped });
  }));

  // ─── Sync Connection CRUD ─────────────────────────────────────────────

  // GET /api/mcp/sync/connections — list all sync connections
  router.get('/connections', asyncHandler(async (_req: Request, res: Response) => {
    const connections = await repo.getAllConnections();
    res.json(connections);
  }));

  // GET /api/mcp/sync/connections/:id — get a specific connection
  router.get('/connections/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }
    res.json(conn);
  }));

  // POST /api/mcp/sync/connections — create a sync connection
  router.post('/connections', asyncHandler(async (req: Request, res: Response) => {
    const { serverId, taskId, externalSource, externalKey, externalTaskTool,
      syncDirection, conflictPolicy } = req.body;

    if (!serverId || !taskId || !externalSource || !externalKey || !externalTaskTool) {
      res.status(400).json({ error: 'serverId, taskId, externalSource, externalKey, and externalTaskTool are required' }); return;
    }

    // Check for duplicate external identity
    const existing = await repo.getConnectionByExternalIdentity(externalSource, externalKey);
    if (existing) {
      res.status(409).json({ error: 'A sync connection already exists for this external task' }); return;
    }

    // Check for duplicate task mapping
    const existingTask = await repo.getConnectionByTaskId(taskId);
    if (existingTask) {
      res.status(409).json({ error: 'This task already has a sync connection' }); return;
    }

    const id = `mcp-sync:${randomUUID()}`;
    const now = Date.now();
    const conn: SyncConnectionRecord = {
      id, serverId, taskId, externalSource, externalKey, externalTaskTool,
      status: 'connected',
      lastSyncAt: undefined, lastError: undefined,
      syncDirection: syncDirection ?? 'bidirectional',
      conflictPolicy: conflictPolicy ?? 'board_wins',
      createdAt: now, updatedAt: now,
    };

    const created = await repo.createConnection(conn);
    await auditLogger.logSyncEvent(id, 'mcp.sync.create', undefined, undefined, { serverId, taskId, externalSource, externalKey });
    res.status(201).json(created);
  }));

  // PUT /api/mcp/sync/connections/:id — update an existing sync connection
  router.put('/connections/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }

    const { serverId, taskId, externalSource, externalKey, externalTaskTool,
      syncDirection, conflictPolicy } = req.body;

    const nextTaskId = taskId ?? conn.taskId;
    const nextSource = externalSource ?? conn.externalSource;
    const nextKey = externalKey ?? conn.externalKey;

    if (!nextTaskId || !nextSource || !nextKey) {
      res.status(400).json({ error: 'taskId, externalSource and externalKey are required' }); return;
    }

    // Reject a mapping that would collide with a different connection.
    const byIdentity = await repo.getConnectionByExternalIdentity(nextSource, nextKey);
    if (byIdentity && byIdentity.id !== id) {
      res.status(409).json({ error: 'A sync connection already exists for this external task' }); return;
    }
    const byTask = await repo.getConnectionByTaskId(nextTaskId);
    if (byTask && byTask.id !== id) {
      res.status(409).json({ error: 'This task already has a sync connection' }); return;
    }

    const updates: Partial<SyncConnectionRecord> = {
      serverId: serverId ?? conn.serverId,
      taskId: nextTaskId,
      externalSource: nextSource,
      externalKey: nextKey,
      externalTaskTool: externalTaskTool ?? conn.externalTaskTool,
      syncDirection: syncDirection ?? conn.syncDirection,
      conflictPolicy: conflictPolicy ?? conn.conflictPolicy,
    };

    const updated = await repo.updateConnection(id, updates);
    if (!updated) { res.status(500).json({ error: 'Failed to update sync connection' }); return; }
    await auditLogger.logSyncEvent(id, 'mcp.sync.update', undefined, undefined, {
      serverId: updates.serverId, taskId: nextTaskId, externalSource: nextSource, externalKey: nextKey,
    });
    res.json(updated);
  }));

  // POST /api/mcp/sync/connections/:id/sync — trigger a sync
  router.post('/connections/:id/sync', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }

    try {
      const result = await syncEngine.sync(id);
      await auditLogger.logSyncEvent(id, 'mcp.sync.run', undefined, undefined, { result });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Sync failed: ${message}` });
    }
  }));

  // POST /api/mcp/sync/connections/:id/import — import external task
  router.post('/connections/:id/import', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }

    try {
      const result = await syncEngine.importTask(id);
      await auditLogger.logSyncEvent(id, 'mcp.sync.import', undefined, undefined, { result });
      res.status(201).json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Import failed: ${message}` });
    }
  }));

  // POST /api/mcp/sync/connections/:id/export — export board task to external
  router.post('/connections/:id/export', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }

    try {
      const result = await syncEngine.exportTask(id);
      await auditLogger.logSyncEvent(id, 'mcp.sync.export', undefined, undefined, { result });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Export failed: ${message}` });
    }
  }));

  // DELETE /api/mcp/sync/connections/:id — delete a sync connection
  router.delete('/connections/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const deleted = await repo.deleteConnection(id);
    if (!deleted) { res.status(404).json({ error: 'Sync connection not found' }); return; }
    await auditLogger.logSyncEvent(id, 'mcp.sync.create', undefined, undefined, { action: 'delete_connection' });
    res.status(204).end();
  }));

  // ─── Field Mappings ───────────────────────────────────────────────────

  // GET /api/mcp/sync/connections/:id/mappings — list field mappings
  router.get('/connections/:id/mappings', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const mappings = await repo.getFieldMappingsByConnection(id);
    res.json(mappings);
  }));

  // POST /api/mcp/sync/connections/:id/mappings — create a field mapping
  router.post('/connections/:id/mappings', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { externalField, boardField, transform, defaultValue } = req.body;

    if (!externalField || !boardField) {
      res.status(400).json({ error: 'externalField and boardField are required' }); return;
    }

    const mapping = await repo.upsertFieldMapping(id, externalField, boardField, transform ?? 'identity', defaultValue);
    res.status(201).json(mapping);
  }));

  // DELETE /api/mcp/sync/mappings/:id — delete a field mapping
  router.delete('/mappings/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const deleted = await repo.deleteFieldMapping(id);
    if (!deleted) { res.status(404).json({ error: 'Field mapping not found' }); return; }
    res.status(204).end();
  }));

  // ─── Conflicts ────────────────────────────────────────────────────────

  // GET /api/mcp/sync/connections/:id/conflicts — list conflicts
  router.get('/connections/:id/conflicts', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conflicts = await repo.getConflictsByConnection(id);
    res.json(conflicts);
  }));

  // POST /api/mcp/sync/conflicts/:id/resolve — resolve a conflict
  router.post('/conflicts/:id/resolve', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { resolvedValue, resolvedBy } = req.body;

    if (resolvedValue === undefined || resolvedBy === undefined) {
      res.status(400).json({ error: 'resolvedValue and resolvedBy are required' }); return;
    }

    const conflict = await repo.resolveConflict(id, resolvedValue, resolvedBy);
    if (!conflict) { res.status(404).json({ error: 'Conflict not found' }); return; }
    await auditLogger.logSyncEvent(id, 'mcp.sync.conflict.resolve', resolvedBy, undefined, { resolvedValue });
    res.json(conflict);
  }));

  // POST /api/mcp/sync/conflicts/:id/ignore — ignore a conflict
  router.post('/conflicts/:id/ignore', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const ignored = await repo.ignoreConflict(id);
    if (!ignored) { res.status(404).json({ error: 'Conflict not found' }); return; }
    await auditLogger.logSyncEvent(id, 'mcp.sync.conflict.ignore', undefined, undefined, {});
    res.status(204).end();
  }));

  // ─── Sync State ───────────────────────────────────────────────────────

  // GET /api/mcp/sync/connections/:id/state — get sync state
  router.get('/connections/:id/state', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const state = await repo.getSyncState(id);
    if (!state) { res.status(404).json({ error: 'Sync state not found' }); return; }
    res.json(state);
  }));

  return router;
}
