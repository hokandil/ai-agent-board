import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X, Bot, Loader2, AlertCircle, RefreshCw, CheckCircle2, Circle, Settings2, Terminal,
} from 'lucide-react';
import type { ManagedAgent, AgentType, MCPServer, SkillInfo } from '@/types';
import { AGENT_DISPLAY } from '@/lib/agent-config';
import { api } from '@/lib/api';

const labelFor = (provider: AgentType) => AGENT_DISPLAY[provider]?.label ?? provider;
const displayNameFor = (agent: ManagedAgent) => agent.detection?.displayName ?? labelFor(agent.provider);

/** Shared centered, scrollable dialog shell (themed, viewport-clamped). */
function Modal({
  title, onClose, children, width = 'max-w-lg',
}: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <motion.div
          role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}
          initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className={`flex max-h-[90vh] w-full ${width} flex-col rounded-xl border border-border bg-card
            text-card-foreground shadow-2xl`}
        >
          <div className="flex items-center justify-between border-b border-border px-6 py-4 shrink-0">
            <h2 className="text-base font-semibold">{title}</h2>
            <button
              type="button" onClick={onClose} aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        </motion.div>
      </div>
    </>
  );
}

/** Close a modal on Escape (keyboard dismissal). Attaches a one-time document listener. */
function useEscapeClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}

