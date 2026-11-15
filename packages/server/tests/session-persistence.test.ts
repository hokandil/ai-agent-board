import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import type { Task } from '../src/types.js';

/**
 * Stage B regression tests — session visibility & persistence.
 *
 * Deterministic (fake in-process provider; no CLI/network/paid model). Verifies:
 *  - the provider-side session id is persisted durably on the task (agentSessionId),
 *  - a terminal session remains queryable after completion (reattachment/visibility),
 *  - resumeSession resumes the provider conversation via the SDK resumeSessionId
 *    (a true resume), rather than silently starting a brand-new conversation.
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
    priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType: 'copilot',
    createdAt: Date.now(), archived: false, useWorktree: false,
  } as Task;
}

/** Fake provider that exposes a stable provider-side sessionId and records configs. */
function makeSessionProvider(providerSessionId: string) {
  const configs: any[] = [];
  const provider = {
    name: 'copilot', displayName: 'Fake Agent', model: 'fake',
    start: async () => {}, stop: async () => {},
    createSession: async (config: any) => {
      configs.push(config);
      return {
        sessionId: providerSessionId,
        execute: async () => {
          config.onEvent?.({ id: `evt-${Date.now()}`, type: 'output', content: 'working…', timestamp: Date.now(), metadata: {} });
          return { status: 'complete' };
        },
        send: async () => {}, abort: async () => {}, destroy: async () => {},
      };
    },
  };
  return { provider, configs };
}

function install(manager: AgentManager, provider: any) {
  (manager as any).providers.set('copilot', provider);
  (manager as any).availableAgents = [{ name: 'copilot', displayName: 'Fake Agent', available: true }];
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('provider session id is persisted durably and the terminal session stays queryable', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const { provider } = makeSessionProvider('prov-sess-1');
    install(manager, provider);

    const task = makeTask('task-sess');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, async (status) => {
      seen.push(status);
      const updates: Partial<Task> = { agentStatus: status };
      if (status === 'complete') { updates.completedAt = Date.now(); updates.columnId = 'review'; }
      await repo.update(task.id, updates);
    });

    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 40));

    const stored = await repo.getById(task.id);
    assert.equal(stored?.agentSessionId, 'prov-sess-1', 'provider session id must be persisted on the task');

    const sess = manager.listSessions().find((s) => s.taskId === task.id);
    assert.ok(sess, 'terminal session must remain queryable after completion');
    assert.equal(sess!.status, 'complete');
    assert.equal(manager.isRunning(task.id), false, 'completed task is not running');
  } finally { db.close(); }
});

test('resumeSession resumes the provider conversation via resumeSessionId (true resume)', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const { provider, configs } = makeSessionProvider('prov-sess-2');
    install(manager, provider);

    const task = makeTask('task-resume');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, async (status) => {
      seen.push(status);
      const updates: Partial<Task> = { agentStatus: status };
      if (status === 'complete') { updates.completedAt = Date.now(); updates.columnId = 'review'; }
      await repo.update(task.id, updates);
    });

    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(configs.length, 1);
    assert.equal(configs[0].resumeSessionId, undefined, 'first run is a fresh session');

    const sess = manager.listSessions().find((s) => s.taskId === task.id);
    assert.ok(sess);
    await manager.resumeSession(sess!.id);
    await waitFor(() => configs.length >= 2);

    assert.equal(configs[1].resumeSessionId, 'prov-sess-2',
      'resume must pass the stored provider session id to the SDK (true conversation resume)');

    // Let the resumed run finish so no trailing writes race db.close().
    await waitFor(() => seen.filter((s) => s === 'complete').length >= 2);
    await new Promise((r) => setTimeout(r, 50));
  } finally { db.close(); }
});
