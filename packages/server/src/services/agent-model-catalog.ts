import type { AgentType } from '@ai-agent-board/shared/types.js';

/**
 * Well-known model identifiers offered as convenience suggestions in the Agent
 * Profile editor. These are NOT a guarantee of availability: whether a given
 * model runs depends on the provider CLI version and the user's account/entitlements.
 * Providers that accept arbitrary model IDs always allow a custom value, and when no
 * suggestion applies the field can be left empty to use the provider's own default.
 *
 * Keep this list conservative and per-provider. It exists only to reduce typing for
 * common, publicly documented model IDs — never to fabricate capabilities the runtime
 * does not actually expose.
 */
export const SUGGESTED_AGENT_MODELS: Record<AgentType, string[]> = {
  copilot: [],
  claude: [],
  codex: [],
  opencode: [],
  hermes: [],
  openclaw: [],
  grok: [],
};
