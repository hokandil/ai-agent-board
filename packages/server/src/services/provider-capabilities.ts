import type { AgentType, ProviderCapabilities, ModelDelivery } from '@ai-agent-board/shared/types.js';

// Capabilities and ModelDelivery are defined once in the shared module and re-exported here
// so the server route, this catalog, and the client all agree on a single source of truth.
export type { ProviderCapabilities, ModelDelivery };

// Verified sources:
//   - copilot/claude/codex: Stage E patches forward config.model per run  -> 'session'
//   - opencode: providerID/modelID set at construction from OPENCODE_MODEL -> 'startup'
//   - hermes/openclaw: ACP reads active model from its own/Gateway config  -> 'native'
//   - grok: model baked into ACP args at construction from GROK_MODEL       -> 'startup'
//   - command (HERMES_COMMAND/OPENCLAW_COMMAND/GROK_COMMAND): read at provider construction
//   - MCP_DELIVERY_PROVIDERS = copilot, claude, hermes, openclaw, grok
//   - skills delivered to copilot (skillDirectories) and claude (skills) only
export const PROVIDER_CAPABILITIES: Record<AgentType, ProviderCapabilities> = {
  copilot: {
    model: 'session', commandConfigurable: false, instructions: true, mcp: true, skills: true,
    limitations: ['Custom executable path is not configurable for Copilot (CLI resolved from PATH).'],
  },
  claude: {
    model: 'session', commandConfigurable: false, instructions: true, mcp: true, skills: true,
    limitations: ['Custom executable path is not configurable for Claude Code (CLI resolved from PATH).'],
  },
  codex: {
    model: 'session', commandConfigurable: false, instructions: true, mcp: false, skills: false,
    limitations: [
      'Codex does not receive Board-configured MCP servers for a run.',
      'Custom executable path is not configurable for Codex (CLI resolved from PATH).',
      'Codex requires prior login (run: codex); otherwise it reports unavailable.',
    ],
  },
  opencode: {
    model: 'startup', commandConfigurable: false, instructions: true, mcp: false, skills: false,
    limitations: [
      'OpenCode model is fixed at server startup (OPENCODE_MODEL); per-run model changes require a server restart.',
      'OpenCode does not receive Board-configured MCP servers for a run.',
    ],
  },
  hermes: {
    model: 'native', commandConfigurable: true, instructions: true, mcp: true, skills: false,
    limitations: [
      'Hermes reads the active model from its own configuration, so Board model selection does not take effect.',
    ],
  },
  openclaw: {
    model: 'native', commandConfigurable: true, instructions: true, mcp: true, skills: false,
    limitations: [
      'OpenClaw reads the active model from the Gateway/session config, so Board model selection does not take effect.',
    ],
  },
  grok: {
    model: 'startup', commandConfigurable: true, instructions: true, mcp: true, skills: false,
    limitations: [
      'Grok model is fixed at server startup (GROK_MODEL); per-run model changes require a server restart.',
    ],
  },
};
