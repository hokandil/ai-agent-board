import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Search, X } from 'lucide-react';
import type {
  MCPServer, MCPTool, Project, McpImportPreviewResult, McpImportResult,
} from '@/types';
import { api } from '@/lib/api';
import { McpSchemaArgsForm, asJsonSchema, validateRequiredArgs } from './McpSchemaArgsForm';

interface Props {
  open: boolean;
  servers: MCPServer[];
  onClose: () => void;
  onImported: () => void;
}

const LISTING_HINT = /(list|search|query|find|index|recall|task|issue|ticket|story|project|item|node)/i;

function looksLikeListingTool(tool: MCPTool): boolean {
  return LISTING_HINT.test(tool.name) || LISTING_HINT.test(tool.description ?? '');
}

function rankForListing(tools: MCPTool[]): MCPTool[] {
  const score = (tool: MCPTool): number => {
    let value = 0;
    if (/(list|search|query|find)/i.test(tool.name)) value += 2;
    if (/(task|issue|ticket|story|project|item)/i.test(tool.name)) value += 2;
    if (/(list|search|query|find|retrieve)/i.test(tool.description ?? '')) value += 1;
    return value;
  };
  return [...tools]
    .map((tool, index) => ({ tool, index, score: score(tool) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.tool);
}

export function McpTaskImportDialog({ open, servers, onClose, onImported }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [serverId, setServerId] = useState('');
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const [toolName, setToolName] = useState('');
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [useJson, setUseJson] = useState(false);
  const [argsJson, setArgsJson] = useState('{}');
  const [preview, setPreview] = useState<McpImportPreviewResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<McpImportResult | null>(null);

  const connectedServers = useMemo(
    () => servers.filter((server) => server.status === 'connected'),
    [servers],
  );

  const tool = tools.find((candidate) => candidate.name === toolName);
  const schema = asJsonSchema(tool?.inputSchema);
  const visibleTools = useMemo(() => {
    const ranked = rankForListing(tools);
    return showAllTools ? ranked : ranked.filter(looksLikeListingTool);
  }, [tools, showAllTools]);

  const resetState = useCallback(() => {
    setServerId('');
    setTools([]);
    setToolName('');
    setArgs({});
    setArgsJson('{}');
    setUseJson(false);
    setPreview(null);
    setSelected(new Set());
    setError(null);
    setResult(null);
    setShowAllTools(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetState();
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getProjects();
        if (cancelled) return;
        setProjects(list);
        const preferred = list.find((project) => project.id === 'default') ?? list[0];
        setProjectId(preferred?.id ?? '');
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load projects');
      }
    })();
    return () => { cancelled = true; };
  }, [open, resetState]);

  const loadTools = useCallback(async (nextServerId: string) => {
    setTools([]);
    setToolName('');
    setPreview(null);
    setSelected(new Set());
    if (!nextServerId) return;
    setToolsLoading(true);
    setError(null);
    try {
      const data = await api.getMcpTools(nextServerId);
      setTools(data.tools);
      const ranked = rankForListing(data.tools).filter(looksLikeListingTool);
      if (ranked.length > 0) setToolName(ranked[0].name);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to discover MCP tools');
    } finally {
      setToolsLoading(false);
    }
  }, []);

  const buildArguments = useCallback((): Record<string, unknown> | null => {
    if (useJson) {
      try {
        const parsed = JSON.parse(argsJson || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Arguments must be a JSON object');
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch (err: unknown) {
        setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    const missing = validateRequiredArgs(schema, args);
    if (missing) {
      setError(missing);
      return null;
    }
    return { ...args };
  }, [useJson, argsJson, schema, args]);

  const runPreview = useCallback(async () => {
    if (!serverId) { setError('Select an MCP server first'); return; }
    if (!toolName) { setError('Select a listing tool first'); return; }
    const toolArgs = buildArguments();
    if (!toolArgs) return;
    setPreviewLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.previewMcpImport({ serverId, toolName, arguments: toolArgs });
      setPreview(data);
      setSelected(new Set(data.tasks.filter((task) => !task.alreadyImported).map((task) => task.externalKey)));
    } catch (err: unknown) {
      setPreview(null);
      setSelected(new Set());
      setError(err instanceof Error ? err.message : 'Failed to preview external tasks');
    } finally {
      setPreviewLoading(false);
    }
  }, [serverId, toolName, buildArguments]);

  const runImport = useCallback(async () => {
    if (!preview || !projectId) return;
    const selection = preview.tasks
      .filter((task) => selected.has(task.externalKey))
      .map((task) => ({
        externalKey: task.externalKey,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        columnId: task.columnId,
      }));
    if (selection.length === 0) { setError('Select at least one task to import'); return; }
    setImporting(true);
    setError(null);
    try {
      const data = await api.importMcpTasks({
        serverId,
        projectId,
        toolName,
        externalSource: preview.externalSource,
        tasks: selection,
      });
      setResult(data);
      onImported();
      // Re-preview so imported rows switch to "already imported".
      try {
        const refreshed = await api.previewMcpImport({
          serverId,
          toolName,
          arguments: buildArguments() ?? {},
          externalSource: preview.externalSource,
        });
        setPreview(refreshed);
      } catch {
        // The import already succeeded; keep the current preview visible.
      }
      setSelected(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [preview, projectId, selected, serverId, toolName, buildArguments, onImported]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectableCount = preview?.tasks.filter((task) => !task.alreadyImported).length ?? 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label="Import External Tasks"
            data-testid="mcp-import-dialog"
            className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
              <div>
                <h3 className="font-semibold">Import External Tasks</h3>
                <p className="text-xs text-muted-foreground">
                  List tasks from an MCP server and create board tasks in a project, even when it is empty.
                </p>
              </div>
              <button onClick={onClose} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="import-project-select" className="block text-sm font-medium mb-1">Target Project</label>
                  <select
                    id="import-project-select"
                    data-testid="import-project-select"
                    className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                    value={projectId}
                    onChange={(e) => { setProjectId(e.target.value); setResult(null); }}
                  >
                    <option value="">Select a project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="import-server-select" className="block text-sm font-medium mb-1">MCP Server</label>
                  <select
                    id="import-server-select"
                    data-testid="import-server-select"
                    className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                    value={serverId}
                    onChange={(e) => { setServerId(e.target.value); void loadTools(e.target.value); }}
                  >
                    <option value="">Select a connected server</option>
                    {connectedServers.map((server) => (
                      <option key={server.id} value={server.id}>{server.name}</option>
                    ))}
                  </select>
                  {connectedServers.length === 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      No connected MCP servers. Connect one on the MCP Servers page first.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="import-tool-select" className="block text-sm font-medium mb-1">Listing Tool</label>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      data-testid="import-show-all-tools"
                      checked={showAllTools}
                      onChange={(e) => setShowAllTools(e.target.checked)}
                    />
                    Show all tools
                  </label>
                </div>
                <select
                  id="import-tool-select"
                  data-testid="import-tool-select"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  value={toolName}
                  onChange={(e) => {
                    setToolName(e.target.value);
                    setArgs({});
                    setPreview(null);
                    setSelected(new Set());
                    setResult(null);
                  }}
                  disabled={toolsLoading || visibleTools.length === 0}
                >
                  <option value="">{toolsLoading ? 'Discovering tools…' : 'Select a tool'}</option>
                  {visibleTools.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>
                      {candidate.name}{candidate.description ? ` — ${candidate.description}` : ''}
                    </option>
                  ))}
                </select>
                {!toolsLoading && serverId && tools.length === 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    No tools discovered on this server.
                  </p>
                )}
                {!toolsLoading && tools.length > 0 && visibleTools.length === 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    No listing-like tools matched. Enable “Show all tools” to choose any discovered tool.
                  </p>
                )}
              </div>

              {tool && (
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-sm font-medium">{tool.name}</span>
                      {tool.description && (
                        <p className="text-xs text-muted-foreground">{tool.description}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setUseJson(false)}
                        className={`px-2 py-1 text-xs rounded border ${!useJson ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                      >
                        Form
                      </button>
                      <button
                        type="button"
                        onClick={() => setUseJson(true)}
                        className={`px-2 py-1 text-xs rounded border ${useJson ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                      >
                        JSON
                      </button>
                    </div>
                  </div>
                  {useJson ? (
                    <textarea
                      data-testid="import-args-json"
                      className="w-full h-28 font-mono text-xs border border-border rounded p-2 bg-background"
                      value={argsJson}
                      onChange={(e) => setArgsJson(e.target.value)}
                    />
                  ) : (
                    <McpSchemaArgsForm
                      schema={schema}
                      values={args}
                      onChange={setArgs}
                      idPrefix="import-arg"
                    />
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    Required fields are marked * and are validated before the tool is called.
                    Read-only listing tools are recommended; the import never changes external tasks.
                  </p>
                </div>
              )}

              {error && (
                <div data-testid="import-error" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  data-testid="import-preview-button"
                  onClick={() => { void runPreview(); }}
                  disabled={previewLoading || !serverId || !toolName}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <Search className="h-4 w-4" />
                  {previewLoading ? 'Loading…' : 'Preview Tasks'}
                </button>
                {result && (
                  <p data-testid="import-summary" className="text-sm">
                    Imported {result.imported.length}, skipped {result.skipped.length}.
                  </p>
                )}
              </div>

              {preview?.limitation && (
                <div data-testid="import-limitation" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                  {preview.limitation}
                </div>
              )}

              {preview && preview.tasks.length > 0 && (
                <div className="rounded-lg border overflow-hidden">
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs text-muted-foreground sticky top-0">
                        <tr>
                          <th className="p-2 w-8" />
                          <th className="p-2">External ID</th>
                          <th className="p-2">Title</th>
                          <th className="p-2">Status → Column</th>
                          <th className="p-2">Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.tasks.map((task) => {
                          const disabled = task.alreadyImported;
                          return (
                            <tr
                              key={task.externalKey}
                              data-testid={`import-row-${task.externalKey}`}
                              className={`border-t ${disabled ? 'opacity-60' : ''}`}
                            >
                              <td className="p-2 align-top">
                                <input
                                  type="checkbox"
                                  data-testid={`import-select-${task.externalKey}`}
                                  checked={selected.has(task.externalKey)}
                                  disabled={disabled}
                                  onChange={() => toggle(task.externalKey)}
                                  aria-label={`Select ${task.title}`}
                                />
                              </td>
                              <td className="p-2 align-top font-mono text-xs">{task.externalKey}</td>
                              <td className="p-2 align-top">
                                <div className="font-medium">{task.title}</div>
                                {task.description && (
                                  <div className="text-xs text-muted-foreground line-clamp-2">{task.description}</div>
                                )}
                                {disabled && (
                                  <div className="text-xs text-muted-foreground">Already imported</div>
                                )}
                              </td>
                              <td className="p-2 align-top text-xs">
                                <span className="text-muted-foreground">{task.status ?? '(none)'}</span>
                                <span className="mx-1">→</span>
                                <span className="font-medium">{task.columnId}</span>
                              </td>
                              <td className="p-2 align-top text-xs">
                                <span className="text-muted-foreground">{task.priority ?? '(none)'}</span>
                                <span className="mx-1">→</span>
                                <span className="font-medium">{task.boardPriority}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4 shrink-0">
              <span className="text-xs text-muted-foreground">
                {selected.size} of {selectableCount} selectable task(s) selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-1.5 text-sm font-medium rounded-md border text-muted-foreground hover:bg-muted"
                >
                  Close
                </button>
                <button
                  type="button"
                  data-testid="import-confirm-button"
                  onClick={() => { void runImport(); }}
                  disabled={importing || selected.size === 0 || !projectId}
                  className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <ArrowRight className="h-4 w-4" />
                  {importing ? 'Importing…' : `Import ${selected.size || ''} task(s)`}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
