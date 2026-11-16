import { Router, Request, Response } from 'express';
import { asyncHandler } from './helpers.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProfile, AgentType, AgentInfo } from '@ai-agent-board/shared/types.js';
import { isValidAgentType, VALID_AGENT_TYPES } from '@ai-agent-board/shared/constants.js';
import type { AgentManager } from '../services/agent-manager.js';
import { PROVIDER_CAPABILITIES, type ProviderCapabilities } from '../services/provider-capabilities.js';

/** One executor row for the Agents management screen. */
export interface ManagedAgent {
  provider: AgentType;
  detection: AgentInfo | null;
  capabilities: ProviderCapabilities;
  config: AgentProfile | null;
}

export function getCapabilities(provider: AgentType): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider];
}

/** Build the managed-agent list: every supported provider, its detection result,
 *  its supported capabilities, and its saved configuration (if any). */
export async function buildManagedAgents(repo: TaskRepository, agentManager: AgentManager): Promise<ManagedAgent[]> {
  const detections = new Map(agentManager.getAvailableAgents().map((a) => [a.name, a]));
  const profiles = await repo.getAllAgentProfiles();
  const configByProvider = new Map<string, AgentProfile>();
  // getAllAgentProfiles is name-ordered; prefer the most recently updated enabled row.
  for (const p of profiles) {
    if (!p.enabled) continue;
    const existing = configByProvider.get(p.provider);
    if (!existing || p.updatedAt > existing.updatedAt) configByProvider.set(p.provider, p);
  }
  return VALID_AGENT_TYPES.map((provider) => ({
    provider,
    detection: detections.get(provider) ?? null,
    capabilities: PROVIDER_CAPABILITIES[provider],
    config: configByProvider.get(provider) ?? null,
  }));
}

export function createAgentsRouter(repo: TaskRepository, agentManager: AgentManager): Router {
  const router = Router();

  // GET /api/agents/manage — executors + detection + supported config + saved config
  router.get('/manage', asyncHandler(async (_req: Request, res: Response) => {
    res.json(await buildManagedAgents(repo, agentManager));
  }));

  // POST /api/agents/manage/rescan — re-detect installed CLIs and return the refreshed list
  router.post('/manage/rescan', asyncHandler(async (_req: Request, res: Response) => {
    await agentManager.refresh();
    res.json(await buildManagedAgents(repo, agentManager));
  }));

  // PUT /api/agents/manage/:provider/config — upsert the saved configuration for one executor.
  // Only fields the provider genuinely supports are persisted; a saved model is stored even for
  // startup/native-model providers (the runtime cannot re-apply it until the provider is
  // re-registered) but the capability matrix flags that in the UI, so nothing is misrepresented.
  router.put('/:provider/config', asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider as AgentType;
    if (!isValidAgentType(provider)) { res.status(400).json({ error: 'invalid provider' }); return; }

    const { model, instructions, command, mcpServerIds, skillIds, enabled } = req.body ?? {};
    const patch = {
      name: provider,
      provider,
      model: typeof model === 'string' && model.trim() ? model.trim() : null,
      instructions: typeof instructions === 'string' && instructions.trim() ? instructions.trim() : null,
      command: typeof command === 'string' && command.trim() ? command.trim() : null,
      mcpServerIds: Array.isArray(mcpServerIds) ? mcpServerIds.filter((x: unknown) => typeof x === 'string') : [],
      skillIds: Array.isArray(skillIds) ? skillIds.filter((x: unknown) => typeof x === 'string') : [],
      enabled: enabled === undefined ? true : Boolean(enabled),
    };

    const existing = await repo.getAgentProfileByProvider(provider);
    let saved: AgentProfile | undefined;
    if (existing) {
      saved = await repo.updateAgentProfile(existing.id, patch);
    } else {
      try {
        saved = await repo.createAgentProfile(patch);
      } catch (err: unknown) {
        res.status(500).json({ error: `failed to save agent config: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
    }

    // Apply values that are not delivered dynamically per-run (custom executable path, or a
    // model for SDK providers that fix model at construction) directly to the live provider.
    const apply = await agentManager.applyExecutorConfig(provider, { command: patch.command, model: patch.model });

    const detections = new Map(agentManager.getAvailableAgents().map((a) => [a.name, a]));
    res.json({
      provider,
      detection: detections.get(provider) ?? null,
      capabilities: PROVIDER_CAPABILITIES[provider],
      config: saved ?? null,
      applied: apply,
    } satisfies ManagedAgent & { applied: { applied: boolean; started: boolean; reason?: string } });
  }));

  return router;
}
