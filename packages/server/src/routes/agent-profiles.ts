import { Router, Request, Response } from 'express';
import { asyncHandler, paramId } from './helpers.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProfile } from '@ai-agent-board/shared/types.js';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';

export function createAgentProfilesRouter(repo: TaskRepository): Router {
  const router = Router();

  // GET /api/agent-profiles — list all agent profiles
  router.get('/', asyncHandler(async (_req: Request, res: Response) => {
    const profiles = await repo.getAllAgentProfiles();
    res.json(profiles);
  }));

  // GET /api/agent-profiles/:id — get a single profile
  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const profile = await repo.getAgentProfile(id);
    if (!profile) { res.status(404).json({ error: 'Agent profile not found' }); return; }
    res.json(profile);
  }));

  // POST /api/agent-profiles — create a profile
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const { name, provider, model, instructions, mcpServerIds, skillIds, enabled } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' }); return;
    }
    if (!provider || typeof provider !== 'string' || !isValidAgentType(provider)) {
      res.status(400).json({ error: 'provider is required and must be a valid agent type' }); return;
    }
    const profile = await repo.createAgentProfile({
      name, provider: provider as AgentProfile['provider'], model: model ?? null,
      instructions: instructions ?? null,
      mcpServerIds: Array.isArray(mcpServerIds) ? mcpServerIds : [],
      skillIds: Array.isArray(skillIds) ? skillIds : [],
      enabled: enabled !== false,
    });
    res.status(201).json(profile);
  }));

  // PATCH /api/agent-profiles/:id — update a profile
  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const { name, provider, model, instructions, mcpServerIds, skillIds, enabled } = req.body;
    if (provider !== undefined && (typeof provider !== 'string' || !isValidAgentType(provider))) {
      res.status(400).json({ error: 'provider must be a valid agent type' }); return;
    }
    const profile = await repo.updateAgentProfile(id, {
      name, provider: provider as AgentProfile['provider'] | undefined, model: model ?? undefined,
      instructions: instructions ?? undefined,
      mcpServerIds: Array.isArray(mcpServerIds) ? mcpServerIds : undefined,
      skillIds: Array.isArray(skillIds) ? skillIds : undefined,
      enabled: enabled === undefined ? undefined : enabled,
    });
    if (!profile) { res.status(404).json({ error: 'Agent profile not found' }); return; }
    res.json(profile);
  }));

  // DELETE /api/agent-profiles/:id — delete a profile
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const deleted = await repo.deleteAgentProfile(id);
    if (!deleted) { res.status(404).json({ error: 'Agent profile not found' }); return; }
    res.status(204).end();
  }));

  return router;
}
