import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { MCPServer, MCPTool, MCPTransportType, MCPConnectionStatus } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { MCPRepository } from '../repositories/mcp-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import type { AuditLogger } from '../services/audit-logger.js';
import { redactSensitive } from '../services/audit-logger.js';
import { mcpClientManager } from '../services/mcp-client.js';
import { MCP_CREDENTIAL_CLEAR } from '@ai-agent-board/shared/constants.js';
import { asyncHandler } from './helpers.js';

const VALID_TRANSPORTS: MCPTransportType[] = ['stdio', 'streamable-http', 'sse'];

function isValidTransport(value: unknown): value is MCPTransportType {
  return typeof value === 'string' && VALID_TRANSPORTS.includes(value as MCPTransportType);
}

/**
 * Merge an incoming credential map onto the stored one.
 *
 * Credential values are never sent back to the client (they are redacted), so
 * an empty value in an update means "keep the stored secret". Removing a
 * credential requires the explicit `MCP_CREDENTIAL_CLEAR` marker.
 */
function mergeCredentials(
  existing: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!key.trim()) continue;
    if (value === MCP_CREDENTIAL_CLEAR) {
      delete merged[key];
      continue;
    }
    if (value === '') continue; // leave the stored credential untouched
    merged[key] = value;
  }
  return merged;
}

