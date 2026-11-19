import type {
  Task,
  TaskGroup,
  TaskAttachment,
  AgentEvent,
  AgentInfo,
  AgentType,
  ColumnId,
  Priority,
  WSMessage,
  Project,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectPathValidation,
  ProjectRepoStatusResponse,
  ProjectConfig,
  MCPServer,
  MCPTool,
  MCPTransportType,
  MCPToolCallResult,
  MCPPermission,
  SyncConnection,
  SyncDirection,
  ConflictPolicy,
  SyncFieldMapping,
  SyncConflict,
  SyncState,
  SyncResult,
  McpImportPreviewResult,
  McpImportSelection,
  McpImportResult,
  AgentSession,
  AgentProfile,
  SkillInfo,
  AgentModelInfo,
  ManagedAgent,
  AgentConfigInput,
} from '@/types';

export interface TaskGroupWithChildren extends TaskGroup {
  children: Task[];
}

export interface CreateGroupChild {
  title: string;
  description?: string;
  agentType?: AgentType;
  useWorktree?: boolean;
}

function withQuery(path: string, params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const BASE = '/api';
const API_KEY = import.meta.env.VITE_API_KEY as string | undefined;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }
  return headers;
}

/**
 * Raised when the backend could not be reached at all (the dev proxy could not
 * connect to the API server, or the API server answered with a gateway
 * error). Distinct from an application-level error response so the UI can
 * show a "backend unavailable" state instead of a raw HTTP code.
 */
export class BackendUnavailableError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BackendUnavailableError';
    this.status = status;
  }
}

const BACKEND_DOWN_MESSAGE =
  'Backend unavailable — the board API could not be reached. Reconnecting automatically; your input is preserved.';

/** Short label for the offline state, used in toasts. */
export const BACKEND_DOWN_TOAST_MESSAGE =
  'Backend unavailable — reconnecting automatically. Your input has been kept.';

/** Turn an unknown thrown value into a user-facing message. */
export function describeError(err: unknown, prefix?: string): string {
  if (err instanceof BackendUnavailableError) {
    return prefix ? `${prefix}: ${BACKEND_DOWN_TOAST_MESSAGE}` : BACKEND_DOWN_TOAST_MESSAGE;
  }
  const message = err instanceof Error ? err.message : String(err);
  return prefix ? `${prefix}: ${message}` : message;
}

