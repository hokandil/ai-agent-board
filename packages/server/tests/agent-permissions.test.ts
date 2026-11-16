import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import type { Task } from '../src/types.js';

/**
 * Stage C regression tests — interactive, bidirectional permission control.
 *
 * Deterministic: a fake ACP-style provider raises a permission request through the
 * session hook and AWAITS the Board's decision (mirroring the patched ACP provider).
 * Verifies request→respond→resume, denial, cross-task rejection, no auto-approve,
 * and cancellation on stop. No real CLI/network/paid model.
 */

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

function makeTask(id: string): Task {
  return {
    id, projectId: 'default', title: `Task ${id}`, description: 'trivial',
    priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType: 'hermes',
    createdAt: Date.now(), archived: false, useWorktree: false,
  } as Task;
}

/** Fake ACP provider: execute() requests permission via the hook and awaits the decision. */
function makeAcpProvider() {
  return {
    name: 'hermes', displayName: 'Fake ACP', model: 'fake',
    start: async () => {}, stop: async () => {},
    createSession: async (config: any) => ({
      sessionId: 'fake-acp-sess',
      execute: async () => {
        const decision = await config.hooks.onPermissionRequest({ kind: 'shell' });
        if (decision.kind === 'approved') {
          config.onEvent?.({ id: `e-${Date.now()}`, type: 'output', content: 'did the thing', timestamp: Date.now(), metadata: {} });
          return { status: 'complete' };
        }
        return { status: 'failed', error: `permission ${decision.kind}` };
      },
      send: async () => {}, abort: async () => {}, destroy: async () => {},
    }),
  };
}

function install(manager: AgentManager) {
  (manager as any).providers.set('hermes', makeAcpProvider());
  (manager as any).availableAgents = [{ name: 'hermes', displayName: 'Fake ACP', available: true }];
}

function persister(repo: SqliteTaskRepository, taskId: string, seen: string[]) {
  return async (status: Task['agentStatus']) => {
    seen.push(status);
    const updates: Partial<Task> = { agentStatus: status };
    if (status === 'complete') { updates.completedAt = Date.now(); updates.columnId = 'review'; }
    await repo.update(taskId, updates);
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('permission request is surfaced, and approving lets the agent complete', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    install(manager);
    const task = makeTask('perm-approve');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, persister(repo, task.id, seen));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    const pending = manager.getPendingPermissions(task.id)[0];
    assert.equal(pending.kind, 'shell');

    // A permission_request event was persisted/streamed.
    const events = await manager.getEvents(task.id);
    assert.ok(events.some((e) => e.type === 'permission_request' && e.metadata?.permissionRequestId === pending.requestId));

    // Not complete yet — it is waiting for the user (no auto-approve).
    assert.notEqual((await repo.getById(task.id))?.agentStatus, 'complete');

    assert.equal(manager.respondToPermission(task.id, pending.requestId, true), true);
    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await repo.getById(task.id))?.agentStatus, 'complete');
    assert.equal(manager.getPendingPermissions(task.id).length, 0);
  } finally { db.close(); }
});

test('denying a permission request fails the run (no silent approval)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    install(manager);
    const task = makeTask('perm-deny');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, persister(repo, task.id, seen));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    const pending = manager.getPendingPermissions(task.id)[0];
    assert.equal(manager.respondToPermission(task.id, pending.requestId, false), true);

    await waitFor(() => seen.includes('failed'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await repo.getById(task.id))?.agentStatus, 'failed');
  } finally { db.close(); }
});

test('a response for a different task is rejected and the request stays pending', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    install(manager);
    const task = makeTask('perm-cross');
    await repo.create(task);
    manager.startAgent(task, persister(repo, task.id, []));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    const pending = manager.getPendingPermissions(task.id)[0];

    assert.equal(manager.respondToPermission('some-other-task', pending.requestId, true), false);
    assert.equal(manager.respondToPermission(task.id, 'perm-unknown', true), false);
    assert.equal(manager.getPendingPermissions(task.id).length, 1, 'request must remain pending');

    // Clean up so the run does not linger.
    manager.respondToPermission(task.id, pending.requestId, false);
    await waitFor(() => manager.getPendingPermissions(task.id).length === 0);
    await new Promise((r) => setTimeout(r, 40));
  } finally { db.close(); }
});

test('stopping the task cancels pending permission requests', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    install(manager);
    const task = makeTask('perm-stop');
    await repo.create(task);
    manager.startAgent(task, persister(repo, task.id, []));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    await manager.stopAgent(task.id);
    await waitFor(() => manager.getPendingPermissions(task.id).length === 0);
    assert.equal(manager.getPendingPermissions(task.id).length, 0, 'pending request must be cancelled on stop');
    await new Promise((r) => setTimeout(r, 40));
  } finally { db.close(); }
});

