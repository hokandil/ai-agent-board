import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  MCPTool,
  MCPTransportType,
  MCPConnectionStatus,
} from '../types.js';

/** Configuration for connecting to an MCP server. */
export interface MCPServerConfig {
  id: string;
  name: string;
  transport: MCPTransportType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  /** Optional OAuth provider for interactive authorization + automatic token refresh. */
  authProvider?: OAuthClientProvider;
}

/** Result of listing tools from an MCP server. */
export interface MCPListToolsResult {
  tools: MCPTool[];
}

/** Result of calling an MCP tool. */
export interface MCPToolCallResultRaw {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * MCPClientManager manages connections to external MCP servers.
 *
 * Each server connection is isolated: a Client instance per server, with its
 * own transport. Connections are lazily established on first use and can be
 * explicitly closed. Tool discovery results are cached per server and
 * invalidated on reconnect.
 *
 * Credentials (env vars, headers) are held in memory only and never written
 * to disk or logged. Callers are responsible for providing them through the
 * configuration layer (which stores encrypted at rest).
 */
export class MCPClientManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, any>();
  private toolCache = new Map<string, MCPTool[]>();
  private connectionStatus = new Map<string, MCPConnectionStatus>();

  /** List all registered server IDs. */
  listServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /** Get the connection status for a server. */
  getStatus(serverId: string): MCPConnectionStatus {
    return this.connectionStatus.get(serverId) ?? 'disconnected';
  }

  /** Get cached tools for a server, or empty array if not yet discovered. */
  getCachedTools(serverId: string): MCPTool[] {
    return this.toolCache.get(serverId) ?? [];
  }

  /**
   * Connect to an MCP server. Lazily creates a Client + transport based on
   * the transport type. On Windows, stdio commands are resolved through the
   * existing gitSpawnTarget-style logic? No — stdio commands are arbitrary
   * user-configured commands, not git. We resolve them directly; the caller
   * must ensure the command exists on PATH or provide an absolute path.
   */
  async connect(config: MCPServerConfig): Promise<void> {
    const { id, transport } = config;

    // Disconnect any existing connection for this server first.
    await this.disconnect(id);

    this.connectionStatus.set(id, 'connecting');

    let client: Client;
    let transportInstance: any;

    try {
      switch (transport) {
        case 'stdio': {
          if (!config.command) {
            throw new Error('stdio transport requires a command');
          }
          transportInstance = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: config.env,
            cwd: config.cwd,
          });
          break;
        }
        case 'streamable-http': {
          if (!config.url) {
            throw new Error('streamable-http transport requires a url');
          }
          transportInstance = new StreamableHTTPClientTransport(
            new URL(config.url),
            {
              requestInit: config.headers ? { headers: config.headers } : undefined,
              authProvider: config.authProvider,
            }
          );
          break;
        }
        case 'sse': {
          if (!config.url) {
            throw new Error('sse transport requires a url');
          }
          transportInstance = new SSEClientTransport(
            new URL(config.url),
            {
              requestInit: config.headers ? { headers: config.headers } : undefined,
              authProvider: config.authProvider,
            }
          );
          break;
        }
        default: {
          throw new Error(`Unsupported MCP transport: ${transport}`);
        }
      }

      client = new Client({
        name: 'ai-agent-board',
        version: '0.1.0',
      });

      await client.connect(transportInstance);

      this.clients.set(id, client);
      this.transports.set(id, transportInstance);
      this.connectionStatus.set(id, 'connected');

      // Discover tools immediately after connecting.
      await this.discoverTools(id);
    } catch (error) {
      this.connectionStatus.set(id, 'error');
      // Clean up partial state.
      this.clients.delete(id);
      this.transports.delete(id);
      throw error;
    }
  }

  /** Disconnect from an MCP server and clean up its transport. */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    const transport = this.transports.get(serverId);

    if (client) {
      try {
        // Client.close() may not exist on all versions; best effort.
        if (typeof (client as any).close === 'function') {
          await (client as any).close();
        }
      } catch {
        /* ignore close errors */
      }
      this.clients.delete(serverId);
    }

    if (transport) {
      try {
        if (typeof transport.close === 'function') {
          await transport.close();
        }
      } catch {
        /* ignore transport close errors */
      }
      this.transports.delete(serverId);
    }

    this.toolCache.delete(serverId);
    this.connectionStatus.set(serverId, 'disconnected');
  }

  /** Disconnect from all servers. */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys());
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  /**
   * Discover tools from a connected server and cache the result.
   * Throws if the server is not connected.
   */
  async discoverTools(serverId: string): Promise<MCPTool[]> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const result = (await client.listTools()) as unknown as MCPListToolsResult;
    const tools: MCPTool[] = (result.tools ?? []).map((t: unknown) => {
      const tool = t as { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown };
      return {
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      };
    });

    this.toolCache.set(serverId, tools);
    return tools;
  }

  /**
   * Call a tool on a connected MCP server.
   * Throws if the server is not connected or the tool is unknown.
   */
  async callTool(serverId: string, toolName: string, args: unknown): Promise<MCPToolCallResultRaw> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(`MCP server not connected: ${serverId}`);
    }

    const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    return result as unknown as MCPToolCallResultRaw;
  }

  /** Check whether a server is currently connected. */
  isConnected(serverId: string): boolean {
    return this.connectionStatus.get(serverId) === 'connected';
  }
}

/** Singleton instance used by the MCP routes. */
export const mcpClientManager = new MCPClientManager();