/** HTTP statuses that mean "the API server did not answer" rather than an app error. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${url}`, {
      headers: authHeaders(),
      ...opts,
    });
  } catch (err: unknown) {
    // Network-level failure: the proxy/server is not reachable.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[API] request failed:', detail, 'for', url);
    // A request can also fail because it was aborted (e.g. by a navigation).
    // Only a corroborating health probe proves the backend is really down.
    void probeBackend().then((healthy) => {
      if (!healthy) markBackendUnavailable();
    });
    throw new BackendUnavailableError(BACKEND_DOWN_MESSAGE);
  }
  if (GATEWAY_STATUSES.has(res.status)) {
    // The proxy explicitly reported that the upstream did not answer.
    markBackendUnavailable();
    console.warn(`[API] backend gateway error ${res.status} for ${url}`);
    throw new BackendUnavailableError(BACKEND_DOWN_MESSAGE, res.status);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  markBackendAvailable();
  if (res.status === 204) return undefined as T;
  return res.json();
}

// --- Task CRUD ---

export const api = {
  // --- Projects ---
  getProjects: () =>
    request<Project[]>('/projects'),

  getProject: (id: string) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`),

  getDefaultProject: () =>
    request<Project>('/projects/default'),

  createProject: (data: CreateProjectRequest) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),

  updateProject: (id: string, data: UpdateProjectRequest) =>
    request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  validateProjectPath: (repoPath: string) =>
    request<ProjectPathValidation>('/projects/validate-path', { method: 'POST', body: JSON.stringify({ repoPath }) }),

  selectProjectDirectory: (initialPath?: string) =>
    request<{ repoPath: string | null }>('/projects/select-directory', { method: 'POST', body: JSON.stringify({ initialPath }) }),

  getProjectConfig: () =>
    request<ProjectConfig>('/projects/config'),

  getProjectRepoStatus: () =>
    request<ProjectRepoStatusResponse>('/projects/repo-status'),

  updateProjectConfig: (cloneRoot: string) =>
    request<ProjectConfig>('/projects/config', { method: 'PATCH', body: JSON.stringify({ cloneRoot }) }),

  // --- Task CRUD ---
  getTasks: (includeArchived = false, projectId?: string) =>
    request<Task[]>(withQuery('/tasks', { includeArchived, projectId })),

  createTask: (data: { title: string; description?: string; priority?: Priority; columnId?: ColumnId; agentType?: AgentType; repoPath?: string; branchName?: string; baseBranch?: string; useWorktree?: boolean; autoRun?: boolean; projectId?: string; timeoutMinutes?: number | null }) =>
    request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),

  updateTask: (id: string, data: Partial<Task>) =>
    request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteTask: (id: string) =>
    request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  runTask: (id: string) =>
    request<Task>(`/tasks/${id}/run`, { method: 'POST' }),

  stopTask: (id: string) =>
    request<Task>(`/tasks/${id}/stop`, { method: 'POST' }),

  getEvents: (id: string) =>
    request<AgentEvent[]>(`/tasks/${id}/events`),

  getAgents: () => request<AgentInfo[]>('/agents'),

  configureTask: (id: string, config: { repoPath: string; branchName: string; baseBranch: string; useWorktree: boolean; agentType?: AgentType }) =>
    request<Task>(`/tasks/${id}/configure`, { method: 'POST', body: JSON.stringify(config) }),

  createPR: (id: string) =>
    request<{ url: string }>(`/tasks/${id}/create-pr`, { method: 'POST' }),

  cleanupWorktree: (id: string) =>
    request<{ success: boolean; status: 'removed' | 'missing' }>(`/tasks/${id}/cleanup-worktree`, { method: 'POST' }),

  mergeLocal: (id: string) =>
    request<{ merged: boolean; baseBranch: string }>(`/tasks/${id}/merge-local`, { method: 'POST' }),

  getGitInfo: (id: string) =>
    request<{ hasRemote: boolean }>(`/tasks/${id}/git-info`),

  sendMessage: (id: string, message: string, attachmentIds?: string[]) =>
    request<{ success: boolean }>(`/tasks/${id}/message`, { method: 'POST', body: JSON.stringify({ message, attachmentIds }) }),

  respondToPermission: (id: string, requestId: string, approved: boolean) =>
    request<{ success: boolean; requestId: string; approved: boolean }>(`/tasks/${id}/permission-response`, { method: 'POST', body: JSON.stringify({ requestId, approved }) }),

  getPendingPermissions: (id: string) =>
    request<Array<{ requestId: string; kind: string; tool?: string; createdAt: number }>>(`/tasks/${id}/permissions`),

  // --- Attachments ---
  uploadAttachments: async (taskId: string, files: File[]): Promise<TaskAttachment[]> => {
    const form = new FormData();
    for (const f of files) form.append('images', f);
    const headers: Record<string, string> = {};
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
    const res = await fetch(`${BASE}/tasks/${taskId}/attachments`, { method: 'POST', headers, body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (HTTP ${res.status})`);
    }
    return res.json();
  },

  getAttachments: (taskId: string) =>
    request<TaskAttachment[]>(`/tasks/${taskId}/attachments`),

  deleteAttachment: (id: string) =>
    request<void>(`/attachments/${id}`, { method: 'DELETE' }),

  getAttachmentUrl: (id: string) => `${BASE}/attachments/${id}/file`,

  archiveTask: (id: string) =>
    request<Task>(`/tasks/${id}/archive`, { method: 'PATCH' }),

  unarchiveTask: (id: string) =>
    request<Task>(`/tasks/${id}/unarchive`, { method: 'PATCH' }),

  // --- Groups ---
  getGroups: (includeArchived = false, projectId?: string) =>
    request<TaskGroupWithChildren[]>(withQuery('/groups', { archived: includeArchived, projectId })),

  getGroup: (id: string) =>
    request<TaskGroupWithChildren>(`/groups/${id}`),

  createGroup: (data: {
    title: string;
    description?: string;
    priority?: Priority;
    repoPath?: string;
    baseBranch?: string;
    maxConcurrency: number;
    children: CreateGroupChild[];
    autoRun?: boolean;
    projectId?: string;
  }) => request<TaskGroupWithChildren>('/groups', { method: 'POST', body: JSON.stringify(data) }),

  updateGroup: (id: string, data: Partial<TaskGroup>) =>
    request<TaskGroupWithChildren>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteGroup: (id: string) =>
    request<void>(`/groups/${id}`, { method: 'DELETE' }),

  runGroup: (id: string) =>
    request<TaskGroupWithChildren>(`/groups/${id}/run`, { method: 'POST' }),

  stopGroup: (id: string) =>
    request<{ stopped: boolean }>(`/groups/${id}/stop`, { method: 'POST' }),

  // --- MCP ---
  getMcpServers: () =>
    request<MCPServer[]>('/mcp/servers'),

  getMcpServer: (id: string) =>
    request<MCPServer>(`/mcp/servers/${encodeURIComponent(id)}`),

  createMcpServer: (data: {
    name: string;
    transport: MCPTransportType;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    cwd?: string;
    headers?: Record<string, string>;
  }) =>
    request<MCPServer>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),

  connectMcpServer: (id: string) =>
    request<MCPServer>(`/mcp/servers/${encodeURIComponent(id)}/connect`, { method: 'POST' }),

  disconnectMcpServer: (id: string) =>
    request<MCPServer>(`/mcp/servers/${encodeURIComponent(id)}/disconnect`, { method: 'POST' }),

  startMcpOAuth: (id: string) =>
    request<{ status: 'none' | 'pending' | 'authorized' | 'error'; authorizationUrl?: string; error?: string }>(
      `/mcp/servers/${encodeURIComponent(id)}/oauth/start`, { method: 'POST' }),

  getMcpOAuthStatus: (id: string) =>
    request<{ status: 'none' | 'pending' | 'authorized' | 'error'; error?: string; hasTokens: boolean }>(
      `/mcp/servers/${encodeURIComponent(id)}/oauth/status`),

  revokeMcpOAuth: (id: string) =>
    request<{ revoked: boolean }>(`/mcp/servers/${encodeURIComponent(id)}/oauth/revoke`, { method: 'POST' }),

  deleteMcpServer: (id: string) =>
    request<void>(`/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Agent profiles ---
  getAgentProfiles: () =>
    request<AgentProfile[]>('/agent-profiles'),
  getAgentProfile: (id: string) =>
    request<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`),
  createAgentProfile: (data: {
    name: string;
    provider: AgentType;
    model?: string;
    instructions?: string;
    mcpServerIds: string[];
    skillIds: string[];
    enabled: boolean;
  }) =>
    request<AgentProfile>('/agent-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateAgentProfile: (id: string, data: {
    name?: string;
    provider?: AgentType;
    model?: string;
    instructions?: string;
    mcpServerIds?: string[];
    skillIds?: string[];
    enabled?: boolean;
  }) =>
    request<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgentProfile: (id: string) =>
    request<void>(`/agent-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Skills & model configuration ---
  getSkills: () =>
    request<SkillInfo[]>('/skills'),
  getAgentModels: () =>
    request<AgentModelInfo>('/agent-models'),

  // --- Agents management (per-executor configuration) ---
  getManagedAgents: () =>
    request<ManagedAgent[]>('/agents/manage'),
  rescanAgents: () =>
    request<ManagedAgent[]>('/agents/manage/rescan', { method: 'POST' }),
  saveAgentConfig: (provider: AgentType, data: AgentConfigInput) =>
    request<ManagedAgent>(`/agents/${encodeURIComponent(provider)}/config`, { method: 'PUT', body: JSON.stringify(data) }),

  updateMcpServer: (id: string, data: {
    name?: string;
    transport?: MCPTransportType;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    cwd?: string;
    headers?: Record<string, string>;
  }) =>
    request<MCPServer>(`/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getMcpTools: (serverId: string) =>
    request<{ tools: MCPTool[] }>(`/mcp/servers/${encodeURIComponent(serverId)}/tools`),

  testMcpTool: (serverId: string, toolName: string, toolArgs?: unknown) =>
    request<MCPToolCallResult>(`/mcp/servers/${encodeURIComponent(serverId)}/test-tool`, {
      method: 'POST',
      body: JSON.stringify({ toolName, arguments: toolArgs ?? {} }),
    }),

  getMcpPermissions: () =>
    request<Array<{ serverId: string; serverName: string; agentType: string; toolName: string; allowed: boolean }>>('/mcp/permissions'),

  getMcpPermissionsByServer: (serverId: string) =>
    request<MCPPermission[]>(`/mcp/permissions/${encodeURIComponent(serverId)}`),

  setMcpPermission: (data: {
    serverId: string;
    agentType: string;
    toolName: string;
    allowed: boolean;
  }) =>
    request<MCPPermission>('/mcp/permissions', { method: 'POST', body: JSON.stringify(data) }),

  deleteMcpPermission: (data: {
    serverId: string;
    agentType: string;
    toolName: string;
  }) =>
    request<void>('/mcp/permissions', {
      method: 'DELETE',
      body: JSON.stringify(data),
    }),

  // --- MCP Sync ---
  getSyncConnections: () =>
    request<SyncConnection[]>('/mcp/sync/connections'),

  getSyncConnection: (id: string) =>
    request<SyncConnection>(`/mcp/sync/connections/${encodeURIComponent(id)}`),

  createSyncConnection: (data: {
    serverId: string;
    taskId: string;
    externalSource: string;
    externalKey: string;
    externalTaskTool: string;
    syncDirection?: SyncDirection;
    conflictPolicy?: ConflictPolicy;
  }) =>
    request<SyncConnection>('/mcp/sync/connections', { method: 'POST', body: JSON.stringify(data) }),

  updateSyncConnection: (id: string, data: {
    serverId?: string;
    taskId?: string;
    externalSource?: string;
    externalKey?: string;
    externalTaskTool?: string;
    syncDirection?: SyncDirection;
    conflictPolicy?: ConflictPolicy;
  }) =>
    request<SyncConnection>(`/mcp/sync/connections/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  syncConnection: (id: string) =>
    request<SyncResult>(`/mcp/sync/connections/${encodeURIComponent(id)}/sync`, { method: 'POST' }),

  importSyncTask: (id: string) =>
    request<{ taskId: string; created: boolean }>(`/mcp/sync/connections/${encodeURIComponent(id)}/import`, { method: 'POST' }),

  exportSyncTask: (id: string) =>
    request<{ updated: boolean }>(`/mcp/sync/connections/${encodeURIComponent(id)}/export`, { method: 'POST' }),

  deleteSyncConnection: (id: string) =>
    request<void>(`/mcp/sync/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getSyncFieldMappings: (connectionId: string) =>
    request<SyncFieldMapping[]>(`/mcp/sync/connections/${encodeURIComponent(connectionId)}/mappings`),

  createSyncFieldMapping: (connectionId: string, data: {
    externalField: string;
    boardField: string;
    transform?: SyncFieldMapping['transform'];
    defaultValue?: string;
  }) =>
    request<SyncFieldMapping>(`/mcp/sync/connections/${encodeURIComponent(connectionId)}/mappings`, { method: 'POST', body: JSON.stringify(data) }),

  deleteSyncFieldMapping: (id: string) =>
    request<void>(`/mcp/sync/mappings/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getSyncConflicts: (connectionId: string) =>
    request<SyncConflict[]>(`/mcp/sync/connections/${encodeURIComponent(connectionId)}/conflicts`),

  resolveSyncConflict: (id: string, resolvedValue: string, resolvedBy: string) =>
    request<SyncConflict>(`/mcp/sync/conflicts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ resolvedValue, resolvedBy }) }),

  ignoreSyncConflict: (id: string) =>
    request<void>(`/mcp/sync/conflicts/${encodeURIComponent(id)}/ignore`, { method: 'POST' }),

  getSyncState: (connectionId: string) =>
    request<SyncState>(`/mcp/sync/connections/${encodeURIComponent(connectionId)}/state`),

  previewMcpImport: (data: {
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    externalSource?: string;
  }) =>
    request<McpImportPreviewResult>('/mcp/sync/import/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  importMcpTasks: (data: {
    serverId: string;
    projectId: string;
    toolName: string;
    externalSource?: string;
    tasks: McpImportSelection[];
  }) =>
    request<McpImportResult>('/mcp/sync/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // --- Session Management ---
  createSession: (data: {
    agentType: AgentType;
    taskId?: string;
    model?: string;
    useWorktree?: boolean;
    repoPath?: string;
    branchName?: string;
    baseBranch?: string;
  }) =>
    request<AgentSession>('/sessions', { method: 'POST', body: JSON.stringify(data) }),

  startSession: (id: string) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(id)}/start`, { method: 'POST' }),

  stopSession: (id: string) =>
    request<{ stopped: boolean }>(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

  resumeSession: (id: string) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' }),

  getSessions: () =>
    request<AgentSession[]>('/sessions'),

  getSession: (id: string) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(id)}`),

  getSessionEvents: (sessionId: string) =>
    request<AgentEvent[]>(`/sessions/${encodeURIComponent(sessionId)}/events`),

  assignSessionToTask: (taskId: string, sessionId: string) =>
    request<Task>(`/tasks/${encodeURIComponent(taskId)}/assign-session`, {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),

  // --- PTY Session Management ---
  createPtySession: (data: {
    cwd?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    name?: string;
  }) =>
    request<import('@/types').PtySession>('/pty/sessions', { method: 'POST', body: JSON.stringify(data) }),

  getPtySessions: () =>
    request<import('@/types').PtySession[]>('/pty/sessions'),

  getPtySession: (id: string) =>
    request<import('@/types').PtySession>(`/pty/sessions/${encodeURIComponent(id)}`),

  sendPtyInput: (id: string, data: string) =>
    request<{ sent: boolean }>(`/pty/sessions/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify({ data }) }),

  resizePtySession: (id: string, cols: number, rows: number) =>
    request<{ resized: boolean }>(`/pty/sessions/${encodeURIComponent(id)}/resize`, { method: 'POST', body: JSON.stringify({ cols, rows }) }),

  killPtySession: (id: string, signal?: string) =>
    request<{ killed: boolean }>(`/pty/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST', body: JSON.stringify({ signal }) }),

  deletePtySession: (id: string) =>
    request<void>(`/pty/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- GitHub Sync ---
  getGitHubIssues: (repoPath: string, limit?: number) =>
    request<{ issues: any[] }>(`/github/tasks/${encodeURIComponent(repoPath)}/issues?limit=${limit ?? 10}`, { method: 'GET' }),

  getGitHubPullRequests: (repoPath: string, limit?: number) =>
    request<{ pullRequests: any[] }>(`/github/tasks/${encodeURIComponent(repoPath)}/pulls?limit=${limit ?? 10}`, { method: 'GET' }),

  getGitHubCIRuns: (repoPath: string, limit?: number) =>
    request<{ ciRuns: any[] }>(`/github/tasks/${encodeURIComponent(repoPath)}/ci?limit=${limit ?? 10}`, { method: 'GET' }),

  getGitHubIssue: (repoPath: string, issueNumber: number) =>
    request<any>(`/github/tasks/${encodeURIComponent(repoPath)}/issues/${issueNumber}`, { method: 'GET' }),

  getGitHubPullRequest: (repoPath: string, prNumber: number) =>
    request<any>(`/github/tasks/${encodeURIComponent(repoPath)}/pulls/${prNumber}`, { method: 'GET' }),

};



// --- WebSocket (shared singleton) ---

export type WSMessageHandler = (msg: WSMessage) => void;
type ReconnectHandler = () => void;

const listeners = new Set<WSMessageHandler>();
const reconnectListeners = new Set<ReconnectHandler>();
let ws: WebSocket | null = null;
let disposed = false;
let reconnectTimer: ReturnType<typeof setTimeout>;
/** Number of consecutive failed reconnect attempts (drives the backoff). */
let reconnectAttempt = 0;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

