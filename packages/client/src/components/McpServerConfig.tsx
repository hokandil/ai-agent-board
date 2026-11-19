import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Circle, Plug, Plus, RefreshCw, Sliders, Trash2, X, Edit2,
} from 'lucide-react';
import type { MCPServer, MCPTool, MCPTransportType } from '@/types';
import { MCP_CREDENTIAL_CLEAR } from '@/types';
import { api } from '@/lib/api';
import { McpToolTestDialog } from './McpToolTestDialog';

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
  const [oauthPending, setOauthPending] = useState<Set<string>>(new Set());
  const [openForm, setOpenForm] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [testingTool, setTestingTool] = useState<MCPTool | null>(null);
  const [permissions, setPermissions] = useState<
    Array<{ serverId: string; agentType: string; toolName: string; allowed: boolean }>
  >([]);
  const [permLoading, setPermLoading] = useState(false);
  const [agentTypes, setAgentTypes] = useState<string[]>([]);
  /** Credentials the user explicitly marked for removal, keyed `kind:key`. */
  const [clearedCredentials, setClearedCredentials] = useState<Set<string>>(new Set());

  const toggleCredentialCleared = useCallback((kind: 'env' | 'headers', key: string) => {
    setClearedCredentials((prev) => {
      const next = new Set(prev);
      const id = `${kind}:${key}`;
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isCredentialCleared = useCallback(
    (kind: 'env' | 'headers', key: string) => clearedCredentials.has(`${kind}:${key}`),
    [clearedCredentials]
  );

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

  const clearOauthPending = useCallback((id: string) => {
    setOauthPending((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }, []);

  const pollOAuth = useCallback((id: string) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const st = await api.getMcpOAuthStatus(id);
        if (st.status === 'authorized') {
          clearInterval(timer); clearOauthPending(id); await loadServers();
        } else if (st.status === 'error') {
          clearInterval(timer); clearOauthPending(id); setError(st.error ?? 'Authorization failed');
        } else if (Date.now() - started > 120_000) {
          clearInterval(timer); clearOauthPending(id); setError('Authorization timed out. Click Connect to retry.');
        }
      } catch { /* transient; keep polling */ }
    }, 1500);
  }, [loadServers, clearOauthPending]);

  const handleConnect = useCallback(async (id: string) => {
    setError(null);
    const server = servers.find((s) => s.id === id);
    try {
      await api.connectMcpServer(id);
      await loadServers();
      if (selectedServerId === id) {
        const data = await api.getMcpTools(id);
        setTools(data.tools);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to connect';
      const isHttp = server && (server.transport === 'streamable-http' || server.transport === 'sse');
      if (isHttp) {
        // Interactive OAuth: open the provider's login in the browser, then reconnect.
        try {
          const start = await api.startMcpOAuth(id);
          if (start.authorizationUrl) {
            window.open(start.authorizationUrl, '_blank', 'noopener');
            setOauthPending((prev) => new Set(prev).add(id));
            pollOAuth(id);
            return;
          }
          if (start.status === 'authorized') { await loadServers(); return; }
          setError(`${start.error ?? msg} — if this server does not support OAuth login, add an Authorization header via Edit.`);
        } catch { setError(msg); }
      } else {
        setError(msg);
      }
    }
  }, [loadServers, selectedServerId, servers, pollOAuth]);

  const handleRevokeOAuth = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.revokeMcpOAuth(id);
      clearOauthPending(id);
      await loadServers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke authorization');
    }
  }, [loadServers, clearOauthPending]);

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

  const handleUpdate = useCallback(async (data: {
    name?: string;
    transport?: MCPTransportType;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    cwd?: string;
    headers?: Record<string, string>;
  }) => {
    setError(null);
    try {
      const updated = await api.updateMcpServer(editingServer!.id, data);
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setOpenForm(false);
      setEditingServer(null);
      if (selectedServerId === updated.id) {
        const data = await api.getMcpTools(updated.id);
        setTools(data.tools);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update server');
    }
  }, [editingServer, selectedServerId]);

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

  const openTestDialog = useCallback((tool: MCPTool) => {
    setTestingTool(tool);
  }, []);

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
  const isConnecting = (s: MCPServer) => s.status === 'connecting';
  const hasError = (s: MCPServer) => s.status === 'error' || !!s.last_error;

  // Detect duplicate server names (case-insensitive)
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of servers) {
      const key = s.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [servers]);

  const isDuplicateName = (s: MCPServer) => (nameCounts.get(s.name.toLowerCase()) ?? 0) > 1;

  // Get a short display identifier for dedup
  const serverIdentity = (s: MCPServer) => {
    if (s.transport === 'stdio') return s.command ?? s.name;
    return s.url ?? s.name;
  };

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
          onClick={() => { setEditingServer(null); setClearedCredentials(new Set()); setOpenForm(true); }}
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
                <td className="py-2 font-medium">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{s.name}</span>
                    {isDuplicateName(s) && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-500">
                        Duplicate name
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate" title={`id: ${s.id}`}>
                    {serverIdentity(s)}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70 truncate font-mono" title={s.id}>
                    {s.id.replace(/^mcp-server:/, '').slice(0, 8)}
                  </p>
                </td>
                <td className="py-2">{s.transport}</td>
                <td className="py-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge(s.status)}`}>
                    <Circle className={`h-2 w-2 ${isConnected(s) ? 'bg-current' : isConnecting(s) ? 'bg-yellow-500' : 'bg-muted'}`} />
                    {s.status}
                  </span>
                  {hasError(s) && s.last_error && (
                    <p className="text-[10px] text-red-500 mt-1">{s.last_error}</p>
                  )}
                </td>
                <td className="py-2 text-right">
                  <div className="flex flex-col items-end gap-1">
                    {!isConnected(s) ? (
                      <>
                        <button
                          onClick={() => handleConnect(s.id)}
                          disabled={oauthPending.has(s.id)}
                          className="px-3 py-1 text-xs font-medium rounded-md border bg-green-500/10 text-green-600 hover:bg-green-500/20 disabled:opacity-60"
                        >
                          {oauthPending.has(s.id) ? 'Awaiting login…' : 'Connect'}
                        </button>
                        {hasError(s) && !oauthPending.has(s.id) && (
                          <button
                            onClick={() => handleConnect(s.id)}
                            className="ml-1 px-3 py-1 text-xs font-medium rounded-md border bg-orange-500/10 text-orange-600 hover:bg-orange-500/20"
                          >
                            Retry
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleDisconnect(s.id)}
                        className="px-3 py-1 text-xs font-medium rounded-md border bg-red-500/10 text-red-600 hover:bg-red-500/20"
                      >
                        Disconnect
                      </button>
                    )}
                    {(s.transport === 'streamable-http' || s.transport === 'sse') && (
                      <button
                        onClick={() => handleRevokeOAuth(s.id)}
                        title="Clear stored OAuth authorization for this server"
                        className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                      >
                        Revoke login
                      </button>
                    )}
                    <button
                      onClick={() => loadTools(s.id)}
                      className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                    >
                      <Sliders className="h-3 w-3 mr-1" /> Tools
                    </button>
                    <button
                      onClick={() => { setEditingServer(s); setClearedCredentials(new Set()); setOpenForm(true); }}
                      className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                    >
                      <Edit2 className="h-3 w-3 mr-1" /> Edit
                    </button>
                    <button
                      onClick={() => { setDeletingServer(s.id); }}
                      className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
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
                      onClick={() => openTestDialog(t)}
                      className="px-2 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                    >
                      Test
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <McpToolTestDialog tool={testingTool} serverId={selectedServerId} onClose={() => setTestingTool(null)} />

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
                            className={`px-2 py-1 text-xs font-medium rounded border transition ${ perm?.allowed ? 'bg-green-500/20 text-green-600 border-green-500/30' : 'bg-muted text-muted-foreground border-muted/30' }`}
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
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
              onClick={() => setOpenForm(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
                role="dialog" aria-modal="true" aria-label={editingServer ? 'Edit Server' : 'Add MCP Server'}
                className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl"
              >
              <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
                <h3 className="font-semibold">{editingServer ? 'Edit Server' : 'Add MCP Server'}</h3>
                <button onClick={() => setOpenForm(false)} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
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
                    env: buildCredentialPayload(
                      Array.from(formData.getAll('env_key')).map((key, i) => ({
                        key: (key as string),
                        value: (formData.getAll('env_value')[i] as string) ?? '',
                      })),
                      clearedCredentials,
                      'env'
                    ),
                    cwd: (formData.get('cwd') as string) || undefined,
                    headers: buildCredentialPayload(
                      Array.from(formData.getAll('header_key')).map((key, i) => ({
                        key: (key as string),
                        value: (formData.getAll('header_value')[i] as string) ?? '',
                      })),
                      clearedCredentials,
                      'headers'
                    ),
                  };
                  if (editingServer) {
                    handleUpdate(data);
                  } else {
                    handleCreate(data);
                  }
                }}
                className="flex flex-1 min-h-0 flex-col"
              >
                <div className="space-y-3 min-h-0 flex-1 overflow-y-auto px-6 py-4">
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
                {editingServer?.transport !== 'streamable-http' && editingServer?.transport !== 'sse' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Command (stdio)</label>
                    <input
                      name="command"
                      defaultValue={editingServer?.command ?? ''}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="e.g. npx mcp-server-git"
                    />
                  </div>
                )}
                {editingServer?.transport !== 'streamable-http' && editingServer?.transport !== 'sse' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Args (comma-separated)</label>
                    <input
                      name="args"
                      defaultValue={editingServer?.args?.join(', ') ?? ''}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="e.g. --tool, --option"
                    />
                  </div>
                )}
                {(editingServer?.transport === 'streamable-http' || editingServer?.transport === 'sse') && (
                  <div>
                    <label className="block text-sm font-medium mb-1">URL</label>
                    <input
                      name="url"
                      defaultValue={editingServer?.url ?? ''}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="e.g. https://example.com/mcp"
                      required
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium mb-1">Working directory (cwd)</label>
                  <input
                    name="cwd"
                    defaultValue={editingServer?.cwd ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. /home/user/project"
                  />
                </div>
                {(editingServer?.transport === 'streamable-http' || editingServer?.transport === 'sse') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">Environment Variables</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Credentials are stored encrypted. Redacted values below indicate existing secrets;
                        leave unchanged to preserve them.
                      </p>
                      <div className="space-y-1">
                        {envPairs(editingServer?.env ?? {}).map(({ key, value }, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <input
                              name="env_key"
                              defaultValue={key}
                              className="border rounded px-2 py-1 text-sm w-1/3"
                              readOnly
                            />
                            <input
                              name="env_value"
                              defaultValue={value === '[REDACTED]' ? '' : value}
                              disabled={isCredentialCleared('env', key)}
                              className="border rounded px-2 py-1 text-sm w-2/3 disabled:opacity-50"
                              placeholder={isCredentialCleared('env', key) ? 'Will be removed' : 'Enter value to change'}
                            />
                            <button
                              type="button"
                              onClick={() => toggleCredentialCleared('env', key)}
                              className={`shrink-0 px-2 py-1 text-xs font-medium rounded border ${isCredentialCleared('env', key) ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-border text-muted-foreground hover:bg-muted'}`}
                              title={isCredentialCleared('env', key) ? 'Undo removal' : 'Remove this credential on save'}
                            >
                              {isCredentialCleared('env', key) ? 'Undo' : 'Clear'}
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            const container = e.currentTarget.parentElement!;
                            const row = document.createElement('div');
                            row.className = 'flex gap-2';
                            row.innerHTML = `
                              <input name="env_key" class="border rounded px-2 py-1 text-sm w-1/3" placeholder="KEY">
                              <input name="env_value" class="border rounded px-2 py-1 text-sm w-2/3" placeholder="value">
                              <button type="button" class="text-red-500 hover:text-red-700">×</button>
                            `;
                            row.querySelector('button')!.addEventListener('click', () => row.remove());
                            container.insertBefore(row, container.lastElementChild);
                          }}
                          className="text-xs text-primary hover:text-primary/90"
                        >
                          + Add variable
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">HTTP Headers</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Sent with every HTTP request to this MCP server.
                      </p>
                      <div className="space-y-1">
                        {envPairs(editingServer?.headers ?? {}).map(({ key, value }, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <input
                              name="header_key"
                              defaultValue={key}
                              className="border rounded px-2 py-1 text-sm w-1/3"
                              readOnly
                            />
                            <input
                              name="header_value"
                              defaultValue={value === '[REDACTED]' ? '' : value}
                              disabled={isCredentialCleared('headers', key)}
                              className="border rounded px-2 py-1 text-sm w-2/3 disabled:opacity-50"
                              placeholder={isCredentialCleared('headers', key) ? 'Will be removed' : 'Enter value to change'}
                            />
                            <button
                              type="button"
                              onClick={() => toggleCredentialCleared('headers', key)}
                              className={`shrink-0 px-2 py-1 text-xs font-medium rounded border ${isCredentialCleared('headers', key) ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-border text-muted-foreground hover:bg-muted'}`}
                              title={isCredentialCleared('headers', key) ? 'Undo removal' : 'Remove this credential on save'}
                            >
                              {isCredentialCleared('headers', key) ? 'Undo' : 'Clear'}
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            const container = e.currentTarget.parentElement!;
                            const row = document.createElement('div');
                            row.className = 'flex gap-2';
                            row.innerHTML = `
                              <input name="header_key" class="border rounded px-2 py-1 text-sm w-1/3" placeholder="KEY">
                              <input name="header_value" class="border rounded px-2 py-1 text-sm w-2/3" placeholder="value">
                              <button type="button" class="text-red-500 hover:text-red-700">×</button>
                            `;
                            row.querySelector('button')!.addEventListener('click', () => row.remove());
                            container.insertBefore(row, container.lastElementChild);
                          }}
                          className="text-xs text-primary hover:text-primary/90"
                        >
                          + Add header
                        </button>
                      </div>
                    </div>
                  </>
                )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4 shrink-0">
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
            </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirm */}
      <AnimatePresence>
        {deletingServer && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
            onClick={() => setDeletingServer(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog" aria-modal="true" aria-label="Delete MCP Server"
              className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl"
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function envPairs(obj: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

/**
 * Build the credential payload for a create/update request.
 *
 * - A value the user typed replaces the stored credential.
 * - An empty value means "leave the stored credential untouched" (stored
 *   secrets are redacted, so the field always starts empty).
 * - A credential the user explicitly cleared is sent with the clear marker.
 */
function buildCredentialPayload(
  pairs: { key: string; value: string }[],
  cleared: Set<string>,
  kind: 'env' | 'headers'
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    if (cleared.has(`${kind}:${trimmedKey}`)) {
      out[trimmedKey] = MCP_CREDENTIAL_CLEAR;
      continue;
    }
    if (value === '') continue; // unchanged — keep the stored credential
    out[trimmedKey] = value;
  }
  return out;
}
