import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createMcpRouter } from '../src/routes/mcp.js';
import { MCP_CREDENTIAL_CLEAR } from '@ai-agent-board/shared/constants.js';
import { credentialService } from '../src/services/credential-service.js';

function makeAgentManager() {
  return { getAvailableAgents: () => [] } as unknown as { getAvailableAgents: () => never[] };
}

function makeAuditLogger() {
  return {
    log: async () => {},
    logMcpEvent: async () => {},
  } as unknown as { log: () => Promise<void>; logMcpEvent: () => Promise<void> };
}

/** Boot an Express app mounting the MCP router over an in-memory SQLite DB. */
async function withMcpApi(
  run: (base: string, db: Database.Database) => Promise<void>,
): Promise<void> {
  process.env.MCP_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    const app = express();
    app.use(express.json());
    app.use('/api/mcp', createMcpRouter(repo, makeAgentManager(), makeAuditLogger()));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    try {
      await run(`http://127.0.0.1:${address.port}`, db);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
}

/** Read the stored (encrypted-at-rest) env for a server and decrypt it. */
function readStoredEnv(db: Database.Database, id: string): Record<string, string> {
  const row = db.prepare('SELECT env FROM mcp_servers WHERE id = ?').get(id) as
    | { env: string }
    | undefined;
  assert.ok(row, `server row ${id} should exist`);
  const raw = row.env!;
  assert.ok(credentialService.isValueEncrypted(raw), 'env should be encrypted at rest');
  const decrypted = credentialService.decryptCredentials(raw);
  assert.ok(decrypted, 'env should decrypt to the original credential map');
  return decrypted;
}

function jsonBody(value: unknown) {
  return { method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

test('mcp update preserves stored credentials on a non-secret edit', async () => {
  await withMcpApi(async (base, db) => {
    const create = await fetch(`${base}/api/mcp/servers`, {
      ...jsonBody({ name: 'Secret Server', transport: 'stdio', command: 'node', args: [], env: { api_key: 'sk-live-secret', token: 'my-token' } }),
    });
    assert.equal(create.status, 201, 'create should succeed');
    const created = (await create.json()) as { id: string; env: Record<string, string> };
    // Credentials are redacted in REST responses (never leaked to the client).
    assert.equal(created.env.api_key, '[REDACTED]');

    const before = readStoredEnv(db, created.id);
    assert.equal(before.api_key, 'sk-live-secret');
    assert.equal(before.token, 'my-token');

    // A non-secret edit (rename only, env not sent) must not touch the secret.
    const rename = await fetch(`${base}/api/mcp/servers/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Server' }),
    });
    assert.equal(rename.status, 200, 'rename should succeed');

    const after = readStoredEnv(db, created.id);
    assert.equal(after.api_key, 'sk-live-secret', 'stored api_key must be preserved');
    assert.equal(after.token, 'my-token', 'stored token must be preserved');
  });
});

test('mcp update with empty credential values keeps the stored secret (no wipe)', async () => {
  await withMcpApi(async (base, db) => {
    const create = await fetch(`${base}/api/mcp/servers`, {
      ...jsonBody({ name: 'S', transport: 'stdio', command: 'node', args: [], env: { api_key: 'sk-live-secret' } }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { id: string };

    // Sending an empty env map means "no changes" — the stored secret stays.
    const update = await fetch(`${base}/api/mcp/servers/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: {} }),
    });
    assert.equal(update.status, 200, 'empty-value update should succeed');

    const after = readStoredEnv(db, created.id);
    assert.equal(after.api_key, 'sk-live-secret', 'stored api_key must not be wiped by empty values');
  });
});

test('mcp explicit clear marker removes the credential while keeping others', async () => {
  await withMcpApi(async (base, db) => {
    const create = await fetch(`${base}/api/mcp/servers`, {
      ...jsonBody({ name: 'S', transport: 'stdio', command: 'node', args: [], env: { api_key: 'sk-live-secret', other: 'keep-me' } }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { id: string };

    const update = await fetch(`${base}/api/mcp/servers/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { api_key: MCP_CREDENTIAL_CLEAR } }),
    });
    assert.equal(update.status, 200, 'clear-marker update should succeed');

    const after = readStoredEnv(db, created.id);
    assert.equal(after.api_key, undefined, 'cleared credential must be removed');
    assert.equal(after.other, 'keep-me', 'non-cleared credential must be preserved');
  });
});

test('mcp create drops empty credential values', async () => {
  await withMcpApi(async (base, db) => {
    const create = await fetch(`${base}/api/mcp/servers`, {
      ...jsonBody({ name: 'S', transport: 'stdio', command: 'node', args: [], env: { api_key: '', real: 'value' } }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { id: string };

    const stored = readStoredEnv(db, created.id);
    assert.equal(stored.api_key, undefined, 'empty value must be dropped on create');
    assert.equal(stored.real, 'value', 'non-empty value must be stored on create');
  });
});