// Connection status tracking
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';
let connectionStatus: ConnectionStatus = 'connecting';
let hasConnectedOnce = false;
const statusListeners = new Set<(status: ConnectionStatus) => void>();

/**
 * Two independent liveness signals:
 * - `socketHealthy`: the board's WebSocket is open (live updates work).
 * - `httpHealthy`: the last REST call succeeded; `false` means a request and
 *   a corroborating health probe both failed, so the backend is unreachable.
 *
 * `null` means "not known yet".
 */
let socketHealthy = false;
let httpHealthy: boolean | null = null;
/** Last socket state published to listeners (so socket-only changes notify). */
let publishedSocketHealthy = false;

function computeConnectionStatus(): ConnectionStatus {
  // A proven REST failure is a proven outage.
  if (httpHealthy === false) return 'disconnected';
  // A proven REST success is a proven reachable backend.
  if (httpHealthy === true) return 'connected';
  // Nothing known yet: trust the socket.
  return socketHealthy ? 'connected' : 'connecting';
}

function setConnectionStatus(status: ConnectionStatus) {
  if (status === 'connected') hasConnectedOnce = true;
  if (status === connectionStatus) return;
  connectionStatus = status;
  statusListeners.forEach((fn) => fn(status));
}

/**
 * Recompute and publish the connection state from the two liveness signals.
 * Listeners are notified when either signal changes so the UI can reflect a
 * socket-only transition (e.g. live updates reconnecting while REST works).
 */
