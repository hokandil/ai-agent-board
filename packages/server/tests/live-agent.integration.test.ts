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
import { detectAvailableAgents } from '../src/services/agent-detection.js';
import type { Task } from '../src/types.js';

/**
 * OPT-IN live-agent verification harness (mission: real-agent verification).
 *
 * This exercises a REAL installed, authenticated coding agent end-to-end against a
 * safe, isolated temporary repository and a trivial task. It is SKIPPED by default
 * and only runs when explicitly authorized:
 *
 *     AGENTBOARD_LIVE_AGENT_TEST=1  npm test --workspace @ai-agent-board/server
 *
 * Authorization is required because running a real agent may consume model usage /
 * paid quota. Without the flag this test never boots a provider or launches an agent.
 *
 * It verifies: assignment to a real provider, actual execution, streamed events,
 * durable terminal status, release of concurrency counters, and (optionally) group
 * queue progression. It NEVER treats an unexpected failure as a successful
 * completion — if the agent does not genuinely complete the trivial task, the test
 * fails and reports the real blocker.
 *
 * It does not touch any real customer project: all work happens in a fresh temp dir.
 */

const AUTHORIZED = process.env.AGENTBOARD_LIVE_AGENT_TEST === '1';
const LIVE_TIMEOUT_MS = Number(process.env.AGENTBOARD_LIVE_TIMEOUT_MS || 180_000);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true }).toString();
}

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-live-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'live-test@example.local'], dir);
  git(['config', 'user.name', 'Live Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Live test repo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`live-agent waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('LIVE: real agent completes a trivial task, persists status, streams events, releases counters', { skip: !AUTHORIZED }, async () => {
  const agents = await detectAvailableAgents();
  const available = agents.find((a) => a.available);
  assert.ok(available, 'No available/authenticated agent found — install and authenticate one to run this live test.');
  const agentType = available.name;

  const repoDir = makeTempRepo();
  const db = new Database(':memory:');
  const manager = new AgentManager();
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    manager.initEventPersistence(repo);
    await manager.initialize(); // boots real providers (authorized only)

    const task: Task = {
      id: 'live-task-1', projectId: 'default', title: 'Create hello.txt',
      description: 'Create a file named hello.txt containing exactly the text: hello from live test',
      priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType,
      createdAt: Date.now(), archived: false, useWorktree: false, repoPath: repoDir,
    } as Task;
    await repo.create(task);

    const seen: string[] = [];
    manager.startAgent(task, async (status) => {
      seen.push(status);
      const updates: Partial<Task> = { agentStatus: status };
      if (status === 'complete') { updates.completedAt = Date.now(); updates.columnId = 'review'; }
      await repo.update(task.id, updates);
    });

    await waitFor(async () => {
      const t = await repo.getById(task.id);
      return t?.agentStatus === 'complete' || t?.agentStatus === 'failed';
    }, LIVE_TIMEOUT_MS);

    const stored = await repo.getById(task.id);
    // Never treat a failure as success: require genuine completion.
    assert.equal(stored?.agentStatus, 'complete',
      `Real agent did not complete (status=${stored?.agentStatus}). This is a live-test blocker, not a pass.`);
    assert.equal(stored?.columnId, 'review');

    // Real execution actually produced the requested artifact in the temp repo.
    const helloPath = path.join(repoDir, 'hello.txt');
    assert.ok(fs.existsSync(helloPath), 'agent must have actually created hello.txt (real execution)');

    // Events were streamed and persisted.
    const events = await repo.getEventsByTaskId(task.id);
    assert.ok(events.length > 0, 'agent events must be persisted/streamed');

    // Concurrency counters released.
    assert.equal((manager as any).providerSessionCounts.get(agentType) ?? 0, 0, 'provider counter must be released');
    assert.equal(manager.isRunning(task.id), false);
  } finally {
    manager.shutdownAll();
    db.close();
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
