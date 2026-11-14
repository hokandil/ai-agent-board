import { Router, Request, Response } from 'express';
import type { TaskRepository } from '../repositories/types.js';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import type { AgentManager } from '../services/agent-manager.js';
import { asyncHandler } from './helpers.js';

export function createSessionRouter(
  _repo: TaskRepository,
  agentManager: AgentManager,
): Router {
  const router = Router();

  // POST /api/sessions — create a new agent session
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const { agentType, taskId, model, useWorktree, repoPath, branchName, baseBranch } = req.body;

    if (!agentType || !isValidAgentType(agentType)) {
      res.status(400).json({ error: 'agentType is required and must be valid' });
      return;
    }

    const sessionId = agentManager.createSession(
      agentType,
      taskId,
      model,
      useWorktree,
      repoPath,
      branchName,
      baseBranch,
    );

    const session = agentManager.getSession(sessionId);
    if (!session) {
      res.status(500).json({ error: 'failed to create session' });
      return;
    }

    res.status(201).json(session);
  }));

  // POST /api/sessions/:id/start — start session execution
  router.post('/:id/start', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;

    try {
      await agentManager.startSession(id);
      const session = agentManager.getSession(id);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json(session);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Failed to start session: ${message}` });
    }
  }));

  // POST /api/sessions/:id/stop — stop session execution
  router.post('/:id/stop', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const stopped = await agentManager.stopSessionById(id);
    if (!stopped) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json({ stopped: true });
  }));

  // POST /api/sessions/:id/resume — resume a stopped session
  router.post('/:id/resume', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      await agentManager.resumeSession(id);
      const session = agentManager.getSession(id);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json(session);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Failed to resume session: ${message}` });
    }
  }));

  // GET /api/sessions — list all sessions
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const sessions = agentManager.listSessions();
    res.json(sessions);
  }));

  // GET /api/sessions/:id — get session details
  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = agentManager.getSession(id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(session);
  }));

  // GET /api/sessions/:id/events — get session events
  router.get('/:id/events', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const session = agentManager.getSession(id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    let events = await agentManager.getEvents(session.taskId || id);
    const since = Number(req.query.since);
    if (since > 0) {
      events = events.filter(e => e.timestamp > since);
    }
    const limit = Number(req.query.limit);
    if (limit > 0) {
      events = events.slice(-limit);
    }
    res.json(events);
  }));

  return router;
}
