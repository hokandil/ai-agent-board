import { useCallback, useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { AgentProfile, AgentType } from '@/types';
import { api } from '@/lib/api';

const PROVIDER_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'grok', label: 'Grok' },
];

export function AgentsPage() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadProfiles = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getAgentProfiles();
      setProfiles(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load agent profiles');
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const form = e.target as HTMLFormElement;
      const data = {
        name: (form.elements.namedItem('name') as HTMLInputElement).value,
        provider: (form.elements.namedItem('provider') as HTMLSelectElement).value as AgentType,
        model: (form.elements.namedItem('model') as HTMLInputElement).value || undefined,
        instructions: (form.elements.namedItem('instructions') as HTMLTextAreaElement).value || undefined,
        mcpServerIds: [],
        skillIds: [],
        enabled: true,
      };
      if (editingProfile) {
        await api.updateAgentProfile(editingProfile.id, {
          name: data.name,
          provider: data.provider,
          model: data.model,
          instructions: data.instructions,
          mcpServerIds: data.mcpServerIds,
          skillIds: data.skillIds,
          enabled: data.enabled,
        });
      } else {
        await api.createAgentProfile(data);
      }
      setOpenForm(false);
      setEditingProfile(null);
      await loadProfiles();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    setLoading(true);
    try {
      await api.deleteAgentProfile(id);
      setDeletingProfile(null);
      await loadProfiles();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    } finally {
      setLoading(false);
    }
  };

  const providerLabel = (provider: AgentType) => {
    const found = PROVIDER_OPTIONS.find((p) => p.value === provider);
    return found ? found.label : provider;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agent Profiles</h1>
          <p className="text-muted-foreground">
            Reusable agent configurations: provider, model, instructions, MCP servers and skills.
          </p>
        </div>
        <button
          onClick={() => { setEditingProfile(null); setOpenForm(true); }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New Profile
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 border border-red-200">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left font-medium">Name</th>
              <th className="text-left font-medium">Provider</th>
              <th className="text-left font-medium">Model</th>
              <th className="text-left font-medium">MCP servers</th>
              <th className="text-left font-medium">Skills</th>
              <th className="text-center font-medium">Enabled</th>
              <th className="text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.id}>
                <td className="font-medium">{profile.name}</td>
                <td>{providerLabel(profile.provider)}</td>
                <td>{profile.model ?? '—'}</td>
                <td className="text-xs">{profile.mcpServerIds.length === 0 ? '—' : profile.mcpServerIds.join(', ')}</td>
                <td className="text-xs">{profile.skillIds.length === 0 ? '—' : profile.skillIds.join(', ')}</td>
                <td className="text-center">
                  <span className={`px-2 py-1 rounded-full text-xs ${profile.enabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {profile.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="text-right space-x-1">
                  {editingProfile?.id === profile.id ? (
                    <>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditingProfile(null); }}
                        className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSubmit(e as unknown as React.FormEvent); }}
                        className="px-2 py-1 text-xs font-medium rounded-md border bg-green-500 text-white hover:bg-green-500/90 disabled:opacity-60"
                        disabled={loading}
                      >
                        {loading ? 'Saving…' : 'Save changes'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => { setEditingProfile(profile); setOpenForm(true); }}
                        className="px-2 py-1 text-xs text-green-600 hover:bg-green-100"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingProfile(profile.id)}
                        className="px-2 py-1 text-xs text-red-600 hover:bg-red-100"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create / Edit dialog */}
      {openForm && (
        <div className="fixed inset-0 z-50">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpenForm(false)} />
          <div className="fixed top-1/2 left-1/2 z-50 w-[560px] -translate-x-1/2 -translate-y-1/2 bg-white border rounded-lg p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editingProfile ? 'Edit profile' : 'New agent profile'}</h3>
              <button
                type="button"
                onClick={() => setOpenForm(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="profile-name" className="block text-sm font-medium">Name</label>
                <input
                  id="profile-name"
                  name="name"
                  defaultValue={editingProfile?.name ?? ''}
                  className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-sm"
                  required
                />
              </div>
              <div>
                <label htmlFor="profile-provider" className="block text-sm font-medium">Provider</label>
                <select
                  id="profile-provider"
                  name="provider"
                  defaultValue={editingProfile?.provider ?? 'copilot'}
                  className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-sm"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="profile-model" className="block text-sm font-medium">Model (optional)</label>
                <input
                  id="profile-model"
                  name="model"
                  defaultValue={editingProfile?.model ?? ''}
                  placeholder="e.g. claude-3-5-sonnet-20241022"
                  className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-sm"
                />
              </div>
              <div>
                <label htmlFor="profile-instructions" className="block text-sm font-medium">Instructions / persona (optional)</label>
                <textarea
                  id="profile-instructions"
                  name="instructions"
                  defaultValue={editingProfile?.instructions ?? ''}
                  rows={4}
                  className="mt-1 block w-full rounded-md border border-gray-300 py-2 pl-3 pr-10 text-sm"
                />
              </div>
              <div className="text-xs text-gray-500">
                MCP servers and skills are assigned per-project when a task is created; the profile stores
                defaults that are applied as task configuration.
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setOpenForm(false)}
                  className="px-3 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button type="submit" className="px-3 py-1 text-xs font-medium rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-60" disabled={loading}>
                  {loading ? 'Saving…' : editingProfile ? 'Save changes' : 'Create profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deletingProfile && (
        <div className="fixed inset-0 z-50">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setDeletingProfile(null)} />
          <div className="fixed top-1/2 left-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 bg-white border rounded-lg p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Delete profile</h3>
              <button onClick={() => setDeletingProfile(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4">
              Delete profile <span className="font-medium">{editingProfile?.name ?? deletingProfile}</span>? This cannot be undone.
            </div>
            <div className="mt-6 flex justify-end space-x-2">
              <button
                onClick={() => setDeletingProfile(null)}
                className="px-3 py-1 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deletingProfile!)}
                className="px-3 py-1 text-xs font-medium rounded-md border border-red-300 text-red-700 hover:bg-red-50 hover:text-white"
                disabled={loading}
              >
                {loading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentsPage;
