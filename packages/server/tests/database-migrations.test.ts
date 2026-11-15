import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initPostgresDatabase, migrateSqliteDatabase } from '../src/db.js';
import { encrypt, decrypt, isEncrypted } from '../src/services/credential-encryption.js';

test('SQLite migration backfills legacy external tasks idempotently with safe deterministic snapshots', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);
    const insert = db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at,
       external_source, external_key, run_requested_at, timeout_minutes)
      VALUES (?, 'default', ?, ?, 'medium', 'backlog', 'idle', 'hermes', ?, ?, ?, ?, ?)`);
    insert.run('legacy/one "quoted"', 'Legacy "one"', 'line\ntext', 11, 'hermes', 'old-key-1', null, null);
    insert.run('legacy-two', 'Legacy two', '', 12, 'other', 'old-key-2', 99, 45);
    db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at)
      VALUES ('ordinary', 'default', 'Ordinary', '', 'medium', 'backlog', 'idle', 'hermes', 13)`).run();

    migrateSqliteDatabase(db);
    const first = db.prepare('SELECT * FROM execution_attempts ORDER BY task_id').all() as Array<Record<string, unknown>>;
    migrateSqliteDatabase(db);
    const second = db.prepare('SELECT * FROM execution_attempts ORDER BY task_id').all() as Array<Record<string, unknown>>;

    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    for (const row of first) {
      assert.match(String(row.id), /^legacy-task-[0-9a-f]+$/);
      const snapshot = JSON.parse(String(row.request_snapshot));
      assert.equal(snapshot.kind, 'legacy-task-backfill');
      assert.equal(snapshot.taskId, row.task_id);
      assert.equal(snapshot.externalSource, row.external_source);
      assert.equal(snapshot.externalKey, row.external_key);
    }
    const pending = first.find((row) => row.task_id === 'legacy/one "quoted"');
    const dispatched = first.find((row) => row.task_id === 'legacy-two');
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.auto_start, 0);
    assert.equal(dispatched?.status, 'dispatched');
    assert.equal(dispatched?.auto_start, 1);
  } finally {
    db.close();
  }
});

test('PostgreSQL migration uses an idempotent deterministic execution-attempt backfill', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  await initPostgresDatabase(pool as never);
  const backfill = calls.find((sql) => sql.includes("'legacy-task-' || encode(convert_to(t.id"));
  assert.ok(backfill);
  assert.match(backfill, /WHERE t\.external_source IS NOT NULL AND t\.external_key IS NOT NULL/);
  assert.match(backfill, /ON CONFLICT \(external_source, external_key\) DO NOTHING/);
  assert.match(backfill, /json_build_object/);
  assert.match(backfill, /CASE WHEN t\.run_requested_at IS NOT NULL THEN 'dispatched' ELSE 'pending' END/);
});

