import { test, expect } from '@playwright/test';
import { API } from './helpers';

/**
 * Regression coverage for the product-review remediation:
 *
 * - MCP duplicate registration guard (same name + same endpoint).
 * - MCP server edit (PUT) round-trip and credential redaction.
 * - Sync connection edit (PUT) plus duplicate-identity guard.
 * - Project repo-status endpoint (detected remote vs GitHub auth).
 * - validate-path reports the detected git remote.
 */

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test.describe('MCP server duplicates and editing', () => {
  test('POST /api/mcp/servers rejects an exact duplicate name+endpoint', async ({ request }) => {
    const name = uniqueName('Duplicate MCP Server');
    const payload = {
      name,
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret-value' },
    };

    const first = await request.post(`${API}/api/mcp/servers`, { data: payload });
    expect(first.status()).toBe(201);
    const created = await first.json();
    expect(created.id).toBeTruthy();

    const second = await request.post(`${API}/api/mcp/servers`, { data: payload });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.existingId).toBe(created.id);

    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(created.id)}`);
  });

  test('POST /api/mcp/servers allows the same name with a different endpoint', async ({ request }) => {
    const name = uniqueName('Distinct MCP Server');
    const first = await request.post(`${API}/api/mcp/servers`, {
      data: { name, transport: 'streamable-http', url: 'https://example.test/one' },
    });
    expect(first.status()).toBe(201);
    const firstBody = await first.json();

    const second = await request.post(`${API}/api/mcp/servers`, {
      data: { name, transport: 'streamable-http', url: 'https://example.test/two' },
    });
    expect(second.status()).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.id).not.toBe(firstBody.id);

    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(firstBody.id)}`);
    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(secondBody.id)}`);
  });

  test('PUT /api/mcp/servers/:id updates a server and never echoes credentials', async ({ request }) => {
    const name = uniqueName('Editable MCP Server');
    const created = await (await request.post(`${API}/api/mcp/servers`, {
      data: {
        name,
        transport: 'streamable-http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer super-secret' },
      },
    })).json();

    expect(created.headers.Authorization).toBe('[REDACTED]');

    const updateRes = await request.put(`${API}/api/mcp/servers/${encodeURIComponent(created.id)}`, {
      data: { name: `${name}-renamed`, url: 'https://example.test/mcp2' },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.name).toBe(`${name}-renamed`);
    expect(updated.url).toBe('https://example.test/mcp2');
    // The credential is preserved, but never returned in plaintext.
    expect(updated.headers?.Authorization).toBe('[REDACTED]');
    expect(JSON.stringify(updated)).not.toContain('super-secret');

    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(created.id)}`);
  });
});

test.describe('Sync connection editing', () => {
  test('POST then PUT a sync connection, with duplicate identity rejected', async ({ request }) => {
    const serverName = uniqueName('Sync MCP Server');
    const server = await (await request.post(`${API}/api/mcp/servers`, {
      data: { name: serverName, transport: 'streamable-http', url: 'https://example.test/mcp' },
    })).json();

    const task = await (await request.post(`${API}/api/tasks`, {
      data: {
        title: 'Sync connection task',
        description: 'sync connection regression test',
        priority: 'medium',
        columnId: 'backlog',
        agentType: 'copilot',
      },
    })).json();

    const externalKey = `EXT-${Date.now()}`;
    const createRes = await request.post(`${API}/api/mcp/sync/connections`, {
      data: {
        serverId: server.id,
        taskId: task.id,
        externalSource: 'regression',
        externalKey,
        externalTaskTool: 'list_tasks',
        syncDirection: 'bidirectional',
        conflictPolicy: 'board_wins',
      },
    });
    expect(createRes.status()).toBe(201);
    const connection = await createRes.json();
    expect(connection.syncDirection).toBe('bidirectional');

    // Editing the connection updates its policy and direction.
    const updateRes = await request.put(`${API}/api/mcp/sync/connections/${encodeURIComponent(connection.id)}`, {
      data: { syncDirection: 'import_only', conflictPolicy: 'external_wins' },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.syncDirection).toBe('import_only');
    expect(updated.conflictPolicy).toBe('external_wins');
    // The external identity is preserved.
    expect(updated.externalKey).toBe(externalKey);
    expect(updated.externalSource).toBe('regression');

    // A second connection for the same external identity is rejected.
    const task2 = await (await request.post(`${API}/api/tasks`, {
      data: {
        title: 'Sync connection task 2',
        description: 'duplicate external identity test',
        priority: 'low',
        columnId: 'backlog',
        agentType: 'copilot',
      },
    })).json();

    const dupCreate = await request.post(`${API}/api/mcp/sync/connections`, {
      data: {
        serverId: server.id,
        taskId: task2.id,
        externalSource: 'regression',
        externalKey: externalKey,
        externalTaskTool: 'list_tasks',
      },
    });
    expect(dupCreate.status()).toBe(409);

    // Updating this connection onto another connection's identity is rejected too.
    const otherKey = `${externalKey}-other`;
    const other = await (await request.post(`${API}/api/mcp/sync/connections`, {
      data: {
        serverId: server.id,
        taskId: task2.id,
        externalSource: 'regression',
        externalKey: otherKey,
        externalTaskTool: 'list_tasks',
      },
    })).json();

    const collide = await request.put(`${API}/api/mcp/sync/connections/${encodeURIComponent(other.id)}`, {
      data: { externalKey: externalKey },
    });
    expect(collide.status()).toBe(409);

    await request.delete(`${API}/api/mcp/sync/connections/${encodeURIComponent(other.id)}`);
    await request.delete(`${API}/api/mcp/sync/connections/${encodeURIComponent(connection.id)}`);
    await request.delete(`${API}/api/tasks/${encodeURIComponent(task.id)}`);
    await request.delete(`${API}/api/tasks/${encodeURIComponent(task2.id)}`);
    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(server.id)}`);
  });
});

test.describe('Project repository status', () => {
  test('GET /api/projects/repo-status reports repo facts and GitHub auth separately', async ({ request }) => {
    const res = await request.get(`${API}/api/projects/repo-status`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(typeof body.statuses).toBe('object');
    expect(body.github).toBeTruthy();
    expect(typeof body.github.authenticated).toBe('boolean');
    expect(typeof body.github.cliAvailable).toBe('boolean');

    for (const status of Object.values<Record<string, unknown>>(body.statuses as Record<string, Record<string, unknown>>)) {
      expect(typeof status.isGitRepo).toBe('boolean');
      expect(typeof status.isGitHubRemote).toBe('boolean');
    }
  });

  test('POST /api/projects/validate-path reports the detected git remote', async ({ request }) => {
    const res = await request.post(`${API}/api/projects/validate-path`, {
      data: { repoPath: process.cwd() },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.isGitRepo).toBe('boolean');
    if (body.isGitRepo) {
      expect(typeof body.remoteUrl === 'string' || body.remoteUrl === undefined).toBe(true);
      expect(typeof body.isGitHubRemote === 'boolean' || body.isGitHubRemote === undefined).toBe(true);
    }
  });
});

test.describe('GitHub auth status', () => {
  test('GET /api/github/status returns the CLI authentication state', async ({ request }) => {
    const res = await request.get(`${API}/api/github/status`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.cliAvailable).toBe('boolean');
    expect(typeof body.authenticated).toBe('boolean');
    expect(body.login === null || typeof body.login === 'string').toBe(true);
  });
});
