import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import {
  cleanupPersistedTaskWorktree,
  cleanupTaskWorktree,
  inspectWorktreeProcessUse,
  reconcileManagedWorktrees,
} from '../src/services/worktree-cleanup.js';
import type { WorktreeCleanupResult } from '../src/services/worktree-cleanup.js';

// Removing a worktree requires proving that no process is using it. The
// service can only prove that where the platform exposes a process table
// (Linux /proc). On Windows and macOS the inspection returns 'unknown', and the
// service must then fail closed: the worktree is retained, never deleted.
//
// The assertions below therefore state each platform's real contract. On Linux
// they require the worktree to be removed; on every other platform they require
// the fail-closed refusal, the blocking reason, and that the worktree survives.
// Neither branch weakens the safety assertions — the non-Linux branch is
// strictly stricter about data retention.
const canVerifyProcessUse = process.platform === 'linux';
const PROCESS_USE_UNVERIFIED = /could not verify that no process is using the worktree/i;

/** Assert the cleanup outcome the current platform must produce. */
function assertCleanupRemoved(result: WorktreeCleanupResult): void {
  if (canVerifyProcessUse) {
    assert.deepEqual(result, { status: 'removed' });
    return;
  }
  assert.equal(result.status, 'blocked');
  assert.match(result.status === 'blocked' ? result.reason : '', PROCESS_USE_UNVERIFIED);
}

/** Assert whether a worktree directory must still exist after cleanup. */
function assertWorktreeRetained(worktreePath: string, retained: boolean): void {
  assert.equal(existsSync(worktreePath), retained);
}

/**
 * Compare two paths regardless of separator style. Git reports worktree paths
 * with forward slashes on Windows, while Node's path APIs report backslashes.
 */
function samePath(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined) => {
    if (value === undefined) return '';
    const unified = value.replace(/\\/g, '/');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
  };
  return normalize(left) === normalize(right);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function fixture(): { repoPath: string; worktreePath: string; branchName: string; task: Task; dispose(): void } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'agentboard-cleanup-repo-'));
  const id = randomUUID();
  const worktreePath = path.join(os.tmpdir(), `agentboard-${id}-${randomUUID().slice(0, 6)}`);
  const branchName = `agent/test-${id}`;
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'agentboard-tests@example.invalid'], repoPath);
  git(['config', 'user.name', 'Agent Board Tests'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\nnode_modules/\n');
  git(['add', 'README.md', '.gitignore'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  git(['worktree', 'add', '-b', branchName, worktreePath, 'main'], repoPath);
  const task: Task = {
    id,
    title: 'Cleanup fixture',
    description: '',
    priority: 'medium',
    columnId: 'done',
    agentStatus: 'complete',
    createdAt: Date.now(),
    projectId: 'project-1',
    repoPath,
    branchName,
    baseBranch: 'main',
    useWorktree: true,
    worktreePath,
  };
  return {
    repoPath,
    worktreePath,
    branchName,
    task,
    dispose() {
      try { git(['worktree', 'remove', worktreePath, '--force'], repoPath); } catch { /* already removed */ }
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    },
  };
}

test('clean managed worktree is removed while its branch is preserved', () => {
  const f = fixture();
  try {
    const result = cleanupTaskWorktree(f.task);
    assertCleanupRemoved(result);
    assertWorktreeRetained(f.worktreePath, !canVerifyProcessUse);
    // Git marks a branch that is checked out in a linked worktree with '+'.
    assert.equal(git(['branch', '--list', f.branchName], f.repoPath).replace(/^[*+]\s*/, ''), f.branchName);
  } finally {
    f.dispose();
  }
});

test('dirty managed worktree is retained without losing uncommitted files', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.worktreePath, 'uncommitted.txt'), 'keep me\n');
    const result = cleanupTaskWorktree(f.task);
    assert.equal(result.status, 'blocked');
    assert.match(result.status === 'blocked' ? result.reason : '', /uncommitted/i);
    assert.equal(existsSync(path.join(f.worktreePath, 'uncommitted.txt')), true);
  } finally {
    f.dispose();
  }
});

