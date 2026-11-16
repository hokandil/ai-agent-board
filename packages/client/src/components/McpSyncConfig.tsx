import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight, Circle, Plus, RefreshCw,
  Sliders, Trash2, X, Edit2,
} from 'lucide-react';
import type {
  SyncConnection, SyncDirection, ConflictPolicy,
  SyncFieldMapping, SyncConflict, SyncResult,
  MCPServer, MCPTool, Task,
} from '@/types';
import { api } from '@/lib/api';

type DirectionOption = { value: SyncDirection; label: string };
type PolicyOption = { value: ConflictPolicy; label: string };

const DIRECTION_OPTIONS: DirectionOption[] = [
  { value: 'import_only', label: 'Import only (external → board)' },
  { value: 'export_only', label: 'Export only (board → external)' },
  { value: 'bidirectional', label: 'Bidirectional (both ways)' },
];

const POLICY_OPTIONS: PolicyOption[] = [
  { value: 'board_wins', label: 'Board wins on conflict' },
  { value: 'external_wins', label: 'External wins on conflict' },
  { value: 'manual', label: 'Manual resolution (create conflict)' },
];

export function McpSyncConfig() {
  const [connections, setConnections] = useState<SyncConnection[]>([]);
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState(false);
  const [editingConn, setEditingConn] = useState<SyncConnection | null>(null);
  const [deletingConn, setDeletingConn] = useState<string | null>(null);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [mappings, setMappings] = useState<SyncFieldMapping[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [formServerId, setFormServerId] = useState('');
  const [serverTools, setServerTools] = useState<MCPTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolChoice, setToolChoice] = useState('');
  // Existing board tasks, so a sync connection can be created by picking a task
  // instead of typing an internal task id. `taskIdManual` reveals an advanced
  // free-text field for linking a task that isn't in the loaded list.
  const [boardTasks, setBoardTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState('');
  const [taskIdManual, setTaskIdManual] = useState(false);

  const loadBoardTasks = useCallback(async () => {
    try {
      const list = await api.getTasks();
      setBoardTasks(list);
    } catch {
      // Non-fatal: fall back to manual task id entry.
      setBoardTasks([]);
    }
  }, []);

  const loadServers = useCallback(async () => {
    try {
      const list = await api.getMcpServers();
      setServers(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    }
  }, []);

  const loadConnections = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getSyncConnections();
      setConnections(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sync connections');
    }
  }, []);

  useEffect(() => {
    loadServers();
    loadConnections();
    loadBoardTasks();
  }, [loadServers, loadConnections, loadBoardTasks]);

  /** Task-like tools exposed by an MCP server, used to seed the sync tool picker. */
  const taskLikeTools = useMemo(() => {
    const pattern = /task|issue|plan|story|ticket|work_item|workitem|todo|backlog|requirement/i;
    return serverTools.filter((t) => pattern.test(t.name) || pattern.test(t.description ?? ''));
  }, [serverTools]);

  const loadServerTools = useCallback(async (serverId: string) => {
    if (!serverId) {
      setServerTools([]);
      return;
    }
    setToolsLoading(true);
    try {
      const data = await api.getMcpTools(serverId);
      setServerTools(data.tools);
    } catch {
      setServerTools([]);
    } finally {
      setToolsLoading(false);
    }
  }, []);

  const openAddForm = useCallback(() => {
    setEditingConn(null);
    setFormServerId('');
    setToolChoice('');
    setServerTools([]);
    setTaskId('');
    setTaskIdManual(false);
    setOpenForm(true);
  }, []);

  const openEditForm = useCallback(async (conn: SyncConnection) => {
    setEditingConn(conn);
    setFormServerId(conn.serverId);
    setToolChoice(conn.externalTaskTool);
    setTaskId(conn.taskId);
    // If the linked task isn't in the loaded list (other project / archived), fall
    // back to the advanced manual id field so the value is still visible & editable.
    setTaskIdManual(!boardTasks.some((t) => t.id === conn.taskId));
    setOpenForm(true);
    await loadServerTools(conn.serverId);
  }, [loadServerTools, boardTasks]);

  const loadConnectionDetail = useCallback(async (id: string) => {
    setMappingLoading(true);
    try {
      const [mappings, conflicts] = await Promise.all([
        api.getSyncFieldMappings(id),
        api.getSyncConflicts(id),
      ]);
      setMappings(mappings);
      setConflicts(conflicts);
      setSelectedConnId(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load connection details');
    } finally {
      setMappingLoading(false);
    }
  }, []);

  const handleCreate = useCallback(async (data: {
    serverId: string;
    taskId: string;
    externalSource: string;
    externalKey: string;
    externalTaskTool: string;
    syncDirection?: SyncDirection;
    conflictPolicy?: ConflictPolicy;
  }) => {
    setError(null);
    try {
      const created = await api.createSyncConnection(data);
      setConnections((prev) => [...prev, created]);
      setOpenForm(false);
      setEditingConn(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create sync connection');
    }
  }, []);

  const handleUpdate = useCallback(async (data: {
    serverId: string;
    taskId: string;
    externalSource: string;
    externalKey: string;
    externalTaskTool: string;
    syncDirection?: SyncDirection;
    conflictPolicy?: ConflictPolicy;
  }) => {
    if (!editingConn) return;
    setError(null);
    try {
      const updated = await api.updateSyncConnection(editingConn.id, data);
      setConnections((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setOpenForm(false);
      setEditingConn(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update sync connection');
    }
  }, [editingConn]);

  const handleSync = useCallback(async (id: string) => {
    setError(null);
    setSyncResult(null);
    try {
      const result = await api.syncConnection(id);
      setSyncResult(result);
      await loadConnections();
      if (selectedConnId === id) {
        await loadConnectionDetail(id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    }
  }, [loadConnections, selectedConnId, loadConnectionDetail]);

  const handleImport = useCallback(async (id: string) => {
    setError(null);
    try {
      const result = await api.importSyncTask(id);
      setSyncResult({
        connectionId: id,
        syncedAt: Date.now(),
        imported: result.created ? 1 : 0,
        exported: 0,
        conflicts: 0,
        errors: [],
      });
      await loadConnections();
      if (selectedConnId === id) {
        await loadConnectionDetail(id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
  }, [selectedConnId, loadConnectionDetail, loadConnections]);

  const handleExport = useCallback(async (id: string) => {
    setError(null);
    try {
      const result = await api.exportSyncTask(id);
      setSyncResult({
        connectionId: id,
        syncedAt: Date.now(),
        imported: 0,
        exported: result.updated ? 1 : 0,
        conflicts: 0,
        errors: [],
      });
      await loadConnections();
      if (selectedConnId === id) {
        await loadConnectionDetail(id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  }, [selectedConnId, loadConnectionDetail, loadConnections]);

  const handleDelete = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.deleteSyncConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
      if (selectedConnId === id) {
        setSelectedConnId(null);
        setMappings([]);
        setConflicts([]);
      }
      setDeletingConn(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
      setDeletingConn(null);
    }
  }, []);

  const handleCreateMapping = useCallback(async (data: {
    externalField: string;
    boardField: string;
    transform?: SyncFieldMapping['transform'];
    defaultValue?: string;
  }) => {
    if (!selectedConnId) return;
    setError(null);
    try {
      const mapping = await api.createSyncFieldMapping(selectedConnId, data);
      setMappings((prev) => [...prev, mapping]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create mapping');
    }
  }, [selectedConnId]);

  const handleResolveConflict = useCallback(async (id: string, resolvedValue: string, resolvedBy: string) => {
    setError(null);
    try {
      await api.resolveSyncConflict(id, resolvedValue, resolvedBy);
      if (selectedConnId) {
        await loadConnectionDetail(selectedConnId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to resolve conflict');
    }
  }, [selectedConnId, loadConnectionDetail]);

  const handleIgnoreConflict = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.ignoreSyncConflict(id);
      if (selectedConnId) {
        await loadConnectionDetail(selectedConnId);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to ignore conflict');
    }
  }, [selectedConnId, loadConnectionDetail]);

  const statusBadge = (status: string) => {
    const variants: Record<string, string> = {
      connected: 'bg-green-500/20 text-green-600 border-green-500/30',
      error: 'bg-red-500/20 text-red-600 border-red-500/30',
      connecting: 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30',
      disconnected: 'bg-muted text-muted-foreground',
    };
    return variants[status] || variants.disconnected;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Task Synchronization</h2>
          <p className="text-muted-foreground text-sm">
            Connect board tasks to external task systems via MCP. Import tasks,
            sync status changes, and resolve conflicts.
          </p>
        </div>
        <button
          onClick={openAddForm}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add Connection
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Sync connections list */}
      <div className="rounded-lg border p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2">MCP Server</th>
              <th className="pb-2">External Source</th>
              <th className="pb-2">External Key</th>
              <th className="pb-2">Direction</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((c) => {
              const server = servers.find((s) => s.id === c.serverId);
              const serverStatus = server?.status ?? 'disconnected';
              const serverStatusClass = `inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge(serverStatus)}`;
              return (
              <tr key={c.id} className="border-b">
                <td className="py-2 font-medium">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{server?.name ?? c.serverId}</span>
                    <span className={serverStatusClass}>
                      <Circle className={`h-2 w-2 ${server?.status === 'connected' ? 'bg-current' : 'bg-muted'}`} />
                      {serverStatus}
                    </span>
                  </div>
                </td>
                <td className="py-2 font-medium">{c.externalSource}</td>
                <td className="py-2 text-xs text-muted-foreground">{c.externalKey}</td>
                <td className="py-2">{c.syncDirection}</td>
                <td className="py-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge(c.status)}`}>
                    {c.status}
                  </span>
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => handleSync(c.id)}
                    disabled={c.status === 'error'}
                    className="px-3 py-1 text-xs font-medium rounded-md border bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" /> Sync
                  </button>
                  <button
                    onClick={() => handleImport(c.id)}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <ArrowRight className="h-3 w-3 mr-1" /> Import
                  </button>
                  <button
                    onClick={() => handleExport(c.id)}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    Export
                  </button>
                  <button
                    onClick={() => loadConnectionDetail(c.id)}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <Sliders className="h-3 w-3 mr-1" /> Details
                  </button>
                  <button
                    onClick={() => { setDeletingConn(c.id); }}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => { void openEditForm(c); }}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <Edit2 className="h-3 w-3 mr-1" /> Edit
                  </button>
                </td>
              </tr>
              );
            })}
            {connections.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  No sync connections configured. Add one to sync with external task systems.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Selected connection details */}
      {selectedConnId && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sync result */}
          <div className="rounded-lg border p-4">
            <h3 className="font-semibold mb-3">Last Sync Result</h3>
            {syncResult ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Imported:</span>
                  <span className="font-mono">{syncResult.imported}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Exported:</span>
                  <span className="font-mono">{syncResult.exported}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Conflicts:</span>
                  <span className="font-mono">{syncResult.conflicts}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Errors:</span>
                  <span className="font-mono">{syncResult.errors.length}</span>
                </div>
                {syncResult.errors.length > 0 && (
                  <div className="mt-2 text-xs text-red-600">
                    {syncResult.errors.map((e, i) => (
                      <div key={i}>{e.field}: {e.message}</div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No sync has been run yet.</div>
            )}
          </div>

          {/* Field mappings */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Field Mappings</h3>
            </div>
            {mappingLoading ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground">Loading…</div>
            ) : mappings.length === 0 ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground">
                No field mappings configured.
              </div>
            ) : (
              <div className="space-y-1">
                {mappings.map((m) => (
                  <div key={m.id} className="flex items-center justify-between p-2 rounded border border-muted/30">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{m.externalField}</span>
                      <span className="text-xs text-muted-foreground">→</span>
                      <span className="font-medium text-sm">{m.boardField}</span>
                      <span className="text-xs text-muted-foreground ml-1">({m.transform})</span>
                    </div>
                    <button
                      onClick={() => { setDeletingConn(m.id); }}
                      className="px-1 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 pt-3 border-t">
              <label className="block text-sm font-medium mb-1">External Field</label>
              <input
                id="newExtField"
                className="w-full border rounded px-2 py-1 text-sm"
              />
              <label className="block text-sm font-medium mb-1 mt-2">Board Field</label>
              <input
                id="newBoardField"
                className="w-full border rounded px-2 py-1 text-sm"
              />
              <label className="block text-sm font-medium mb-1 mt-2">Transform</label>
              <select
                id="newTransform"
                className="w-full border rounded px-2 py-1 text-sm"
                defaultValue="identity"
              >
                <option value="identity">Identity</option>
                <option value="lowercase">Lowercase</option>
                <option value="uppercase">Uppercase</option>
                <option value="capitalize">Capitalize</option>
                <option value="trim">Trim</option>
              </select>
              <button
                onClick={() => {
                  const ext = (document.getElementById('newExtField') as HTMLInputElement).value;
                  const board = (document.getElementById('newBoardField') as HTMLInputElement).value;
                  const transform = (document.getElementById('newTransform') as HTMLSelectElement).value as SyncFieldMapping['transform'];
                  if (!ext || !board) return;
                  handleCreateMapping({ externalField: ext, boardField: board, transform });
                  (document.getElementById('newExtField') as HTMLInputElement).value = '';
                  (document.getElementById('newBoardField') as HTMLInputElement).value = '';
                }}
                className="px-3 py-1 text-xs font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Add Mapping
              </button>
            </div>
          </div>

          {/* Conflicts */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Conflicts</h3>
            </div>
            {mappingLoading ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground">Loading…</div>
            ) : conflicts.length === 0 ? (
              <div className="h-32 flex items-center justify-center text-muted-foreground">
                No conflicts.
              </div>
            ) : (
              <div className="space-y-2">
                {conflicts.map((c) => (
                  <div key={c.id} className="p-2 rounded border border-amber-500/30 bg-amber-500/10">
                    <div className="flex justify-between mb-1">
                      <span className="font-medium text-sm">{c.externalField} → {c.boardField}</span>
                      <span className="text-xs font-medium">{c.status}</span>
                    </div>
                    <div className="text-xs space-y-1">
                      <span className="text-muted-foreground">External: {c.externalValue ?? '(none)'}</span>
                      <span className="text-muted-foreground">Board: {c.boardValue ?? '(none)'}</span>
                      {c.status === 'pending' && (
                        <div className="flex gap-2 mt-2">
                          <input
                            id={`resolve-input-${c.id}`}
                            className="border rounded px-2 py-1 text-sm w-32"
                            placeholder="Resolved value"
                          />
                          <button
                            onClick={() => {
                              const input = document.getElementById(`resolve-input-${c.id}`) as HTMLInputElement;
                              handleResolveConflict(c.id, input.value, 'user');
                            }}
                            className="px-3 py-1 text-xs font-medium rounded-md border bg-green-500/10 text-green-600 hover:bg-green-500/20"
                          >
                            Resolve
                          </button>
                          <button
                            onClick={() => handleIgnoreConflict(c.id)}
                            className="px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                          >
                            Ignore
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add connection form */}
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
              role="dialog" aria-modal="true" aria-label={editingConn ? 'Edit Connection' : 'Add Sync Connection'}
              className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl"
            >
              <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
                <h3 className="font-semibold">{editingConn ? 'Edit Connection' : 'Add Sync Connection'}</h3>
                <button onClick={() => setOpenForm(false)} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.target as HTMLFormElement);
                  const data = {
                    serverId: (formData.get('serverId') as string) || '',
                    taskId: (formData.get('taskId') as string) || '',
                    externalSource: (formData.get('externalSource') as string) || '',
                    externalKey: (formData.get('externalKey') as string) || '',
                    externalTaskTool:
                      (formData.get('externalTaskToolManual') as string) ||
                      (formData.get('externalTaskTool') as string) ||
                      '',
                    syncDirection: (formData.get('syncDirection') as SyncDirection) ?? 'bidirectional',
                    conflictPolicy: (formData.get('conflictPolicy') as ConflictPolicy) ?? 'board_wins',
                  };
                  if (editingConn) {
                    handleUpdate(data);
                  } else {
                    handleCreate(data);
                  }
                }}
                className="flex flex-1 min-h-0 flex-col"
              >
                <div className="space-y-3 min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div>
                  <label className="block text-sm font-medium mb-1">MCP Server</label>
                  <select
                    name="serverId"
                    value={formServerId}
                    onChange={(e) => {
                      setFormServerId(e.target.value);
                      setToolChoice('');
                      void loadServerTools(e.target.value);
                    }}
                    className="w-full border rounded px-2 py-1 text-sm"
                    required
                  >
                    <option value="">Select an MCP server</option>
                    {servers
                      .filter((s) => s.status === 'connected')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.transport})
                        </option>
                      ))}
                  </select>
                  {servers.length === 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      No MCP servers configured. Add one on the MCP Servers page first.
                    </p>
                  )}
                  {servers.length > 0 && servers.every((s) => s.status !== 'connected') && (
                    <p className="text-xs text-muted-foreground mt-1">
                      No connected MCP servers. Connect a server before adding a sync connection.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Board Task</label>
                  {!taskIdManual ? (
                    <>
                      <select
                        name="taskId"
                        value={taskId}
                        onChange={(e) => setTaskId(e.target.value)}
                        className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                        required={!taskIdManual}
                      >
                        <option value="">Select a board task…</option>
                        {boardTasks.map((t) => (
                          <option key={t.id} value={t.id}>{t.title} — {t.id}</option>
                        ))}
                      </select>
                      <div className="mt-1 flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          The board task this connection links to. Only tasks in the current project are listed.
                        </p>
                        <button
                          type="button"
                          onClick={() => { setTaskIdManual(true); }}
                          className="text-xs text-primary hover:underline shrink-0 ml-2"
                        >
                          Enter manually
                        </button>
                      </div>
                      {boardTasks.length === 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          No board tasks found. Use “Enter manually” to link a task by its ID.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        name="taskId"
                        value={taskId}
                        onChange={(e) => setTaskId(e.target.value)}
                        className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                        placeholder="e.g. task-1699999999999-abc123"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => { setTaskIdManual(false); }}
                        className="text-xs text-primary hover:underline mt-1"
                      >
                        Choose from list instead
                      </button>
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">External Source</label>
                  <input
                    name="externalSource"
                    defaultValue={editingConn?.externalSource ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. github, jira, linear"
                    required
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    A label for the external system. The Board does not enumerate external tasks, so this
                    and the key below are entered to identify the task in that system.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">External Key</label>
                  <input
                    name="externalKey"
                    defaultValue={editingConn?.externalKey ?? ''}
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. issue number, task ID"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">External Task Tool</label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Pick a task-capable tool discovered on the selected MCP server. If the server
                    exposes no task tools, enter the tool name manually.
                  </p>
                  {toolsLoading && (
                    <p className="text-xs text-muted-foreground mb-1">Discovering tools…</p>
                  )}
                  {!toolsLoading && taskLikeTools.length > 0 && (
                    <select
                      name="externalTaskTool"
                      value={toolChoice}
                      onChange={(e) => setToolChoice(e.target.value)}
                      className="w-full border rounded px-2 py-1 text-sm"
                      required
                    >
                      <option value="">Select a discovered task tool</option>
                      {taskLikeTools.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                          {t.description ? ` — ${t.description}` : ''}
                        </option>
                      ))}
                      <option value="__custom__">Other (enter manually)</option>
                    </select>
                  )}
                  {(!toolsLoading && taskLikeTools.length === 0) || toolChoice === '__custom__' ? (
                    <input
                      name="externalTaskToolManual"
                      defaultValue={toolChoice && toolChoice !== '__custom__' ? toolChoice : (editingConn?.externalTaskTool ?? '')}
                      className="w-full border rounded px-2 py-1 text-sm"
                      placeholder="e.g. list_tasks, get_issue"
                      required
                    />
                  ) : null}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Sync Direction</label>
                  <select
                    name="syncDirection"
                    defaultValue={editingConn?.syncDirection ?? 'bidirectional'}
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    {DIRECTION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Conflict Policy</label>
                  <select
                    name="conflictPolicy"
                    defaultValue={editingConn?.conflictPolicy ?? 'board_wins'}
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    {POLICY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
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
                    {editingConn ? 'Save' : 'Add Connection'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirm */}
      <AnimatePresence>
        {deletingConn && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
            onClick={() => setDeletingConn(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              role="dialog" aria-modal="true" aria-label="Delete Sync Connection"
              className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl"
            >
              <h3 className="font-semibold mb-2">Delete Sync Connection?</h3>
              <p className="text-sm text-muted-foreground mb-4">
                This will remove the sync connection. Field mappings and conflicts
                for this connection will also be removed.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeletingConn(null)}
                  className="px-4 py-1.5 text-sm font-medium rounded-md border text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deletingConn!)}
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
