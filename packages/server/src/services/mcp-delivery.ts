import type { MCPRepository, MCPServerRecord } from '../repositories/mcp-types.js';

/**
 * Stage D — MCP delivery.
 *
 * Turns the Board's existing MCP server + permission configuration into the native
 * `mcpServers` payload each provider understands, so assigned agents can actually use
 * the configured servers/tools (not just see them in the UI).
 *
 * Enforcement: a server is delivered to an agent only if at least one of its tools is
 * explicitly allowed for that agent in `mcp_permissions` (default-deny). Where a provider
 * supports a per-server tool allowlist (Copilot), only the allowed tools are exposed.
 *
 * Credentials (env/headers) are passed to the provider SDK so it can connect, but are
 * never written to prompts, logs, or UI events.
 */

export interface McpDeliveryServer {
  record: MCPServerRecord;
  allowedTools: string[];
}

/** Providers with native per-session MCP injection wired here. */
export const MCP_DELIVERY_PROVIDERS = ['copilot', 'claude', 'hermes', 'openclaw', 'grok'] as const;

/** Collect servers that have >=1 tool explicitly allowed for the agent (default-deny). */
export async function collectAllowedMcpServers(repo: MCPRepository, agentType: string): Promise<McpDeliveryServer[]> {
  const servers = await repo.getAllServers();
  const out: McpDeliveryServer[] = [];
  for (const record of servers) {
    const perms = await repo.getPermissionsByServer(record.id);
    const allowedTools = perms
      .filter((p) => p.agent_type === agentType && p.allowed)
      .map((p) => p.tool_name);
    if (allowedTools.length > 0) out.push({ record, allowedTools });
  }
  return out;
}

/** Stable, identifier-safe key for a server name. */
function serverKey(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'mcp-server';
}

function toEnvPairs(obj: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(obj ?? {}).map(([name, value]) => ({ name, value }));
}

/** Copilot native format: Record<name, MCPServerConfig>, with a per-server tool allowlist. */
function toCopilotMcp(delivery: McpDeliveryServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { record, allowedTools } of delivery) {
    if (record.transport === 'stdio') {
      out[serverKey(record.name)] = {
        type: 'stdio',
        command: record.command,
        args: record.args ?? [],
        env: record.env ?? {},
        ...(record.cwd ? { workingDirectory: record.cwd } : {}),
        tools: allowedTools,
      };
    } else {
      out[serverKey(record.name)] = {
        type: record.transport === 'sse' ? 'sse' : 'http',
        url: record.url,
        headers: record.headers ?? {},
        tools: allowedTools,
      };
    }
  }
  return out;
}

/**
 * Claude native format: Record<name, McpServerConfig>. Claude's MCP config has no
 * per-server tool allowlist, so enforcement is server-level gating (only servers with
 * allowed tools are delivered); tool-level control is via the interactive permission layer.
 */
function toClaudeMcp(delivery: McpDeliveryServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { record } of delivery) {
    if (record.transport === 'stdio') {
      out[serverKey(record.name)] = {
        type: 'stdio',
        command: record.command,
        args: record.args ?? [],
        env: record.env ?? {},
      };
    } else {
      out[serverKey(record.name)] = {
        type: record.transport === 'sse' ? 'sse' : 'http',
        url: record.url,
        headers: record.headers ?? {},
      };
    }
  }
  return out;
}

/** ACP native format: McpServer[] (stdio {name,command,args,env[]} / http {name,url,headers[]}). */
function toAcpMcp(delivery: McpDeliveryServer[]): Array<Record<string, unknown>> {
  return delivery.map(({ record }) => {
    if (record.transport === 'stdio') {
      return {
        name: record.name,
        command: record.command,
        args: record.args ?? [],
        env: toEnvPairs(record.env),
      };
    }
    return {
      name: record.name,
      url: record.url,
      headers: toEnvPairs(record.headers),
    };
  });
}

/**
 * Build the native `mcpServers` payload for the provider, or undefined when nothing is
 * allowed or the provider has no wired per-session MCP injection (e.g. codex/opencode).
 * Never logs credentials.
 */
export function buildMcpServersPayload(agentType: string, delivery: McpDeliveryServer[]): unknown {
  if (delivery.length === 0) return undefined;
  switch (agentType) {
    case 'copilot': return toCopilotMcp(delivery);
    case 'claude': return toClaudeMcp(delivery);
    case 'hermes':
    case 'openclaw':
    case 'grok': return toAcpMcp(delivery);
    default: return undefined;
  }
}

/** Convenience: collect + build in one call. Returns undefined when nothing to deliver. */
export async function buildMcpServersForAgent(repo: MCPRepository, agentType: string): Promise<unknown> {
  if (!(MCP_DELIVERY_PROVIDERS as readonly string[]).includes(agentType)) return undefined;
  const delivery = await collectAllowedMcpServers(repo, agentType);
  return buildMcpServersPayload(agentType, delivery);
}
