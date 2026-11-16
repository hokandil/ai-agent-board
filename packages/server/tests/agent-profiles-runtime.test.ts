import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import type { Task } from '../src/types.js';
import type { AgentProfile } from '@ai-agent-board/shared/types.js';

/**
 * Stage E regression tests — agent profile delivery to the runtime.
 *
 * These inject a fake in-process provider (no real CLI, no network, no paid model)
 * that captures the createSession() config, so we can deterministically prove that a
 * task's agent profile is actually applied to the coding agent — not just stored in the UI.
 *
 * Verifies:
 *  - profile.model is forwarded to provider.createSession (model override),
 *  - profile.instructions are injected into the system prompt,
 *  - profile.provider overrides the task's agentType for provider selection,
 *  - profile.mcpServerIds restrict delivered MCP servers to the selected set,
 *  - a task's snapshot is used so later profile edits do not change a running task.
 */

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, projectId: 'default', title: `Task ${id}`, description: 'do something trivial',
    priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType: 'copilot',
    createdAt: Date.now(), archived: false, useWorktree: false, ...overrides,
  } as Task;
}

/** Fake provider that records the config it was created with. */
function makeRecordingProvider(agentType: string, captured: { configs: any[] }) {
  return {
    name: agentType, displayName: `Fake ${agentType}`, model: 'default',
    start: async () => {}, stop: async () => {},
    createSession: async (config: any) => {
      captured.configs.push(config);
      return {
        sessionId: config.contextId,
        execute: async () => {
          config.onEvent?.({ id: `evt-${Date.now()}`, type: 'output', content: 'ok', timestamp: Date.now(), metadata: {} });
          return { status: 'complete' as const };
        },
        send: async () => {}, abort: async () => {}, destroy: async () => {},
      };
    },
  };
}

function installProvider(manager: AgentManager, agentType: string, provider: any) {
  (manager as any).providers.set(agentType, provider);
  const list = (manager as any).availableAgents as Array<{ name: string; available: boolean }>;
  if (!list.some((a) => a.name === agentType)) {
    list.push({ name: agentType, displayName: `Fake ${agentType}`, available: true });
  } else {
    const entry = list.find((a) => a.name === agentType)!;
    entry.available = true;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const IGNORE_STATUS = () => {};

test('profile model + instructions are delivered to the provider session', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    const snapshot: AgentProfile = {
      id: 'agent-profile:backend', name: 'Backend Developer', provider: 'copilot',
      model: 'gpt-5.1-codex', instructions: 'Always write focused unit tests.',
      mcpServerIds: [], skillIds: [], enabled: true, createdAt: 1, updatedAt: 1,
    };
    const task = makeTask('task-model', { agentProfileId: snapshot.id, agentProfileSnapshot: snapshot });
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);

    const cfg = captured.configs[0];
    assert.equal(cfg.model, 'gpt-5.1-codex', 'profile model must reach createSession config');
    assert.ok(cfg.systemPrompt.includes('Always write focused unit tests.'), 'profile instructions must be injected into system prompt');
    assert.ok(cfg.systemPrompt.includes('Agent profile instructions'), 'instructions section header present');
  } finally { db.close(); }
});

test('profile provider overrides task agentType for provider selection', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    // Task is copilot, but the profile selects claude.
    installProvider(manager, 'claude', makeRecordingProvider('claude', captured));

    const snapshot: AgentProfile = {
      id: 'agent-profile:claude', name: 'Claude Dev', provider: 'claude',
      model: null, instructions: null, mcpServerIds: [], skillIds: [], enabled: true,
      createdAt: 1, updatedAt: 1,
    };
    const task = makeTask('task-provider', { agentType: 'copilot', agentProfileId: snapshot.id, agentProfileSnapshot: snapshot });
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0, 5000);

    assert.equal(captured.configs.length, 1, 'the claude (profile) provider must be used, not copilot');
  } finally { db.close(); }
});

test('profile MCP selection restricts delivered servers', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    manager.initMcpRepository(repo);

    // Two servers, both allowed for copilot.
    const s1 = await repo.createServer({
      id: 'mcp-server:one', name: 'One', transport: 'stdio', command: 'node', args: [],
      env: {}, headers: {}, status: 'disconnected',
    } as any);
    const s2 = await repo.createServer({
      id: 'mcp-server:two', name: 'Two', transport: 'stdio', command: 'node', args: [],
      env: {}, headers: {}, status: 'disconnected',
    } as any);
    await repo.setPermission(s1.id, 'copilot', 'tool_a', true);
    await repo.setPermission(s2.id, 'copilot', 'tool_b', true);

    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    // Profile selects only server one.
    const snapshot: AgentProfile = {
      id: 'agent-profile:mcp', name: 'MCP Picker', provider: 'copilot',
      model: null, instructions: null, mcpServerIds: [s1.id], skillIds: [], enabled: true,
      createdAt: 1, updatedAt: 1,
    };
    const task = makeTask('task-mcp', { agentProfileId: snapshot.id, agentProfileSnapshot: snapshot });
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);

    const cfg = captured.configs[0];
    assert.ok(cfg.mcpServers, 'MCP servers must be delivered');
    const keys = Object.keys(cfg.mcpServers);
    assert.ok(keys.includes('one'), 'selected server one delivered');
    assert.ok(!keys.includes('two'), 'unselected server two NOT delivered');
  } finally { db.close(); }
});

