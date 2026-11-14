import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plus, Play, Sliders,
  Terminal, X,
} from 'lucide-react';
import type { AgentSession } from '@/types';
import { api } from '@/lib/api';

type SessionStatusColor = {
  connected: string;
  connecting: string;
  disconnected: string;
  error: string;
};

const STATUS_COLORS: SessionStatusColor = {
  connected: 'bg-green-500/20 text-green-600 border-green-500/30',
  connecting: 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30',
  disconnected: 'bg-muted text-muted-foreground',
  error: 'bg-red-500/20 text-red-600 border-red-500/30',
};

export function SessionManager() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionEvents, setSessionEvents] = useState<any[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getSessions();
      setSessions(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
  }, []);

  const loadSessionEvents = useCallback(async (sessionId: string) => {
    setEventsLoading(true);
    try {
      const session = await api.getSession(sessionId);
      if (!session?.taskId) {
        setSessionEvents([]);
        return;
      }
      const events = await api.getSessionEvents(session.taskId);
      setSessionEvents(events);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load session events');
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleCreate = useCallback(async (data: {
    agentType: string;
    taskId?: string;
    model?: string;
    useWorktree?: boolean;
    repoPath?: string;
    branchName?: string;
    baseBranch?: string;
  }) => {
    setError(null);
    try {
      const created = await api.createSession(data as any);
      setSessions((prev) => [...prev, created]);
      setOpenForm(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    }
  }, []);

  const handleStart = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.startSession(id);
      await loadSessions();
      if (selectedSessionId === id) {
        await loadSessionEvents(id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    }
  }, [loadSessions, selectedSessionId, loadSessionEvents]);

  const handleStop = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.stopSession(id);
      await loadSessions();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    }
  }, [loadSessions]);

  const statusColor = (status: string) => {
    return STATUS_COLORS[status as keyof SessionStatusColor] || STATUS_COLORS.disconnected;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Agent Sessions</h2>
          <p className="text-muted-foreground text-sm">
            Manage and monitor agent execution sessions across all providers.
          </p>
        </div>
        <button
          onClick={() => setOpenForm(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New Session
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Sessions list */}
      <div className="rounded-lg border p-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2">Session</th>
              <th className="pb-2">Agent</th>
              <th className="pb-2">Task</th>
              <th className="pb-2">Status</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2 font-mono text-xs">{s.id.replace('session-', '')}</td>
                <td className="py-2">{s.agentType}</td>
                <td className="py-2">{s.taskId || '—'}</td>
                <td className="py-2">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor(s.status)}`}>
                    {s.status}
                  </span>
                </td>
                <td className="py-2 text-right">
                  {s.status === 'executing' || s.status === 'planning' ? (
                    <button
                      onClick={() => handleStop(s.id)}
                      className="px-3 py-1 text-xs font-medium rounded-md border bg-red-500/10 text-red-600 hover:bg-red-500/20"
                    >
                      <Terminal className="h-3 w-3 mr-1" /> Stop
                    </button>
                  ) : (
                    <button
                      onClick={() => handleStart(s.id)}
                      className="px-3 py-1 text-xs font-medium rounded-md border bg-green-500/10 text-green-600 hover:bg-green-500/20"
                    >
                      <Play className="h-3 w-3 mr-1" /> Start
                    </button>
                  )}
                  <button
                    onClick={() => { setSelectedSessionId(s.id); loadSessionEvents(s.id); }}
                    className="ml-2 px-3 py-1 text-xs font-medium rounded-md border text-muted-foreground hover:bg-muted"
                  >
                    <Sliders className="h-3 w-3 mr-1" /> Details
                  </button>
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  No sessions yet. Create one to start running agents.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Session details */}
      {selectedSessionId && (
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Session Events</h3>
            <button
              onClick={() => setSelectedSessionId(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {eventsLoading ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">Loading events…</div>
          ) : sessionEvents.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              No events yet. Start the session to see agent activity.
            </div>
          ) : (
            <div className="h-64 overflow-y-auto border rounded p-3 bg-mono/10 font-mono text-xs space-y-1">
              {sessionEvents.map((e, i) => (
                <div key={e.id || i} className="flex gap-2">
                  <span className="text-muted-foreground">{new Date(e.timestamp).toLocaleTimeString()}</span>
                  <span className="text-sm">{e.type}</span>
                  <span className="text-xs">{e.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create session form */}
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
                <h3 className="font-semibold">New Session</h3>
                <button onClick={() => setOpenForm(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.target as HTMLFormElement);
                  const data = {
                    agentType: String(formData.get("agentType") || ""),
                    taskId: String(formData.get("taskId") || ""),
                    model: String(formData.get("model") || ""),
                    useWorktree: (formData.get("useWorktree") as string) === "true",
                    repoPath: String(formData.get("repoPath") || ""),
                    branchName: String(formData.get("branchName") || ""),
                    baseBranch: String(formData.get("baseBranch") || ""),
                  };
                  handleCreate(data as any);
















































                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-sm font-medium mb-1">Agent Type</label>
                  <select
                    name="agentType"
                    defaultValue="opencode"
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    <option value="copilot">Copilot</option>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="opencode">OpenCode</option>
                    <option value="hermes">Hermes</option>
                    <option value="openclaw">OpenClaw</option>
                    <option value="grok">Grok</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Task ID (optional)</label>
                  <input
                    name="taskId"
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="Leave blank for unassigned session"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Model (optional)</label>
                  <input
                    name="model"
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="e.g. claude-opus-4"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Repo Path (optional)</label>
                  <input
                    name="repoPath"
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="/path/to/repo"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Branch Name (optional)</label>
                  <input
                    name="branchName"
                    className="w-full border rounded px-2 py-1 text-sm"
                    placeholder="agent/task-name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Base Branch (optional)</label>
                  <input
                    name="baseBranch"
                    defaultValue="main"
                    className="w-full border rounded px-2 py-1 text-sm"
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
                    Create Session
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
