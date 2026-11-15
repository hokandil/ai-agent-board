import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp';
import type { TaskRepository } from '../repositories/types.js';
import type { MCPRepository } from '../repositories/mcp-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import type { AuditLogger } from '../services/audit-logger.js';
import { McpBoardServer } from '../services/mcp-board-server.js';
import { asyncHandler } from './helpers.js';

type FullRepo = TaskRepository & MCPRepository;

/**
 * MCP Board Server route - exposes the AI Agent Board as an MCP server that AI agents
 * can connect to via Streamable HTTP transport.
 *
 * Authentication: Bearer token with mcp:board:read / mcp:board:write /
 * mcp:board:execute / mcp:board:approve scopes.
 *
 * The MCP SDK's StreamableHTTPServerTransport handles both SSE streaming
 * (for server-to-client messages) and POST (for client-to-server messages)
 * on the same endpoint. It also handles session management for stateful
 * connections.
 */
export function createMcpBoardServerRouter(repo: FullRepo, agentManager: AgentManager, auditLogger: AuditLogger): Router {
  const router = Router();

  // Lazy-initialize the MCP server and transport on first request.
  // The transport is a singleton - all MCP connections go through it.
  let mcpBoardServer: McpBoardServer | null = null;
  let transport: StreamableHTTPServerTransport | null = null;

  function ensureInitialized(): void {
    if (!mcpBoardServer) {
      mcpBoardServer = new McpBoardServer(repo, agentManager, auditLogger);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `mcp-${randomUUID()}`,
      });
      mcpBoardServer.getServer().connect(transport);
    }
  }

  // POST /api/mcp/server - handle MCP protocol messages (client -> server)
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    ensureInitialized();
    try {
      await transport!.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  }));

  // GET /api/mcp/server - SSE stream for server -> client messages
  // Also used for initial connection in stateless mode
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    ensureInitialized();
    try {
      await transport!.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    }
  }));

  return router;
}

function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
