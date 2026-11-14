import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Circle, Plug, Plus, RefreshCw, Sliders, Trash2, X,
} from 'lucide-react';
import type { MCPServer, MCPTool, MCPTransportType } from '@/types';
import { api } from '@/lib/api';

type TransportOption = { value: MCPTransportType; label: string };

const TRANSPORT_OPTIONS: TransportOption[] = [
  { value: 'stdio', label: 'Stdio (local CLI)' },
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE (legacy)' },
];

export function McpServerConfig(_props: {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}) {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [permissions, setPermissions] = useState<
    Array<{ serverId: string; agentType: string; toolName: string; allowed: boolean }>
  >([]);
  const [permLoading, setPermLoading] = useState(false);
  const [agentTypes, setAgentTypes] = useState<string[]>([]);

  const loadServers = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getMcpServers();
      setServers(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    }
  }, []);

  const loadAgentTypes = useCallback(async () => {
    try {
      const resp = await fetch('/api/agents');
      const agents = (await resp.json()) as Array<{ name: string }>;
      setAgentTypes(agents.map((a) => a.name));
    } catch {
      /* best effort */
    }
  }, []);

  const loadPermissions = useCallback(async () => {
    setPermLoading(true);
    try {
      const list = await api.getMcpPermissions();
      setPermissions(list);
    } catch {
      setPermissions([]);
    } finally {
      setPermLoading(false);
    }
  }, []);

  const loadTools = useCallback(async (serverId: string) => {
    setToolLoading(true);
    try {
      const data = await api.getMcpTools(serverId);
      setTools(data.tools);
      setSelectedServerId(serverId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setToolLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
    loadAgentTypes();
    loadPermissions();
  }, [loadServers, loadAgentTypes, loadPermissions]);

  const handleConnect = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.connectMcpServer(id);
      await loadServers();
      if (selectedServerId === id) {
        const data = await api.getMcpTools(id);
        setTools(data.tools);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }, [loadServers, selectedServerId]);

  const handleDisconnect = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.disconnectMcpServer(id);
      await loadServers();
      setTools([]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    }
  }, [loadServers]);

  const handleCreate = useCallback(async (data: {
    name: string;
    transport: MCPTransportType;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    cwd?: string;
    headers?: Record<string, string>;
  }) => {
    setError(null);
    try {
      const created = await api.createMcpServer(data);
      setServers((prev) => [...prev, created]);
      setOpenForm(false);
      setEditingServer(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.deleteMcpServer(id);
      setServers((prev) => prev.filter((s) => s.id !== id));
      if (selectedServerId === id) {
        setSelectedServerId(null);
        setTools([]);
      }
      setDeletingServer(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete server');
      setDeletingServer(null);
    }
  }, []);

  const handleSetPermission = useCallback(async (serverId: string, agentType: string, toolName: string, allowed: boolean) => {
    setError(null);
    try {
      await api.setMcpPermission({ serverId, agentType, toolName, allowed });
      await loadPermissions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set permission');
    }
  }, [loadPermissions]);

  const handleTestTool = useCallback(async (toolName: string) => {
    if (!selectedServerId) return;
    setError(null);
    try {
      const result = await api.testMcpTool(selectedServerId, toolName);
      console.log('Tool test result:', result);
      setError(result.isError ? `Tool returned error: ${JSON.stringify(result.content)}` : 'Tool test succeeded');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Tool test failed');
    }
  }, [selectedServerId]);

  const statusBadge = (status: string) => {
    const variants: Record<string, string> = {
      disconnected: 'bg-muted text-muted-foreground',
      connecting: 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30',
      connected: 'bg-green-500/20 text-green-600 border-green-500/30',
      error: 'bg-red-500/20 text-red-600 border-red-500/30',
    };
    return variants[status] || variants.disconnected;
  };

  const isConnected = (s: MCPServer) => s.status === 'connected';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">MCP Servers</h2>
          <p className="text-muted-foreground text-sm">
            Configure and connect to external Model Context Protocol servers.
          </p>
        </div>
        <button
          onClick={() => { setEditingServer(null); setOpenForm(true); }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add Server
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Servers list */}
      <div className="rounded-lg border p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2">Name</th>
              <th className="pb-2">Transport</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2 font-medium">{s.name}</td>
                <td className="py-2">{s.transport}</td>
                <td className="py-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge(s.status)}`}>
                    <Circle className={`h-2 w-2 ${isConnected(s) ? 'bg-current' : 'bg-muted'}`} />
                    {s.status}
                  </span>
                </td>
                <td className="py-2 text-right">
                  {!isConnected(s) ? (
                    <button
                      onClick={() => handleConnect(s.id)}
                      className="px-3 py-1 text-xs font-medium rounded-md border bg-green-500/10 text-green-600 hover:bg-green-500/20"
                    >
                      Connect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleDisconnect(s.id)}
                      className="px-3 py-1 text-xs font-medium rounded-md border bg-red-500/10 text-red-600 hover:bg-red-500/20"
                    >
                      Disconnect
                    </button>
                  )}
                  <button
                    onClick={() => loadTools(s.id)}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <Sliders className="h-3 w-3 mr-1" /> Tools
                  </button>
                  <button
                    onClick={() => { setDeletingServer(s.id); }}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-muted-foreground">
                  No MCP servers configured. Add one to connect to external task systems.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Selected server tools & permissions */}
      {selectedServerId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Tools */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Discovered Tools</h3>
              <button
                onClick={() => selectedServerId && loadTools(selectedServerId)}
                disabled={toolLoading}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" /> Refresh
              </button>
            </div>
            {toolLoading ? (
              <div className="h-24 flex items-center justify-center text-muted-foreground">Loading tools…</div>
            ) : tools.length === 0 ? (
              <div className="h-24 flex items-center justify-center text-muted-foreground">
                No tools discovered. Connect the server first.
              </div>
            ) : (
              <div className="space-y-1">
                {tools.map((t) => (
                  <div key={t.name} className="flex items-center justify-between p-2 rounded border border-muted/30">
                    <div className="flex items-center gap-2">
                      <Plug className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{t.name}</span>
                      {t.description && (
                        <span className="text-xs text-muted-foreground ml-2">— {t.description}</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleTestTool(t.name)}
                      className="px-2 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                    >
                      Test
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Permissions */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Agent Permissions</h3>
              <p className="text-xs text-muted-foreground">
                Control which agents may call each tool on this server.
              </p>
            </div>
            {permLoading ? (
              <div className="h-24 flex items-center justify-center text-muted-foreground">Loading permissions…</div>
            ) : agentTypes.length === 0 ? (
              <div className="h-24 flex items-center justify-center text-muted-foreground">
                No agents detected. Start the board to detect available agents.
              </div>
            ) : (
              <div className="space-y-1">
                {tools.map((t) => (
                  <div key={t.name} className="p-2 rounded border border-muted/30">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm">{t.name}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1">
                      {agentTypes.map((at) => {
                        const perm = permissions.find(
                          (p) => p.serverId === selectedServerId && p.agentType === at && p.toolName === t.name
                        );
                        return (
                          <button
                            key={at}
                            onClick={() => handleSetPermission(selectedServerId!, at, t.name, !(perm?.allowed ?? false))}
                            className={`px-2 py-1 text-xs font-medium rounded border transition ${
                              perm?.allowed
                                ? 'bg-green-500/20 text-green-600 border-green-500/30'
                                : 'bg-muted text-muted-foreground border-muted/30'
                            }`}
                          >
                            {at}{perm?.allowed ? ' ✓' : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add/Edit server form */}
      <AnimatePresence>
        {openForm && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setOpenForm(false)}
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-md rounded-lg border bg-background p-6 shadow-xl"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold">{editingServer ? 'Edit Server' : 'Add MCP Server'}</h3>
                <button onClick={() => setOpenForm(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.target as HTMLFormElement);
                  const transport = formData.get('transport') as MCPTransportType;
                  const data = {
                    name: (formData.get('name') as string) || '',
                    transport,
                    command: (formData.get('command') as string) || undefined,
                    args: formData.get('args') ? ((formData.get('args') as string).split(',').map(s => s.trim()).filter(Boolean)) : [],
                    url: (formData.get('url') as string) || undefined,
                    env: {},
                    cwd: (formData.get('cwd') as string) || undefined,
                    headers: {},
                  };
                  handleCreate(data);
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input
                    name="name"
                    defaultValue={editingServer?.name ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Transport</label>
                  <select
                    name="transport"
                    defaultValue={editingServer?.transport ?? 'stdio'}
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    {TRANSPORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Command (stdio)</label>
                  <input
                    name="command"
                    defaultValue={editingServer?.command ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. npx mcp-server-git"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Args (comma-separated)</label>
                  <input
                    name="args"
                    defaultValue={editingServer?.args?.join(', ') ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. --tool, --option"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">URL (streamable-http / sse)</label>
                  <input
                    name="url"
                    defaultValue={editingServer?.url ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. https://example.com/mcp"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Working directory (cwd)</label>
                  <input
                    name="cwd"
                    defaultValue={editingServer?.cwd ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. /home/user/project"
                  />
                </div>
                <div className="flex items-center justify-between pt-3">
                  <button
                    type="button"
                    onClick={() => setOpenForm(false)}
                    className="px-4 py-1.5 text-sm font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {editingServer ? 'Save' : 'Add Server'}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Delete confirm */}
      <AnimatePresence>
        {deletingServer && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setDeletingServer(null)}
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="relative w-full max-w-md rounded-lg border bg-background p-6 shadow-xl"
            >
              <h3 className="font-semibold mb-2">Delete MCP Server?</h3>
              <p className="text-sm text-muted-foreground mb-4">
                This will disconnect and remove the server configuration. Tools and permissions for this server will also be removed.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeletingServer(null)}
                  className="px-4 py-1.5 text-sm font-medium rounded-md border text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deletingServer!)}
                  className="px-4 py-1.5 text-sm font-medium rounded-md border bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