test('Copilot permission requests are interactive (no auto-approve)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const copilotProvider = { ...makeAcpProvider(), name: 'copilot', displayName: 'Fake Copilot' };
    (manager as any).providers.set('copilot', copilotProvider);
    (manager as any).availableAgents = [{ name: 'copilot', displayName: 'Fake Copilot', available: true }];

    const task = { ...makeTask('perm-copilot'), agentType: 'copilot' as const };
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, persister(repo, task.id, seen));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    // Without an explicit decision it must NOT auto-complete.
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual((await repo.getById(task.id))?.agentStatus, 'complete', 'Copilot must not auto-approve');

    const pending = manager.getPendingPermissions(task.id)[0];
    assert.equal(manager.respondToPermission(task.id, pending.requestId, true), true);
    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await repo.getById(task.id))?.agentStatus, 'complete');
  } finally { db.close(); }
});

test('Claude permission requests are interactive via the hook (no auto-accept)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const claudeProvider = {
      name: 'claude', displayName: 'Fake Claude', model: 'fake',
      start: async () => {}, stop: async () => {},
      createSession: async (config: any) => ({
        sessionId: 'fake-claude-sess',
        execute: async () => {
          const decision = await config.hooks.onPermissionRequest({ kind: 'Bash', tool: 'Run a command' });
          if (decision.kind === 'approved') return { status: 'complete' };
          return { status: 'failed', error: 'permission denied' };
        },
        send: async () => {}, abort: async () => {}, destroy: async () => {},
      }),
    };
    (manager as any).providers.set('claude', claudeProvider);
    (manager as any).availableAgents = [{ name: 'claude', displayName: 'Fake Claude', available: true }];

    const task = { ...makeTask('perm-claude'), agentType: 'claude' as const };
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, persister(repo, task.id, seen));

    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    const pending = manager.getPendingPermissions(task.id)[0];
    assert.equal(pending.tool, 'Run a command', 'tool label must be carried to the Board');
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual((await repo.getById(task.id))?.agentStatus, 'complete', 'Claude must not auto-accept');

    assert.equal(manager.respondToPermission(task.id, pending.requestId, true), true);
    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await repo.getById(task.id))?.agentStatus, 'complete');
  } finally { db.close(); }
});

test('C3: permission request expires after TTL and a late response is rejected (no stale approval)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    process.env.AGENTBOARD_PERMISSION_TTL_MS = '40';
    const decision = manager.requestPermission('task-exp', 'sess-exp', 'shell');
    assert.equal(await decision, 'expired', 'request must expire without a user decision');
    assert.equal(manager.getPendingPermissions('task-exp').length, 0);
    const events = await manager.getEvents('task-exp');
    const req = events.find((e) => e.type === 'permission_request' && e.metadata?.permissionRequestId);
    assert.ok(req, 'permission_request event emitted');
    assert.equal(manager.respondToPermission('task-exp', req!.metadata!.permissionRequestId!, true), false,
      'a response after expiry must be rejected (never reuse a stale approval)');
  } finally { delete process.env.AGENTBOARD_PERMISSION_TTL_MS; db.close(); }
});

test('C3: shutdown cancels pending permission requests', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const decision = manager.requestPermission('task-shut', 'sess-shut', 'shell');
    assert.equal(manager.getPendingPermissions('task-shut').length, 1);
    manager.shutdownAll();
    assert.equal(await decision, 'cancelled', 'pending request must be cancelled on shutdown');
    assert.equal(manager.getPendingPermissions('task-shut').length, 0);
  } finally { db.close(); }
});

test('OpenCode permission requests are routed to the Board hook (no auto-approve)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const provider = {
      name: 'opencode', displayName: 'Fake OpenCode', model: 'fake',
      start: async () => {}, stop: async () => {},
      createSession: async (config: any) => ({
        sessionId: 'fake-oc-sess',
        execute: async () => {
          const decision = await config.hooks.onPermissionRequest({ kind: 'bash', tool: 'Run command' });
          return decision.kind === 'approved' ? { status: 'complete' } : { status: 'failed', error: 'denied' };
        },
        send: async () => {}, abort: async () => {}, destroy: async () => {},
      }),
    };
    (manager as any).providers.set('opencode', provider);
    (manager as any).availableAgents = [{ name: 'opencode', displayName: 'Fake OpenCode', available: true }];

    const task = { ...makeTask('perm-oc'), agentType: 'opencode' as const };
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, persister(repo, task.id, seen));
    await waitFor(() => manager.getPendingPermissions(task.id).length > 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual((await repo.getById(task.id))?.agentStatus, 'complete', 'OpenCode must not auto-approve');
    const pending = manager.getPendingPermissions(task.id)[0];
    manager.respondToPermission(task.id, pending.requestId, true);
    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await repo.getById(task.id))?.agentStatus, 'complete');
  } finally { db.close(); }
});
