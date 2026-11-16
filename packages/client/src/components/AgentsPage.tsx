import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, X, Bot, Loader2, AlertCircle, RefreshCw, Zap, CheckCircle2, Circle } from 'lucide-react';
import type { AgentProfile, AgentType, MCPServer, SkillInfo } from '@/types';
import { AGENT_OPTIONS } from '@/lib/agent-config';
import { api } from '@/lib/api';

// Providers are execution *backends* (installed coding-agent CLIs). A profile is a
// reusable configuration built on top of one of them. The availability of each backend
// is discovered at runtime (GET /api/agents) and shown separately from profiles.
const PROVIDER_OPTIONS: { value: AgentType; label: string }[] = AGENT_OPTIONS.map((a) => ({
  value: a.value,
  label: a.label,
}));

const providerLabel = (provider: AgentType) =>
  PROVIDER_OPTIONS.find((p) => p.value === provider)?.label ?? provider;

/** Shared centered, scrollable dialog shell used by all modals on this page. */
function Modal({
  title, onClose, children, width = 'max-w-lg',
}: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose}
      />
      {/* Centering is done by a flex overlay, not translate utilities, so Framer's
          transform animation never overrides them. */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <motion.div
          role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
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

type ProfileFormState = {
  name: string;
  provider: AgentType;
  model: string;
  instructions: string;
  mcpServerIds: string[];
  skillIds: string[];
  enabled: boolean;
};

const EMPTY_FORM: ProfileFormState = {
  name: '', provider: 'copilot', model: '', instructions: '',
  mcpServerIds: [], skillIds: [], enabled: true,
};

export function AgentsPage() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [executors, setExecutors] = useState<Record<string, boolean>>({});
  const [defaultModels, setDefaultModels] = useState<Record<string, string | null>>({});
  const [suggestedModels, setSuggestedModels] = useState<Record<string, string[]>>({});

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [openForm, setOpenForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [deletingProfile, setDeletingProfile] = useState<AgentProfile | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, servers, skillList, agents, models] = await Promise.all([
        api.getAgentProfiles(),
        api.getMcpServers().catch(() => [] as MCPServer[]),
        api.getSkills().catch(() => [] as SkillInfo[]),
        api.getAgents().catch(() => [] as import('@/types').AgentInfo[]),
        api.getAgentModels().catch(() => ({ defaultModels: {}, suggestedModels: {} })),
      ]);
      setProfiles(list);
      setMcpServers(servers);
      setSkills(skillList);
      setExecutors(Object.fromEntries(agents.map((a) => [a.name, a.available])));
      setDefaultModels(models.defaultModels ?? {});
      setSuggestedModels(models.suggestedModels ?? {});
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load agent profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setForm(EMPTY_FORM); setEditingId(null); setFormError(null); setOpenForm(true);
  };

  const openEdit = (profile: AgentProfile) => {
    setForm({
      name: profile.name,
      provider: profile.provider,
      model: profile.model ?? '',
      instructions: profile.instructions ?? '',
      mcpServerIds: [...profile.mcpServerIds],
      skillIds: [...profile.skillIds],
      enabled: profile.enabled,
    });
    setEditingId(profile.id);
    setFormError(null);
    setOpenForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) { setFormError('A profile name is required.'); return; }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      provider: form.provider,
      model: form.model.trim() || undefined,
      instructions: form.instructions.trim() || undefined,
      mcpServerIds: form.mcpServerIds,
      skillIds: form.skillIds,
      enabled: form.enabled,
    };
    try {
      if (editingId) await api.updateAgentProfile(editingId, payload);
      else await api.createAgentProfile(payload);
      setOpenForm(false);
      setEditingId(null);
      await load();
    } catch (err: unknown) {
      // Keep the modal open and preserve typed input on a save/validation failure.
      setFormError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingProfile) return;
    setSaving(true);
    try {
      await api.deleteAgentProfile(deletingProfile.id);
      setDeletingProfile(null);
      await load();
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Failed to delete profile');
      setDeletingProfile(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleInList = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  const availableProviderCount = useMemo(
    () => PROVIDER_OPTIONS.filter((p) => executors[p.value] !== false).length,
    [executors],
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Agent Profiles</h1>
          <p className="text-sm text-muted-foreground">
            Reusable agent configurations — provider, model, instructions, MCP servers and skills.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New Profile
          </button>
        </div>
      </div>

      {/* Executors vs Profiles: discovered CLIs vs user-defined configurations */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Discovered executors</h2>
          <span className="text-xs text-muted-foreground">
            Installed coding-agent CLIs available to run profiles ({availableProviderCount}/{PROVIDER_OPTIONS.length})
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_OPTIONS.map((p) => {
            const available = executors[p.value];
            const isKnown = available !== undefined;
            return (
              <span
                key={p.value}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs"
                title={
                  !isKnown ? 'Availability not yet determined'
                    : available ? 'Executor available' : 'CLI not detected — a profile using it cannot run'
                }
              >
                {available === true ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                ) : available === false ? (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/50" />
                )}
                <span className="font-medium">{p.label}</span>
                <span className="text-muted-foreground">
                  {available === true ? 'available' : available === false ? 'unavailable' : 'unknown'}
                </span>
              </span>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Executors are the execution backends. Profiles are reusable configurations built on them —
          these are different concepts. An unavailable CLI cannot execute even if a profile selects it.
        </p>
      </section>

      {loadError && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" /> {loadError}
        </div>
      )}

      {/* Profiles list */}
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Profiles</h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading profiles…
          </div>
        ) : loadError && profiles.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Profiles could not be loaded. Check the error above or press Refresh to retry.
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <Zap className="h-8 w-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">No agent profiles yet</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                An Agent Profile bundles an execution provider, a model, custom instructions, and the
                MCP servers and skills an agent may use. Create one, then assign it to a task to apply
                these settings as defaults.
              </p>
            </div>
            <button
              onClick={openCreate}
              className="mt-1 flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Create your first profile
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 font-medium">MCP servers</th>
                  <th className="px-4 py-2 font-medium">Skills</th>
                  <th className="px-4 py-2 text-center font-medium">Enabled</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2 font-medium">{profile.name}</td>
                    <td className="px-4 py-2">
                      {providerLabel(profile.provider)}
                      {executors[profile.provider] === false && (
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">(CLI unavailable)</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {profile.model || <span className="text-muted-foreground">provider default</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">{profile.mcpServerIds.length || '—'}</td>
                    <td className="px-4 py-2 text-xs">{profile.skillIds.length || '—'}</td>
                    <td className="px-4 py-2 text-center">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${
                        profile.enabled
                          ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {profile.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => openEdit(profile)} className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent">
                        Edit
                      </button>
                      <button onClick={() => setDeletingProfile(profile)} className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-accent">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AnimatePresence>
        {openForm && (
          <Modal title={editingId ? 'Edit Agent Profile' : 'New Agent Profile'} onClose={() => setOpenForm(false)}>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="profile-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">Name</label>
                <input
                  id="profile-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="e.g. Backend Developer"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label htmlFor="profile-provider" className="mb-1.5 block text-xs font-medium text-muted-foreground">Provider</label>
                <select
                  id="profile-provider"
                  value={form.provider}
                  onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value as AgentType }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}{executors[p.value] === false ? ' (CLI unavailable)' : ''}
                    </option>
                  ))}
                </select>
                {executors[form.provider] === false && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    This provider's CLI was not detected on the server. The profile can be saved but cannot
                    execute until the CLI is installed.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="profile-model" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Model (optional)
                </label>
                <input
                  id="profile-model"
                  list="profile-model-options"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder={defaultModels[form.provider] || 'leave empty to use provider default'}
                  aria-describedby="profile-model-help"
                />
                <datalist id="profile-model-options">
                  {(suggestedModels[form.provider] ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p id="profile-model-help" className="mt-1 text-xs text-muted-foreground">
                  {defaultModels[form.provider]
                    ? `Provider default: ${defaultModels[form.provider]}. Custom IDs are passed to the provider as-is — availability depends on the provider and account.`
                    : 'Leave empty to use the provider’s own default. Custom IDs are passed as-is; availability depends on the provider and account.'}
                </p>
              </div>

              <div>
                <label htmlFor="profile-instructions" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Instructions / persona (optional)
                </label>
                <textarea
                  id="profile-instructions"
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="System instructions for this agent…"
                />
              </div>

              <fieldset className="rounded-lg border border-border p-3">
                <legend className="px-1 text-xs font-medium text-muted-foreground">MCP servers</legend>
                {mcpServers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No MCP servers configured. Add servers on the MCP Servers page.</p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {mcpServers.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={form.mcpServerIds.includes(s.id)}
                          onChange={() => setForm((f) => ({ ...f, mcpServerIds: toggleInList(f.mcpServerIds, s.id) }))}
                        />
                        <span>{s.name}</span>
                        <span className="text-xs text-muted-foreground">({s.transport})</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

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
                          onChange={() => setForm((f) => ({ ...f, skillIds: toggleInList(f.skillIds, sk.name) }))}
                        />
                        <span>{sk.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                <span>Enabled</span>
              </label>

              <p className="text-xs text-muted-foreground">
                These are profile <span className="font-medium">defaults</span>. When you assign this profile to a
                task, its provider, model, instructions, MCP servers and skills are captured as a snapshot for that
                task and applied at execution time. Editing this profile later does not change tasks that already
                captured it — create or reassign to pick up new settings.
              </p>

              {formError && (
                <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {formError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button" onClick={() => setOpenForm(false)}
                  className="rounded-md border border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit" disabled={saving}
                  className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingId ? 'Save changes' : 'Create profile'}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deletingProfile && (
          <Modal title="Delete profile" onClose={() => setDeletingProfile(null)} width="max-w-sm">
            <p className="text-sm">
              Delete profile <span className="font-medium">{deletingProfile.name}</span>? This cannot be undone.
              Tasks already assigned to it keep their existing snapshot.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setDeletingProfile(null)}
                className="rounded-md border border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={saving}
                className="rounded-md bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
              >
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

export default AgentsPage;
