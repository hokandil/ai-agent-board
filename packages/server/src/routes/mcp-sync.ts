import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SyncConnectionRecord } from '../repositories/mcp-sync-types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { MCPRepository } from '../repositories/mcp-types.js';
import type { SyncRepository } from '../repositories/mcp-sync-types.js';
import { syncEngine } from '../services/mcp-sync.js';
import { asyncHandler } from './helpers.js';

type FullRepo = TaskRepository & MCPRepository & SyncRepository;

export function createMcpSyncRouter(repo: FullRepo): Router {
  const router = Router();

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
    res.status(201).json(created);
  }));

  // POST /api/mcp/sync/connections/:id/sync — trigger a sync
  router.post('/connections/:id/sync', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const conn = await repo.getConnectionById(id);
    if (!conn) { res.status(404).json({ error: 'Sync connection not found' }); return; }

    try {
      const result = await syncEngine.sync(id);
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
    res.json(conflict);
  }));

  // POST /api/mcp/sync/conflicts/:id/ignore — ignore a conflict
  router.post('/conflicts/:id/ignore', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const ignored = await repo.ignoreConflict(id);
    if (!ignored) { res.status(404).json({ error: 'Conflict not found' }); return; }
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