test('cleanup rejects paths outside the Board-managed temp namespace', () => {
  const f = fixture();
  try {
    const result = cleanupTaskWorktree({ ...f.task, worktreePath: f.repoPath });
    assert.equal(result.status, 'blocked');
    assert.match(result.status === 'blocked' ? result.reason : '', /managed worktree path/i);
    assert.equal(existsSync(f.repoPath), true);
  } finally {
    f.dispose();
  }
});

test('cleanup requires the exact managed suffix and expected branch', () => {
  const f = fixture();
  try {
    for (const task of [
      { ...f.task, worktreePath: `${f.worktreePath}-extra` },
      { ...f.task, branchName: undefined },
      { ...f.task, branchName: 'agent/wrong-branch' },
    ]) {
      const result = cleanupTaskWorktree(task);
      assert.equal(result.status, 'blocked');
    }
    assert.equal(existsSync(f.worktreePath), true);
  } finally {
    f.dispose();
  }
});

test('cleanup permits generated dependencies but blocks ignored files that may contain data', () => {
  const generated = fixture();
  const valuable = fixture();
  try {
    mkdirSync(path.join(generated.worktreePath, 'node_modules'));
    writeFileSync(path.join(generated.worktreePath, 'node_modules', 'cache.txt'), 'generated\n');
    assertCleanupRemoved(cleanupTaskWorktree(generated.task));

    writeFileSync(path.join(valuable.worktreePath, '.env'), 'do-not-delete\n');
    const blocked = cleanupTaskWorktree(valuable.task);
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.status === 'blocked' ? blocked.reason : '', /non-disposable ignored/i);
    assert.equal(existsSync(path.join(valuable.worktreePath, '.env')), true);
  } finally {
    generated.dispose();
    valuable.dispose();
  }
});

test('process-use inspection fails closed when the platform or process table cannot be verified', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentboard-process-check-'));
  try {
    assert.equal(inspectWorktreeProcessUse(root, 'darwin'), 'unknown');
    assert.equal(inspectWorktreeProcessUse(root, 'linux', path.join(root, 'missing-proc')), 'unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup blocks while a process is using the worktree', async () => {
  if (process.platform !== 'linux') return;
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: f.worktreePath });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    const result = cleanupTaskWorktree(f.task);
    assert.equal(result.status, 'blocked');
    assert.match(result.status === 'blocked' ? result.reason : '', /running process/i);
    assert.equal(existsSync(f.worktreePath), true);
  } finally {
    child.kill();
    f.dispose();
  }
});

test('missing worktree is idempotent and can be cleared from persisted task state', () => {
  const f = fixture();
  try {
    git(['worktree', 'remove', f.worktreePath], f.repoPath);
    const result = cleanupTaskWorktree(f.task);
    assert.deepEqual(result, { status: 'missing' });
  } finally {
    f.dispose();
  }
});

test('startup reconciliation removes clean terminal worktrees and clears persisted paths', async () => {
  const f = fixture();
  const updates: Array<Partial<Task>> = [];
  const repo = {
    update: async (_id: string, update: Partial<Task>) => {
      updates.push(update);
      return { ...f.task, ...update };
    },
  } as unknown as TaskRepository;
  try {
    const report = await reconcileManagedWorktrees([f.task], [f.repoPath], repo);
    if (canVerifyProcessUse) {
      assert.deepEqual(report, { removed: [f.worktreePath], missing: [], blocked: [] });
      assert.deepEqual(updates, [{ worktreePath: undefined }]);
      assertWorktreeRetained(f.worktreePath, false);
    } else {
      assert.deepEqual(report.removed, []);
      assert.deepEqual(report.missing, []);
      assert.equal(report.blocked.length, 1);
      assert.equal(report.blocked[0]?.path, f.worktreePath);
      assert.match(report.blocked[0]?.reason ?? '', PROCESS_USE_UNVERIFIED);
      assert.deepEqual(updates, [], 'a retained worktree must keep its persisted path');
      assertWorktreeRetained(f.worktreePath, true);
    }
  } finally {
    f.dispose();
  }
});

