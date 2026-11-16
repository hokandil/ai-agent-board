import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { collectAllowedMcpServers, buildMcpServersPayload, buildMcpServersForAgent } from '../src/services/mcp-delivery.js';
import type { Task } from '../src/types.js';

/**
 * Stage D regression tests — MCP delivery to agent sessions.
 * Deterministic: in-memory SQLite + fake providers. No real CLI/network/paid model.
 * Verifies default-deny enforcement, per-provider native formats, actual delivery into
 * provider.createSession, and that credentials never appear in emitted events.
 */

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

async function seed(repo: SqliteTaskRepository) {
  const stdio = await repo.createServer({
    id: 'mcp-server:stdio', name: 'Stdio Server', transport: 'stdio',
    command: 'node', args: ['server.js'], env: { API_KEY: 'sk-secret' }, cwd: '/tmp',
    headers: {}, status: 'disconnected',
  } as any);
  const http = await repo.createServer({
    id: 'mcp-server:http', name: 'HTTP Server', transport: 'streamable-http',
    url: 'https://mcp.example/mcp', args: [], env: {}, headers: { Authorization: 'Bearer secret-token' },
    status: 'disconnected',
  } as any);
  const denied = await repo.createServer({
    id: 'mcp-server:denied', name: 'Denied Server', transport: 'stdio',
    command: 'node', args: [], env: {}, headers: {}, status: 'disconnected',
  } as any);
  // copilot: stdio tool_a allowed, tool_b denied; http read allowed; denied server none.
  await repo.setPermission(stdio.id, 'copilot', 'tool_a', true);
  await repo.setPermission(stdio.id, 'copilot', 'tool_b', false);
  await repo.setPermission(http.id, 'copilot', 'read', true);
  await repo.setPermission(denied.id, 'copilot', 'tool_x', false);
  // claude: only stdio tool_a allowed.
  await repo.setPermission(stdio.id, 'claude', 'tool_a', true);
  return { stdio, http, denied };
}

test('collectAllowedMcpServers is default-deny and filters to allowed tools', async () => {
  const { db, repo } = makeRepo();
  try {
    await seed(repo);
    const delivery = await collectAllowedMcpServers(repo, 'copilot');
    const ids = delivery.map((d) => d.record.id).sort();
    assert.deepEqual(ids, ['mcp-server:http', 'mcp-server:stdio'], 'denied server must not be delivered');
    const stdio = delivery.find((d) => d.record.id === 'mcp-server:stdio')!;
    assert.deepEqual(stdio.allowedTools, ['tool_a'], 'only allowed tools collected');
    // An agent with no allowed tools gets nothing.
    assert.deepEqual(await collectAllowedMcpServers(repo, 'codex'), []);
  } finally { db.close(); }
});

test('buildMcpServersPayload produces provider-native formats with enforcement', async () => {
  const { db, repo } = makeRepo();
  try {
    await seed(repo);
    const delivery = await collectAllowedMcpServers(repo, 'copilot');

    const copilot = buildMcpServersPayload('copilot', delivery) as Record<string, any>;
    assert.equal(copilot['stdio-server'].type, 'stdio');
    assert.equal(copilot['stdio-server'].command, 'node');
    assert.deepEqual(copilot['stdio-server'].tools, ['tool_a'], 'Copilot tool allowlist enforced');
    assert.equal(copilot['stdio-server'].env.API_KEY, 'sk-secret', 'credentials passed to SDK config');
    assert.equal(copilot['http-server'].type, 'http');
    assert.deepEqual(copilot['http-server'].tools, ['read']);

    const claude = buildMcpServersPayload('claude', await collectAllowedMcpServers(repo, 'claude')) as Record<string, any>;
    assert.equal(claude['stdio-server'].type, 'stdio');
    assert.ok(!('http-server' in claude), 'claude has no allowed http tools -> not delivered');

    const acp = buildMcpServersPayload('hermes', delivery) as Array<any>;
    const acpStdio = acp.find((s) => s.name === 'Stdio Server');
    assert.deepEqual(acpStdio.env, [{ name: 'API_KEY', value: 'sk-secret' }], 'ACP env pairs');
    const acpHttp = acp.find((s) => s.name === 'HTTP Server');
    assert.deepEqual(acpHttp.headers, [{ name: 'Authorization', value: 'Bearer secret-token' }], 'ACP header pairs');

    // Unsupported provider -> nothing delivered (explicit limitation, not a fake payload).
    assert.equal(buildMcpServersPayload('codex', delivery), undefined);
    assert.equal(await buildMcpServersForAgent(repo, 'opencode'), undefined);
  } finally { db.close(); }
});

test('startSession delivers allowed MCP servers into provider.createSession; credentials not in events', async () => {
  const { db, repo } = makeRepo();
  try {
    await seed(repo);
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    manager.initMcpRepository(repo);

    let captured: any = null;
    const provider = {
      name: 'copilot', displayName: 'Fake', model: 'fake',
      start: async () => {}, stop: async () => {},
      createSession: async (config: any) => {
        captured = config;
        return {
          sessionId: 'fake-sess',
          execute: async () => ({ status: 'complete' }),
          send: async () => {}, abort: async () => {}, destroy: async () => {},
        };
      },
    };
    (manager as any).providers.set('copilot', provider);
    (manager as any).availableAgents = [{ name: 'copilot', displayName: 'Fake', available: true }];

    const task: Task = {
      id: 'task-mcp', projectId: 'default', title: 'MCP task', description: '',
      priority: 'medium', columnId: 'in-progress', agentStatus: 'idle', agentType: 'copilot',
      createdAt: Date.now(), archived: false, useWorktree: false,
    } as Task;
    await repo.create(task);
    const seen: string[] = [];
    manager.startAgent(task, async (s) => { seen.push(s); await repo.update(task.id, { agentStatus: s }); });

    const start = Date.now();
    while (!seen.includes('complete') && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 15));
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(captured, 'provider.createSession must be called');
    assert.ok(captured.mcpServers, 'mcpServers must be delivered to the provider');
    assert.deepEqual(captured.mcpServers['stdio-server'].tools, ['tool_a']);
    assert.ok(!captured.mcpServers['denied-server'], 'denied server not delivered');

    // Credentials must never appear in emitted/persisted events.
    const events = await manager.getEvents(task.id);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('sk-secret'), 'env credential must not leak into events');
    assert.ok(!serialized.includes('Bearer secret-token'), 'header credential must not leak into events');
  } finally { db.close(); }
});
