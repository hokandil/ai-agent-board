import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import type { Task } from '../src/types.js';

/**
 * Stage A regression tests — agent execution lifecycle correctness.
 *
 * These inject a fake in-process provider (no real CLI, no network, no paid model)
 * to deterministically verify:
 *  - terminal task.agentStatus is durably persisted (complete -> review, failed),
 *  - concurrency counters are released on completion/failure (no leak),
 *  - group queues drain and fire onChildComplete for every child.
 *
 * Before the fix, terminateOnce re-fetched a session that had already been deleted
 * and threw before releasing counters or persisting status, and startAgent never
 * invoked the status callback on real completion, so group queues never drained.
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

/** Fake provider whose execute() resolves with a configurable result. */
function makeFakeProvider(result: { status: 'complete' | 'failed'; error?: string }, hooks?: {
  onExecute?: () => void;
  onExecuteDone?: () => void;
}) {
  return {
    name: 'copilot', displayName: 'Fake Agent', model: 'fake',
    start: async () => {}, stop: async () => {},
    createSession: async (config: any) => ({
      sessionId: config.contextId,
      execute: async () => {
        hooks?.onExecute?.();
        // Emit a streamed output event so event persistence is exercised too.
        config.onEvent?.({ id: `evt-${Date.now()}`, type: 'output', content: 'working…', timestamp: Date.now(), metadata: {} });
        // Hold briefly so the execution window is measurable for concurrency checks.
        await new Promise((r) => setTimeout(r, 15));
        hooks?.onExecuteDone?.();
        return result;
      },
      send: async () => {}, abort: async () => {}, destroy: async () => {},
    }),
  };
}

function installFakeProvider(manager: AgentManager, provider: any) {
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

function statusPersister(repo: SqliteTaskRepository, taskId: string, seen: string[]) {
  return async (status: Task['agentStatus']) => {
    seen.push(status);
    const updates: Partial<Task> = { agentStatus: status };
    if (status === 'complete') { updates.completedAt = Date.now(); updates.columnId = 'review'; }
    await repo.update(taskId, updates);
  };
}

test('completion persists terminal status, moves task to review, and releases counters', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    installFakeProvider(manager, makeFakeProvider({ status: 'complete' }));

    const task = makeTask('task-complete');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, statusPersister(repo, task.id, seen));

    await waitFor(() => seen.includes('complete'));
    // Give the post-status broadcast/persistence a tick to settle.
    await new Promise((r) => setTimeout(r, 30));

    const stored = await repo.getById(task.id);
    assert.equal(stored?.agentStatus, 'complete', 'terminal status must be persisted');
    assert.equal(stored?.columnId, 'review', 'completed task must move to review');
    assert.ok(stored?.completedAt, 'completedAt must be set');
    assert.equal((manager as any).providerSessionCounts.get('copilot') ?? 0, 0, 'provider counter must be released');
    assert.equal((manager as any).projectSessionCounts.get('default') ?? 0, 0, 'project counter must be released');
    assert.equal(manager.isRunning(task.id), false, 'task must no longer be running');
  } finally { db.close(); }
});

test('failure persists failed status and releases counters', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    installFakeProvider(manager, makeFakeProvider({ status: 'failed', error: 'boom' }));

    const task = makeTask('task-fail');
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, statusPersister(repo, task.id, seen));

    await waitFor(() => seen.includes('failed'));
    await new Promise((r) => setTimeout(r, 30));

    const stored = await repo.getById(task.id);
    assert.equal(stored?.agentStatus, 'failed', 'failed status must be persisted');
    assert.equal((manager as any).providerSessionCounts.get('copilot') ?? 0, 0, 'provider counter must be released on failure');
    assert.equal(manager.isRunning(task.id), false);
  } finally { db.close(); }
});

test('group queue drains: children run within concurrency and all fire onChildComplete', async () => {
  const { db, repo } = makeRepo();
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);

    let active = 0; let maxActive = 0;
    installFakeProvider(manager, makeFakeProvider({ status: 'complete' }, {
      onExecute: () => { active++; maxActive = Math.max(maxActive, active); },
      onExecuteDone: () => { active--; },
    }));

    const children = [makeTask('child-1'), makeTask('child-2'), makeTask('child-3')];
    for (const c of children) await repo.create(c);

    const completed: string[] = [];
    const group: any = { id: 'group-1', maxConcurrency: 1 };
    manager.startGroup(
      group, children,
      (task) => statusPersister(repo, task.id, []),
      () => async () => {},
      async (taskId) => { completed.push(taskId); },
    );

    await waitFor(() => completed.length === 3, 8000);
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(completed.length, 3, 'onChildComplete must fire for every child');
    assert.equal(maxActive, 1, 'maxConcurrency=1 must never run more than one child at a time');
    assert.equal(manager.isGroupRunning('group-1'), false, 'fully drained queue must be removed');
    for (const c of children) {
      const stored = await repo.getById(c.id);
      assert.equal(stored?.agentStatus, 'complete', `child ${c.id} must be persisted complete`);
    }
    assert.equal((manager as any).providerSessionCounts.get('copilot') ?? 0, 0, 'counters released after group drains');
  } finally { db.close(); }
});

function makeTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-wt-test-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'wt-test@example.local']);
  g(['config', 'user.name', 'WT Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# worktree test\n');
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  return dir;
}

test('worktree path is persisted durably when a worktree is set up', async () => {
  const { db, repo } = makeRepo();
  const repoDir = makeTempGitRepo();
  let worktreePath: string | undefined;
  try {
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    installFakeProvider(manager, makeFakeProvider({ status: 'complete' }));

    const task = makeTask('task-wt', { useWorktree: true, repoPath: repoDir, branchName: 'agent/wt-test', baseBranch: 'main' });
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(
      task,
      statusPersister(repo, task.id, seen),
      async (wt) => { worktreePath = wt; await repo.update(task.id, { worktreePath: wt }); },
    );

    await waitFor(() => seen.includes('complete'));
    await new Promise((r) => setTimeout(r, 60));

    const stored = await repo.getById(task.id);
    assert.ok(worktreePath, 'onWorktreeCreated callback must fire');
    assert.ok(stored?.worktreePath, 'worktreePath must be persisted to the DB');
    assert.equal(stored?.worktreePath, worktreePath);
  } finally {
    if (worktreePath) {
      try { execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoDir, stdio: 'pipe', windowsHide: true }); } catch { /* best effort */ }
    }
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, stdio: 'pipe', windowsHide: true }); } catch { /* best effort */ }
    db.close();
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