test('task uses its snapshot; later profile edits do not affect it', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    const snapshot: AgentProfile = {
      id: 'agent-profile:v1', name: 'Original', provider: 'copilot',
      model: 'model-v1', instructions: 'Original instructions.',
      mcpServerIds: [], skillIds: [], enabled: true, createdAt: 1, updatedAt: 1,
    };
    const task = makeTask('task-snapshot', { agentProfileId: snapshot.id, agentProfileSnapshot: snapshot });
    await repo.create(task);
    // Persist the profile itself, then edit it.
    await repo.createAgentProfile({ ...snapshot, id: undefined as any }).catch(() => {});
    await repo.updateAgentProfile(snapshot.id, { name: 'Renamed', model: 'model-v2', instructions: 'Changed instructions.' }).catch(() => {});

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);

    const cfg = captured.configs[0];
    // Runtime prefers the snapshot stored on the task, so the original config wins.
    assert.equal(cfg.model, 'model-v1', 'snapshot model must win over edited profile');
    assert.ok(cfg.systemPrompt.includes('Original instructions.'), 'snapshot instructions must win over edited profile');
    assert.ok(!cfg.systemPrompt.includes('Changed instructions.'), 'edited profile instructions must not leak in');
  } finally { db.close(); }
});

test('a task with no profile is unaffected by profile code path', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    const task = makeTask('task-noprofile');
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);

    const cfg = captured.configs[0];
    assert.ok(!('model' in cfg) || cfg.model === undefined, 'no model override when no profile');
    assert.ok(!cfg.systemPrompt.includes('Agent profile instructions'), 'no profile section when no profile');
  } finally { db.close(); }
});

test('getProviderDefaultModels surfaces real configured models, not placeholders', () => {
  const manager = new AgentManager();
  // A provider with an explicit configured model is surfaced as-is.
  (manager as any).providers.set('copilot', { name: 'copilot', displayName: 'Copilot', model: 'claude-opus-4' });
  // A provider reporting the SDK placeholder 'configured default' is normalized to null
  // so the UI never implies a model that is not actually set.
  (manager as any).providers.set('claude', { name: 'claude', displayName: 'Claude', model: 'configured default' });
  const models = manager.getProviderDefaultModels();
  assert.equal(models.copilot, 'claude-opus-4');
  assert.equal(models.claude, null);
});

test('executor saved config (by provider) reaches runtime when the task only selects an agent', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    // Save an executor configuration for provider 'copilot' (one row per provider).
    await repo.createAgentProfile({
      name: 'copilot', provider: 'copilot', model: 'gpt-5.1-codex',
      instructions: 'Follow the repo code style.', mcpServerIds: [], skillIds: [], enabled: true,
    });

    // A task with NO explicit profileId — only the agent selector (agentType='copilot').
    const task = makeTask('task-executor-config', { agentType: 'copilot' });
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);

    const cfg = captured.configs[0];
    assert.equal(cfg.model, 'gpt-5.1-codex', 'executor saved model must reach createSession config');
    assert.ok(cfg.systemPrompt.includes('Follow the repo code style.'), 'executor instructions must be injected');
  } finally { db.close(); }
});

test('explicit task snapshot takes precedence over the provider saved config', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const captured: { configs: any[] } = { configs: [] };
    installProvider(manager, 'copilot', makeRecordingProvider('copilot', captured));

    // Saved executor config says model A…
    await repo.createAgentProfile({
      name: 'copilot', provider: 'copilot', model: 'model-a',
      instructions: null, mcpServerIds: [], skillIds: [], enabled: true,
    });
    // …but this task captured model B at creation (an earlier executor state).
    const snapshot: AgentProfile = {
      id: 'agent-profile:snap', name: 'copilot', provider: 'copilot', model: 'model-b',
      instructions: null, mcpServerIds: [], skillIds: [], enabled: true, createdAt: 1, updatedAt: 1,
    };
    const task = makeTask('task-precedence', { agentType: 'copilot', agentProfileId: snapshot.id, agentProfileSnapshot: snapshot });
    await repo.create(task);

    manager.startAgent(task, IGNORE_STATUS);
    await waitFor(() => captured.configs.length > 0);
    assert.equal(captured.configs[0].model, 'model-b', 'snapshot wins over later saved config');
  } finally { db.close(); }
});

test('getAgentProfileByProvider ignores disabled rows', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.createAgentProfile({
      name: 'codex', provider: 'codex', model: 'gpt-5-codex',
      instructions: null, mcpServerIds: [], skillIds: [], enabled: false,
    });
    const found = await repo.getAgentProfileByProvider('codex');
    assert.equal(found, undefined, 'disabled executor config is not selected for runtime');
  } finally { db.close(); }
});