function refreshConnectionStatus() {
  const next = computeConnectionStatus();
  const socketChanged = publishedSocketHealthy !== socketHealthy;
  publishedSocketHealthy = socketHealthy;
  if (next === connectionStatus && !socketChanged) return;
  if (next !== connectionStatus) {
    if (next === 'connected') hasConnectedOnce = true;
    connectionStatus = next;
  }
  statusListeners.forEach((fn) => fn(connectionStatus));
}

/** The backend answered a REST call: it is reachable. */
function markBackendAvailable() {
  httpHealthy = true;
  refreshConnectionStatus();
}

/**
 * The backend did not answer a REST call *and* a corroborating health probe
 * also failed, so the backend is genuinely unreachable.
 */
function markBackendUnavailable() {
  httpHealthy = false;
  refreshConnectionStatus();
}

// Health-probe throttling: one probe per failure burst, at most every 2s.
const PROBE_MIN_INTERVAL_MS = 2000;
let lastProbeAt = 0;
let probeInFlight: Promise<boolean> | null = null;

/**
 * Ask the backend's health endpoint whether it is alive.
 * Returns true when it answered, false when it did not.
 */
function probeBackend(): Promise<boolean> {
  if (probeInFlight) return probeInFlight;
  if (Date.now() - lastProbeAt < PROBE_MIN_INTERVAL_MS) {
    // Throttled: treat as "still unknown" and keep the current state.
    return Promise.resolve(true);
  }
  probeInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/health`, { method: 'GET', cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    } finally {
      lastProbeAt = Date.now();
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

// Client-side heartbeat. The socket heartbeat alone can take up to a minute to
// notice a dead backend, so the client also polls the health endpoint.
const HEALTH_INTERVAL_MS = 10_000;
let healthTimer: ReturnType<typeof setInterval> | null = null;

async function checkBackendHealth(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { method: 'GET', cache: 'no-store' });
    // The backend answered, so it is reachable whatever the status code was.
    markBackendAvailable();
  } catch {
    // The heartbeat itself failed — a proven outage.
    markBackendUnavailable();
  }
}

function startHealthHeartbeat(): void {
  if (healthTimer !== null) return;
  healthTimer = setInterval(() => {
    // Do not poll background tabs.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void checkBackendHealth();
  }, HEALTH_INTERVAL_MS);
}

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}

/** True while the board's live-update WebSocket is open. */
export function isSocketConnected(): boolean {
  return socketHealthy;
}

/** Returns true only after a successful connection has been made at least once */
export function hasEverConnected(): boolean {
  return hasConnectedOnce;
}

export function subscribeConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/ws`;
  if (API_KEY) {
    url += `?token=${encodeURIComponent(API_KEY)}`;
  }
  disposed = false;
  socketHealthy = false;
  startHealthHeartbeat();
  // While the socket is (re)connecting the board has no live channel to the
  // backend, but REST may still work. Keep the last known state until one of
  // the signals resolves.
  if (connectionStatus === 'connecting') setConnectionStatus('connecting');

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WS] connected');
    reconnectAttempt = 0;
    socketHealthy = true;
    refreshConnectionStatus();
    reconnectListeners.forEach((fn) => {
      try { fn(); } catch (err) { console.error('[WS] reconnect listener error:', err); }
    });
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as WSMessage;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      listeners.forEach((fn) => fn(msg));
    } catch { /* ignore malformed messages */ }
  };

  ws.onclose = () => {
    socketHealthy = false;
    if (!disposed && listeners.size > 0) {
      // Exponential backoff so a down backend does not produce a tight
      // reconnect loop against the dev proxy / reverse proxy.
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      console.log(`[WS] disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
      refreshConnectionStatus();
      reconnectTimer = setTimeout(ensureConnection, delay);
    } else {
      refreshConnectionStatus();
    }
  };

  ws.onerror = () => ws?.close();
}

/**
 * Subscribe to WebSocket messages. Returns an unsubscribe function.
 * All callers share a single underlying connection.
 * onReconnect is called after each reconnect so callers can re-fetch state.
 */
export function connectWS(onMessage: WSMessageHandler, onReconnect?: ReconnectHandler): () => void {
  listeners.add(onMessage);
  if (onReconnect) reconnectListeners.add(onReconnect);
  ensureConnection();

  return () => {
    listeners.delete(onMessage);
    if (onReconnect) reconnectListeners.delete(onReconnect);
    if (listeners.size === 0) {
      disposed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    }
  };
}
