import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createMcpRouter } from '../src/routes/mcp.js';
import { createMcpSyncRouter } from '../src/routes/mcp-sync.js';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { requiredScope } from '../src/middleware/auth.js';

function makeAgentManager() {
  return { getAvailableAgents: () => [] } as any;
}
function makeAuditLogger() {
  return { log: async () => {}, logMcpEvent: async () => {}, logSyncEvent: async () => {} } as any;
}

async function withMcpApi(run: (base: string, repo: SqliteTaskRepository) => Promise<void>): Promise<void> {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    const app = express();
    app.use(express.json());
    app.use('/api/mcp', createMcpRouter(repo, makeAgentManager(), makeAuditLogger()));
    app.use('/api/mcp/sync', createMcpSyncRouter(repo, new SqliteProjectRepository(db), makeAuditLogger()));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      await run(`http://127.0.0.1:${address.port}`, repo);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  } finally {
    db.close();
  }
}

// ── Auth scope-prefix fix ────────────────────────────────────────────────────

test('MCP server CRUD mutations require mcp:write, not mcp:board:write', () => {
  const scope = (path: string, method: string) => requiredScope({ path, method } as Request);
  assert.equal(scope('/mcp/servers/abc/disconnect', 'POST'), 'mcp:write');
  assert.equal(scope('/mcp/servers/abc/test-tool', 'POST'), 'mcp:write');
  assert.equal(scope('/mcp/servers/abc', 'PUT'), 'mcp:write');
  assert.equal(scope('/mcp/servers/abc', 'DELETE'), 'mcp:write');
  assert.equal(scope('/mcp/servers/abc/connect', 'POST'), 'mcp:connect');
});

test('board-as-MCP-server endpoint keeps its own scopes', () => {
  const scope = (path: string, method: string) => requiredScope({ path, method } as Request);
  assert.equal(scope('/mcp/server', 'POST'), 'mcp:board:write');
  assert.equal(scope('/mcp/server', 'GET'), 'mcp:read'); // GET /mcp/* resolves to mcp:read first
});

// ── Permissions route param fix + sync engine wiring ─────────────────────────

test('GET /api/mcp/permissions/:serverId returns permissions for the server (not 404)', async () => {
  await withMcpApi(async (base, repo) => {
    const server = await repo.createServer({
      id: 'mcp-server:perm-test', name: 'Perm Test', transport: 'streamable-http',
      url: 'http://localhost:9/mcp', args: [], env: {}, headers: {}, status: 'disconnected',
    } as any);
    await repo.upsertTools(server.id, [
      { name: 'get_task', description: 'Get a task', inputSchema: { type: 'object' } } as any,
    ]);
    await repo.setPermission(server.id, 'copilot', 'get_task', true);

    const res = await fetch(`${base}/api/mcp/permissions/${encodeURIComponent(server.id)}`);
    assert.equal(res.status, 200, 'permissions-by-server must resolve the :serverId param');
    const perms = await res.json();
    assert.ok(Array.isArray(perms));
    assert.ok(perms.some((p: any) => p.tool_name === 'get_task' && p.allowed === true));
  });
});

test('sync engine is wired to real repos (sync reaches MCP client, not a stub TypeError)', async () => {
  await withMcpApi(async (base, repo) => {
    const server = await repo.createServer({
      id: 'mcp-server:sync-test', name: 'Sync Test', transport: 'streamable-http',
      url: 'http://localhost:9/mcp', args: [], env: {}, headers: {}, status: 'disconnected',
    } as any);
    await repo.create({
      id: 'task-sync-1', projectId: 'default', title: 'Sync task', description: '',
      priority: 'medium', columnId: 'backlog', agentStatus: 'idle', agentType: 'copilot',
      createdAt: Date.now(), archived: false,
    } as any);
    const conn = await repo.createConnection({
      id: 'sync-conn-1', serverId: server.id, taskId: 'task-sync-1',
      externalSource: 'test', externalKey: 'ext-1', externalTaskTool: 'get_task',
      status: 'disconnected', syncDirection: 'import_only', conflictPolicy: 'board_wins',
    } as any);

    const res = await fetch(`${base}/api/mcp/sync/connections/${conn.id}/sync`, { method: 'POST' });
    // The server is not connected, so a correctly-wired engine fails at the MCP
    // client layer. A stub-injected engine would instead throw a TypeError about
    // a missing repository method.
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /Sync failed/);
    assert.doesNotMatch(body.error, /is not a function/, 'engine must use real repositories, not stubs');
    assert.match(body.error, /not connected|not found/i);
  });
});