test('startup reconciliation retains review and dirty terminal worktrees', async () => {
  const review = fixture();
  const dirty = fixture();
  dirty.task.archived = true;
  writeFileSync(path.join(dirty.worktreePath, 'uncommitted.txt'), 'keep me\n');
  const repo = { update: async () => { throw new Error('must not update retained worktrees'); } } as unknown as TaskRepository;
  try {
    const report = await reconcileManagedWorktrees([
      { ...review.task, columnId: 'review' },
      dirty.task,
    ], [review.repoPath, dirty.repoPath], repo);
    assert.deepEqual(report.removed, []);
    assert.deepEqual(report.missing, []);
    assert.equal(report.blocked.length, 1);
    assert.equal(report.blocked[0]?.path, dirty.worktreePath);
    assert.equal(existsSync(review.worktreePath), true);
    assert.equal(existsSync(dirty.worktreePath), true);
  } finally {
    review.dispose();
    dirty.dispose();
  }
});

test('startup reconciliation removes only clean unreferenced Board worktrees', async () => {
  const clean = fixture();
  const dirty = fixture();
  writeFileSync(path.join(dirty.worktreePath, 'uncommitted.txt'), 'keep me\n');
  const repo = { update: async () => { throw new Error('orphan cleanup must not update task state'); } } as unknown as TaskRepository;
  try {
    const report = await reconcileManagedWorktrees([], [clean.repoPath, dirty.repoPath], repo);
    if (canVerifyProcessUse) {
      assert.deepEqual(report.removed, [clean.worktreePath]);
      assert.equal(report.blocked.length, 1);
      assert.equal(report.blocked[0]?.path, dirty.worktreePath);
      assertWorktreeRetained(clean.worktreePath, false);
    } else {
      assert.deepEqual(report.removed, []);
      assert.equal(report.blocked.length, 2);
      assert.ok(samePath(report.blocked[0]?.path, clean.worktreePath), `expected ${clean.worktreePath}, got ${report.blocked[0]?.path}`);
      assert.match(report.blocked[0]?.reason ?? '', PROCESS_USE_UNVERIFIED);
      assert.ok(samePath(report.blocked[1]?.path, dirty.worktreePath), `expected ${dirty.worktreePath}, got ${report.blocked[1]?.path}`);
      assertWorktreeRetained(clean.worktreePath, true);
    }
    assert.equal(existsSync(dirty.worktreePath), true);
  } finally {
    clean.dispose();
    dirty.dispose();
  }
});

test('a worktree whose process usage cannot be verified keeps its persisted path', async () => {
  const f = fixture();
  const updates: Array<Partial<Task>> = [];
  const repo = {
    update: async (_id: string, update: Partial<Task>) => {
      updates.push(update);
      return { ...f.task, ...update };
    },
  } as unknown as TaskRepository;
  try {
    const { task, result } = await cleanupPersistedTaskWorktree(f.task, repo);
    if (canVerifyProcessUse) {
      assert.deepEqual(result, { status: 'removed' });
      assert.deepEqual(updates, [{ worktreePath: undefined }]);
      assert.equal(task.worktreePath, undefined);
    } else {
      assert.equal(result.status, 'blocked');
      assert.match(result.status === 'blocked' ? result.reason : '', PROCESS_USE_UNVERIFIED);
      assert.deepEqual(updates, [], 'a retained worktree must keep its persisted path');
      assert.equal(task.worktreePath, f.worktreePath);
      assertWorktreeRetained(f.worktreePath, true);
    }
  } finally {
    f.dispose();
  }
});