test('PostgreSQL migration tolerates only a verified duplicate-constraint startup race', async () => {
  const checks = new Map<string, number>();
  const pool = {
    query: async (sql: string) => {
      for (const name of ['tasks_project_id_fkey', 'task_groups_project_id_fkey']) {
        if (sql.includes('ADD CONSTRAINT ' + name)) {
          throw Object.assign(new Error('duplicate constraint'), { code: '42710' });
        }
        if (sql.includes('information_schema.table_constraints') && sql.includes(name)) {
          const count = (checks.get(name) ?? 0) + 1;
          checks.set(name, count);
          return { rows: count === 1 ? [] : [{ constraint_name: name }], rowCount: count === 1 ? 0 : 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await initPostgresDatabase(pool as never);
  assert.deepEqual([...checks.values()], [2, 2]);
});

test('PostgreSQL migration fails closed when a project foreign key cannot be installed', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('ADD CONSTRAINT tasks_project_id_fkey')) throw new Error('foreign key blocked');
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(initPostgresDatabase(pool as never), /foreign key blocked/);
});

test('SQLite migration re-encrypts plaintext MCP credentials', () => {
  process.env.MCP_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);

    // Insert a server with plaintext credentials
    db.prepare(`INSERT INTO mcp_servers
      (id, name, transport, command, args, url, env, cwd, headers, status, created_at, updated_at)
      VALUES (?, 'Test Server', 'stdio', 'node', '[]', null, ?, null, ?, 'disconnected', ?, ?)`)
      .run('server-1',
        JSON.stringify({ api_key: 'sk-plaintext-secret', token: 'my-token' }),
        JSON.stringify({ authorization: 'Bearer plaintext-token' }),
        Date.now(), Date.now());

    // Run migration again - should re-encrypt plaintext credentials
    migrateSqliteDatabase(db);

    const row = db.prepare('SELECT env, headers FROM mcp_servers WHERE id = ?').get('server-1') as { env: string; headers: string };
    assert.ok(isEncrypted(row.env), 'env should be encrypted after migration');
    assert.ok(isEncrypted(row.headers), 'headers should be encrypted after migration');

    // Decrypt and verify content matches original
    const decryptedEnv = JSON.parse(decrypt(row.env)!);
    assert.equal(decryptedEnv.api_key, 'sk-plaintext-secret');
    assert.equal(decryptedEnv.token, 'my-token');

    const decryptedHeaders = JSON.parse(decrypt(row.headers)!);
    assert.equal(decryptedHeaders.authorization, 'Bearer plaintext-token');

    // Idempotent: running again should not change anything
    const rowBefore = { env: row.env, headers: row.headers };
    migrateSqliteDatabase(db);
    const rowAfter = db.prepare('SELECT env, headers FROM mcp_servers WHERE id = ?').get('server-1') as { env: string; headers: string };
    assert.equal(rowAfter.env, rowBefore.env);
    assert.equal(rowAfter.headers, rowBefore.headers);
  } finally {
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
});

test('SQLite migration skips already-encrypted credentials', () => {
  process.env.MCP_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);

    // Insert a server with already-encrypted credentials
    const encryptedEnv = encrypt(JSON.stringify({ api_key: 'sk-encrypted' }));
    const encryptedHeaders = encrypt(JSON.stringify({ authorization: 'Bearer encrypted' }));

    db.prepare(`INSERT INTO mcp_servers
      (id, name, transport, command, args, url, env, cwd, headers, status, created_at, updated_at)
      VALUES (?, 'Test Server', 'stdio', 'node', '[]', null, ?, null, ?, 'disconnected', ?, ?)`)
      .run('server-2', encryptedEnv, encryptedHeaders, Date.now(), Date.now());

    const rowBefore = db.prepare('SELECT env, headers FROM mcp_servers WHERE id = ?').get('server-2') as { env: string; headers: string };

    // Run migration - should not change already-encrypted values
    migrateSqliteDatabase(db);
    const rowAfter = db.prepare('SELECT env, headers FROM mcp_servers WHERE id = ?').get('server-2') as { env: string; headers: string };
    assert.equal(rowAfter.env, rowBefore.env);
    assert.equal(rowAfter.headers, rowBefore.headers);
  } finally {
    db.close();
    delete process.env.MCP_ENCRYPTION_KEY;
  }
});

test('SQLite migration with no encryption key leaves credentials plaintext', () => {
  delete process.env.MCP_ENCRYPTION_KEY;

  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);

    db.prepare(`INSERT INTO mcp_servers
      (id, name, transport, command, args, url, env, cwd, headers, status, created_at, updated_at)
      VALUES (?, 'Test Server', 'stdio', 'node', '[]', null, ?, null, ?, 'disconnected', ?, ?)`)
      .run('server-3',
        JSON.stringify({ api_key: 'sk-plaintext' }),
        JSON.stringify({ authorization: 'Bearer plain' }),
        Date.now(), Date.now());

    migrateSqliteDatabase(db);

    const row = db.prepare('SELECT env, headers FROM mcp_servers WHERE id = ?').get('server-3') as { env: string; headers: string };
    assert.equal(isEncrypted(row.env), false, 'env should remain plaintext without encryption key');
    assert.equal(isEncrypted(row.headers), false, 'headers should remain plaintext without encryption key');
  } finally {
    db.close();
  }
});