/** Drop credential entries with an empty value (used on create). */
function dropEmptyCredentials(creds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(creds)) {
    if (!key.trim()) continue;
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

function serverRecordToResponse(record: any): MCPServer {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    command: record.command ?? undefined,
    args: record.args ?? undefined,
    url: record.url ?? undefined,
    env: record.env ? redactMcpCredentials(record.env) : undefined,
    cwd: record.cwd ?? undefined,
    headers: record.headers ? redactMcpCredentials(record.headers) : undefined,
    status: record.status as MCPConnectionStatus,
    last_connected_at: record.last_connected_at ?? undefined,
    last_error: record.last_error ?? undefined,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Redact credential values in an env/headers record for REST API responses.
 * Replaces each value with '[REDACTED]' but preserves the keys so callers
 * know which fields are configured without exposing the secrets. */
function redactMcpCredentials(creds: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(creds)) {
    redacted[key] = '[REDACTED]';
  }
  return redacted;
}

export function createMcpRouter(repo: TaskRepository & MCPRepository, agentManager: AgentManager, auditLogger: AuditLogger): Router {
  const router = Router();

  // ─── MCP Server CRUD ───────────────────────────────────────────────────

  // GET /api/mcp/servers — list all MCP servers
  router.get('/servers', asyncHandler(async (_req: Request, res: Response) => {
    const servers = await repo.getAllServers();
    res.json(servers.map(serverRecordToResponse));
  }));

  // GET /api/mcp/servers/:id — get a specific server
  router.get('/servers/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }
    res.json(serverRecordToResponse(server));
  }));

  // POST /api/mcp/servers — create/register an MCP server
  router.post('/servers', asyncHandler(async (req: Request, res: Response) => {
    const { name, transport, command, args, url, env, cwd, headers } = req.body;

    if (!name || typeof name !== 'string') { res.status(400).json({ error: 'name is required' }); return; }
    if (!isValidTransport(transport)) { res.status(400).json({ error: 'invalid transport' }); return; }

    // Validate transport-specific fields
    if (transport === 'stdio' && !command) {
      res.status(400).json({ error: 'stdio transport requires a command' }); return;
    }
    if ((transport === 'streamable-http' || transport === 'sse') && !url) {
      res.status(400).json({ error: `${transport} transport requires a url` }); return;
    }

    // Prevent accidental duplicate registrations: the same name pointing at the
    // same endpoint is almost always an accidental double-add.
    const all = await repo.getAllServers();
    const normalizedName = name.trim().toLowerCase();
    const endpoint = transport === 'stdio'
      ? `${command ?? ''} ${(args ?? []).join(' ')}`.trim()
      : (url ?? '').trim();
    const duplicate = all.find((s) => {
      if (s.name.trim().toLowerCase() !== normalizedName) return false;
      const otherEndpoint = s.transport === 'stdio'
        ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
        : (s.url ?? '').trim();
      return otherEndpoint === endpoint;
    });
    if (duplicate) {
      res.status(409).json({
        error: `An MCP server named "${name}" already points at the same endpoint`,
        existingId: duplicate.id,
      });
      return;
    }

    const id = `mcp-server:${randomUUID()}`;
    const now = Date.now();
    const server: MCPServer = {
      id, name, transport,
      command, args: args ?? [], url,
      // Empty credential values are meaningless on create — drop them.
      env: dropEmptyCredentials(env ?? {}), cwd, headers: dropEmptyCredentials(headers ?? {}),
      status: 'disconnected',
      created_at: now, updated_at: now,
    };

    const created = await repo.createServer(server);
    res.status(201).json(serverRecordToResponse(created));
  }));

  // PUT /api/mcp/servers/:id — update an MCP server configuration
  router.put('/servers/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    const { name, transport, command, args, url, env, cwd, headers } = req.body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ error: 'name must be a non-empty string' }); return;
    }
    if (transport !== undefined && !isValidTransport(transport)) {
      res.status(400).json({ error: 'invalid transport' }); return;
    }

    // Validate transport-specific fields after applying updates
    const nextTransport = transport ?? server.transport;
    const nextCommand = command !== undefined ? command : server.command;
    const nextUrl = url !== undefined ? url : server.url;

    if (nextTransport === 'stdio' && !nextCommand) {
      res.status(400).json({ error: 'stdio transport requires a command' }); return;
    }
    if ((nextTransport === 'streamable-http' || nextTransport === 'sse') && !nextUrl) {
      res.status(400).json({ error: `${nextTransport} transport requires a url` }); return;
    }

    const updates: Partial<MCPServer> = {};
    if (name !== undefined) updates.name = name.trim();
    if (transport !== undefined) updates.transport = transport;
    if (command !== undefined) updates.command = command;
    if (args !== undefined) updates.args = args;
    if (url !== undefined) updates.url = url;
    if (env !== undefined) updates.env = mergeCredentials(server.env ?? {}, env);
    if (cwd !== undefined) updates.cwd = cwd;
    if (headers !== undefined) updates.headers = mergeCredentials(server.headers ?? {}, headers);

    const updated = await repo.updateServer(id, updates);
    if (!updated) { res.status(500).json({ error: 'Failed to update server' }); return; }

    // Disconnect if the server was connected so config changes take effect
    if (mcpClientManager.isConnected(id)) {
      await mcpClientManager.disconnect(id);
      await repo.updateServer(id, { status: 'disconnected', last_error: undefined });
    }

    const latest = await repo.getServerById(id);
    res.json(serverRecordToResponse(latest!));
  }));

  // POST /api/mcp/servers/:id/connect — connect to an MCP server
  router.post('/servers/:id/connect', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    try {
      await mcpClientManager.connect({
        id: server.id,
        name: server.name,
        transport: server.transport as MCPTransportType,
        command: server.command,
        args: server.args,
        url: server.url,
        env: server.env,
        cwd: server.cwd,
        headers: server.headers,
      });

      // Update status in DB
      await repo.updateServer(id, { status: 'connected', last_connected_at: Date.now(), last_error: undefined });
      const updated = await repo.getServerById(id);
      res.json(serverRecordToResponse(updated!));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.updateServer(id, { status: 'error', last_error: message });
      res.status(500).json({ error: `Failed to connect to MCP server: ${message}` });
    }
  }));

  // POST /api/mcp/servers/:id/disconnect — disconnect from an MCP server
  router.post('/servers/:id/disconnect', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    await mcpClientManager.disconnect(id);
    await repo.updateServer(id, { status: 'disconnected', last_error: undefined });
    const updated = await repo.getServerById(id);
    res.json(serverRecordToResponse(updated!));
  }));

  // DELETE /api/mcp/servers/:id — delete an MCP server
  router.delete('/servers/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    // Disconnect if connected
    if (mcpClientManager.isConnected(id)) {
      await mcpClientManager.disconnect(id);
    }

    const deleted = await repo.deleteServer(id);
    if (!deleted) { res.status(500).json({ error: 'Failed to delete MCP server' }); return; }
    res.status(204).end();
  }));

  // ─── MCP Tool Discovery ────────────────────────────────────────────────

  // GET /api/mcp/servers/:id/tools — list discovered tools
  router.get('/servers/:id/tools', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    let tools: MCPTool[];
    if (mcpClientManager.isConnected(id)) {
      tools = await mcpClientManager.discoverTools(id);
    } else {
      const dbTools = await repo.getToolsByServer(id);
      tools = dbTools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input_schema, outputSchema: t.output_schema, annotations: t.annotations }));
    }
    res.json({ tools });
  }));

  // POST /api/mcp/servers/:id/test-tool — test calling a tool
  router.post('/servers/:id/test-tool', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { toolName, arguments: args } = req.body;

    if (!toolName || typeof toolName !== 'string') {
      res.status(400).json({ error: 'toolName is required' }); return;
    }

    const server = await repo.getServerById(id);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    if (!mcpClientManager.isConnected(id)) {
      res.status(409).json({ error: 'MCP server is not connected' }); return;
    }

    try {
      const result = await mcpClientManager.callTool(id, toolName, args ?? {});
      await auditLogger.logMcpEvent(id, 'mcp.tool.call', undefined, undefined, { tool: toolName, toolArgs: redactSensitive(args) });
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await auditLogger.logMcpEvent(id, 'mcp.tool.call', undefined, undefined, { tool: toolName, toolArgs: redactSensitive(args), error: message });
      res.status(500).json({ error: `Tool call failed: ${message}` });
    }
  }));

  // ─── MCP Permissions ───────────────────────────────────────────────────

  // GET /api/mcp/permissions — list all permissions
  router.get('/permissions', asyncHandler(async (_req: Request, res: Response) => {
    const servers = await repo.getAllServers();
    const agentTypes = agentManager.getAvailableAgents().map(a => a.name);
    const permissions: Array<{ serverId: string; serverName: string; agentType: string; toolName: string; allowed: boolean }> = [];

    for (const server of servers) {
      const tools = await repo.getToolsByServer(server.id);
      for (const agentType of agentTypes) {
        for (const tool of tools) {
          const allowed = await repo.isToolAllowed(server.id, agentType, tool.name);
          permissions.push({
            serverId: server.id, serverName: server.name,
            agentType, toolName: tool.name, allowed,
          });
        }
      }
    }
    res.json(permissions);
  }));

  // GET /api/mcp/permissions/:serverId — list permissions for a server
  router.get('/permissions/:serverId', asyncHandler(async (req: Request, res: Response) => {
    const serverId = req.params.serverId as string;
    const server = await repo.getServerById(serverId);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    const permissions = await repo.getPermissionsByServer(serverId);
    res.json(permissions);
  }));

  // POST /api/mcp/permissions — set a permission
  router.post('/permissions', asyncHandler(async (req: Request, res: Response) => {
    const { serverId, agentType, toolName, allowed } = req.body;

    if (!serverId || !agentType || !toolName) {
      res.status(400).json({ error: 'serverId, agentType, and toolName are required' }); return;
    }
    if (typeof allowed !== 'boolean') {
      res.status(400).json({ error: 'allowed must be a boolean' }); return;
    }

    const server = await repo.getServerById(serverId);
    if (!server) { res.status(404).json({ error: 'MCP server not found' }); return; }

    const permission = await repo.setPermission(serverId, agentType, toolName, allowed);
    res.status(201).json(permission);
  }));

  // DELETE /api/mcp/permissions — delete a permission
  router.delete('/permissions', asyncHandler(async (req: Request, res: Response) => {
    const { serverId, agentType, toolName } = req.body;

    if (!serverId || !agentType || !toolName) {
      res.status(400).json({ error: 'serverId, agentType, and toolName are required' }); return;
    }

    const deleted = await repo.deletePermission(serverId, agentType, toolName);
    if (!deleted) { res.status(404).json({ error: 'Permission not found' }); return; }
    res.status(204).end();
  }));

  return router;
}