function DetectionBadge({ agent }: { agent: ManagedAgent }) {
  const d = agent.detection;
  if (!d) return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Unknown</span>;
  if (d.available) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> Available{d.version ? ` · v${d.version}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title={d.reason}>
      <Circle className="h-3.5 w-3.5" /> Unavailable
    </span>
  );
}

type FormState = {
  model: string;
  instructions: string;
  command: string;
  mcpServerIds: string[];
  skillIds: string[];
  enabled: boolean;
};

export function AgentsPage() {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const [editing, setEditing] = useState<ManagedAgent | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, servers, skillList] = await Promise.all([
        api.getManagedAgents(),
        api.getMcpServers().catch(() => [] as MCPServer[]),
        api.getSkills().catch(() => [] as SkillInfo[]),
      ]);
      setAgents(list);
      setMcpServers(servers);
      setSkills(skillList);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRescan = useCallback(async () => {
    setRescanning(true);
    setLoadError(null);
    try {
      const list = await api.rescanAgents();
      setAgents(list);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Re-scan failed');
    } finally {
      setRescanning(false);
    }
  }, []);

  const openConfig = (agent: ManagedAgent) => {
    setForm({
      model: agent.config?.model ?? '',
      instructions: agent.config?.instructions ?? '',
      command: agent.config?.command ?? '',
      mcpServerIds: [...(agent.config?.mcpServerIds ?? [])],
      skillIds: [...(agent.config?.skillIds ?? [])],
      enabled: agent.config?.enabled ?? true,
    });
    setFormError(null);
    setEditing(agent);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || !form) return;
    setFormError(null);
    setSaving(true);
    try {
      const updated = await api.saveAgentConfig(editing.provider, {
        model: form.model.trim() || null,
        instructions: form.instructions.trim() || null,
        command: form.command.trim() || null,
        mcpServerIds: form.mcpServerIds,
        skillIds: form.skillIds,
        enabled: form.enabled,
      });
      // Replace the edited row with the server's fresh view (detection may have changed).
      setAgents((prev) => prev.map((a) => (a.provider === updated.provider ? updated : a)));
      setEditing(null);
      setForm(null);
    } catch (err: unknown) {
      // Keep the modal open and preserve typed input on failure.
      setFormError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const toggleInList = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  useEscapeClose(!!editing, () => { setEditing(null); setForm(null); });

  const availableCount = agents.filter((a) => a.detection?.available).length;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Bot className="h-5 w-5" /> Agents</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Configure the coding-agent executors installed on this machine. Each executor is a real CLI
            (an adapter); selecting it for a task applies this saved configuration. There are no separate
            “profiles” — one configuration per executor.
          </p>
        </div>
        <button
          onClick={() => void handleRescan()}
          disabled={rescanning}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {rescanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Re-scan executors
        </button>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Detecting installed agents…
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{availableCount} of {agents.length} executors available on this machine.</p>
          {agents.map((agent) => {
            const configured = !!agent.config;
            return (
              <div key={agent.provider} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Terminal className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{displayNameFor(agent)}</span>
                        <DetectionBadge agent={agent} />
                        {configured && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Configured</span>
                        )}
                        {agent.config && !agent.config.enabled && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Disabled</span>
                        )}
                      </div>
                      {agent.detection && !agent.detection.available && agent.detection.reason && (
                        <p className="mt-1 max-w-xl text-xs text-muted-foreground">{agent.detection.reason}</p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => openConfig(agent)}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <Settings2 className="h-4 w-4" /> Configure
                  </button>
                </div>

                {agent.capabilities.limitations.length > 0 && (
                  <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
                    {agent.capabilities.limitations.map((l) => (
                      <li key={l}>• {l}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {editing && form && (
          <Modal title={`Configure ${displayNameFor(editing)}`} onClose={() => { setEditing(null); setForm(null); }}>
            <form onSubmit={handleSubmit} className="space-y-4">
              {!editing.detection?.available && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                  This executor is not currently available{editing.detection?.reason ? `: ${editing.detection.reason}` : ''}.
                  You can still save configuration, but tasks using it will report this diagnosis until it is installed/ready.
                </div>
              )}

              {/* Model — capability-gated, honestly labeled. */}
              <div>
                <label htmlFor="agent-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">Model</label>
                <input
                  id="agent-model"
                  value={form.model}
                  onChange={(e) => setForm((f) => (f ? { ...f, model: e.target.value } : f))}
                  disabled={editing.capabilities.model === 'native'}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                  placeholder={editing.capabilities.model === 'native' ? 'Not configurable — see note' : 'leave empty for provider default'}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {editing.capabilities.model === 'session' && 'The saved model is applied to each run of this agent.'}
                  {editing.capabilities.model === 'startup' && 'This provider fixes its model at startup; saving applies it on the next server restart.'}
                  {editing.capabilities.model === 'native' && 'This provider reads its active model from its own configuration, so the Board cannot change it here.'}
                </p>
              </div>

              {/* Instructions / persona — supported for all. */}
              {editing.capabilities.instructions && (
                <div>
                  <label htmlFor="agent-instructions" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Instructions / persona
                  </label>
                  <textarea
                    id="agent-instructions"
                    value={form.instructions}
                    onChange={(e) => setForm((f) => (f ? { ...f, instructions: e.target.value } : f))}
                    rows={4}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="System instructions applied to every run of this agent…"
                  />
                </div>
              )}

              {/* Executable path — only where the adapter accepts a command. */}
              {editing.capabilities.commandConfigurable && (
                <div>
                  <label htmlFor="agent-command" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Executable / command path
                  </label>
                  <input
                    id="agent-command"
                    value={form.command}
                    onChange={(e) => setForm((f) => (f ? { ...f, command: e.target.value } : f))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="Command or absolute path (leave empty for default)"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Lets you point this executor at an installed CLI that auto-detection missed. Saving applies to new sessions immediately.
                  </p>
                </div>
              )}

              {/* MCP servers — only where delivered. */}
              {editing.capabilities.mcp && (
                <fieldset className="rounded-lg border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">MCP servers</legend>
                  {mcpServers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No MCP servers configured. Add some on the MCP Servers page.</p>
                  ) : (
                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      {mcpServers.map((s) => (
                        <label key={s.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={form.mcpServerIds.includes(s.id)}
                            onChange={() => setForm((f) => (f ? { ...f, mcpServerIds: toggleInList(f.mcpServerIds, s.id) } : f))}
                          />
                          <span>{s.name}</span>
                          <span className="text-xs text-muted-foreground">({s.transport})</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
              )}

              {/* Skills — only where delivered. */}
              {editing.capabilities.skills && (
                <fieldset className="rounded-lg border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">Skills</legend>
                  {skills.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No skills discovered on the server.</p>
                  ) : (
                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      {skills.map((sk) => (
                        <label key={sk.name} className="flex items-center gap-2 text-sm" title={sk.description}>
                          <input
                            type="checkbox"
                            checked={form.skillIds.includes(sk.name)}
                            onChange={() => setForm((f) => (f ? { ...f, skillIds: toggleInList(f.skillIds, sk.name) } : f))}
                          />
                          <span>{sk.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => (f ? { ...f, enabled: e.target.checked } : f))}
                />
                <span>Enabled (available for task execution)</span>
              </label>

              {formError && (
                <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {formError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button" onClick={() => { setEditing(null); setForm(null); }}
                  className="rounded-md border border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit" disabled={saving}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save configuration
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

export default AgentsPage;
