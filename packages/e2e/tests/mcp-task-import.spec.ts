import { test, expect, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { API } from './helpers';

/**
 * External-task import through the Task Synchronization feature.
 *
 * A deterministic stdio MCP fixture (packages/e2e/fixtures/task-mcp-server.mjs)
 * provides real discovery + tool invocation, so these tests exercise the same
 * server path as a live MCP server without depending on Stele credentials.
 */

const FIXTURE_SERVER = path.resolve(process.cwd(), 'fixtures', 'task-mcp-server.mjs');
const SERVER_NAME = `fixture-tasks-${process.env.E2E_WORKER_ID ?? 'local'}`;

type PreviewTask = {
  externalKey: string;
  title: string;
  description: string;
  status?: string;
  priority?: string;
  columnId: string;
  boardPriority: string;
  alreadyImported: boolean;
  existingTaskId?: string;
};

async function registerServer(
  request: APIRequestContext,
  name: string,
  connect: boolean,
): Promise<string> {
  const res = await request.post(`${API}/api/mcp/servers`, {
    data: {
      name,
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE_SERVER],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const server = await res.json();
  if (connect) {
    const connected = await request.post(`${API}/api/mcp/servers/${server.id}/connect`);
    expect(connected.status(), await connected.text()).toBe(200);
  }
  return server.id as string;
}

async function preview(
  request: APIRequestContext,
  body: Record<string, unknown>,
) {
  const res = await request.post(`${API}/api/mcp/sync/import/preview`, { data: body });
  return { res, body: await res.json() };
}

test.describe.configure({ mode: 'serial' });

test.describe('MCP task import', () => {
  let serverId = '';
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: API });
    serverId = await registerServer(api, SERVER_NAME, true);
  });

  test.afterAll(async () => {
    if (serverId) {
      await api.post(`${API}/api/mcp/servers/${serverId}/disconnect`).catch(() => {});
      await api.delete(`${API}/api/mcp/servers/${serverId}`).catch(() => {});
    }
    await api.dispose();
  });

  test('preview surfaces tool validation errors from required schema fields', async () => {
    const { res, body } = await preview(api, { serverId, toolName: 'list_tasks', arguments: {} });
    expect(res.status()).toBe(422);
    expect(String(body.error)).toMatch(/project is required/i);
  });

  test('preview normalizes listing records and maps status/priority safely', async () => {
    const { res, body } = await preview(api, {
      serverId,
      toolName: 'list_tasks',
      arguments: { project: 'alpha' },
    });
    expect(res.status()).toBe(200);
    expect(body.externalSource).toBe(`mcp:${SERVER_NAME}`);
    expect(body.recordLocation).toBeTruthy();

    const tasks = body.tasks as PreviewTask[];
    expect(tasks).toHaveLength(5);
    const byKey = new Map(tasks.map((task) => [task.externalKey, task]));
    expect(byKey.get('FIX-101')?.columnId).toBe('backlog');
    expect(byKey.get('FIX-101')?.boardPriority).toBe('high');
    expect(byKey.get('FIX-102')?.columnId).toBe('in-progress');
    expect(byKey.get('FIX-103')?.columnId).toBe('done');
    expect(byKey.get('FIX-103')?.boardPriority).toBe('low');
    expect(byKey.get('FIX-104')?.columnId).toBe('review');
    expect(byKey.get('FIX-104')?.boardPriority).toBe('critical');
    // Unknown external status/priority never map to done/review or a bogus priority.
    expect(byKey.get('FIX-105')?.columnId).toBe('backlog');
    expect(byKey.get('FIX-105')?.boardPriority).toBe('medium');
    for (const task of tasks) expect(task.alreadyImported).toBe(false);
  });

  test('preview reads nested envelopes and common field aliases', async () => {
    const { res, body } = await preview(api, {
      serverId,
      toolName: 'search_issues',
      arguments: { query: 'billing' },
    });
    expect(res.status()).toBe(200);
    const tasks = body.tasks as PreviewTask[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].externalKey).toBe('ISSUE-7');
    expect(tasks[0].title).toBe('Search match for billing');
    expect(tasks[0].description).toContain('data.items');
    expect(tasks[0].columnId).toBe('backlog');
    expect(tasks[0].boardPriority).toBe('high');
  });

  test('unsupported tool results produce a limitation instead of fabricated tasks', async () => {
    const { res, body } = await preview(api, {
      serverId,
      toolName: 'read_status_page',
      arguments: {},
    });
    expect(res.status()).toBe(200);
    expect(body.tasks).toEqual([]);
    expect(String(body.limitation)).toMatch(/did not return recognizable task records/i);
  });

  test('imports into an empty project, preserves external ids, and prevents duplicates', async () => {
    const projectRes = await api.post(`${API}/api/projects`, {
      data: { name: `Import Target ${Date.now()}` },
    });
    expect(projectRes.status(), await projectRes.text()).toBe(201);
    const project = await projectRes.json();

    const before = await api.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
    expect(await before.json()).toEqual([]);

    const { res: previewRes, body: previewBody } = await preview(api, {
      serverId,
      toolName: 'list_tasks',
      arguments: { project: 'alpha' },
    });
    expect(previewRes.status()).toBe(200);
    const previewTasks = previewBody.tasks as PreviewTask[];

    const importRes = await api.post(`${API}/api/mcp/sync/import`, {
      data: {
        serverId,
        projectId: project.id,
        toolName: 'list_tasks',
        externalSource: previewBody.externalSource,
        tasks: previewTasks.map((task) => ({
          externalKey: task.externalKey,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          columnId: task.columnId,
        })),
      },
    });
    expect(importRes.status(), await importRes.text()).toBe(201);
    const importBody = await importRes.json();
    expect(importBody.imported).toHaveLength(5);
    expect(importBody.skipped).toHaveLength(0);

    const tasksRes = await api.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
    const tasks = await tasksRes.json();
    expect(tasks).toHaveLength(5);
    const importedA = tasks.find((task: any) => task.externalKey === 'FIX-101');
    expect(importedA).toMatchObject({
      projectId: project.id,
      externalSource: `mcp:${SERVER_NAME}`,
      columnId: 'backlog',
      priority: 'high',
      agentStatus: 'idle',
    });
    expect(importedA.title).toBe('Fix login redirect loop');
    expect(['backlog', 'in-progress', 'review', 'done']).toContain(
      tasks.find((task: any) => task.externalKey === 'FIX-104').columnId,
    );

    const connectionsRes = await api.get(`${API}/api/mcp/sync/connections`);
    const connections = await connectionsRes.json();
    const importedConnections = connections.filter((conn: any) => conn.serverId === serverId);
    expect(importedConnections).toHaveLength(5);
    expect(importedConnections.map((conn: any) => conn.externalKey).sort()).toEqual(
      ['FIX-101', 'FIX-102', 'FIX-103', 'FIX-104', 'FIX-105'],
    );
    for (const conn of importedConnections) {
      expect(conn.externalTaskTool).toBe('list_tasks');
      expect(conn.syncDirection).toBe('import_only');
    }

    // Duplicate import is skipped, not re-created.
    const duplicateRes = await api.post(`${API}/api/mcp/sync/import`, {
      data: {
        serverId,
        projectId: project.id,
        toolName: 'list_tasks',
        externalSource: previewBody.externalSource,
        tasks: previewTasks.map((task) => ({
          externalKey: task.externalKey,
          title: task.title,
          status: task.status,
          priority: task.priority,
        })),
      },
    });
    expect(duplicateRes.status()).toBe(201);
    const duplicateBody = await duplicateRes.json();
    expect(duplicateBody.imported).toHaveLength(0);
    expect(duplicateBody.skipped).toHaveLength(5);
    for (const skipped of duplicateBody.skipped) {
      expect(skipped.reason).toBe('already_imported');
    }

    const afterDuplicate = await api.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
    expect(await afterDuplicate.json()).toHaveLength(5);

    // Preview reflects duplicates and survives a fresh request (persistence).
    const { body: refreshedPreview } = await preview(api, {
      serverId,
      toolName: 'list_tasks',
      arguments: { project: 'alpha' },
      externalSource: previewBody.externalSource,
    });
    for (const task of refreshedPreview.tasks as PreviewTask[]) {
      expect(task.alreadyImported).toBe(true);
      expect(task.existingTaskId).toBeTruthy();
    }

    // Cleanup the imported project.
    for (const task of tasks) {
      await api.delete(`${API}/api/tasks/${task.id}`).catch(() => {});
    }
    await api.delete(`${API}/api/projects/${project.id}`).catch(() => {});
  });

  test('disconnected servers produce an actionable error', async () => {
    const offlineId = await registerServer(api, `${SERVER_NAME}-offline`, false);
    try {
      const { res, body } = await preview(api, {
        serverId: offlineId,
        toolName: 'list_tasks',
        arguments: { project: 'alpha' },
      });
      expect(res.status()).toBe(409);
      expect(String(body.error)).toMatch(/not connected/i);
      expect(String(body.error)).toMatch(/Connect it/i);
    } finally {
      await api.delete(`${API}/api/mcp/servers/${offlineId}`).catch(() => {});
    }
  });

  test('existing manual task linking still works alongside import', async () => {
    const taskRes = await api.post(`${API}/api/tasks`, {
      data: { title: `Manual link ${Date.now()}`, projectId: 'default' },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    const linkRes = await api.post(`${API}/api/mcp/sync/connections`, {
      data: {
        serverId,
        taskId: task.id,
        externalSource: `manual:${SERVER_NAME}`,
        externalKey: 'MANUAL-1',
        externalTaskTool: 'list_tasks',
        syncDirection: 'import_only',
        conflictPolicy: 'board_wins',
      },
    });
    expect(linkRes.status(), await linkRes.text()).toBe(201);
    const connection = await linkRes.json();
    expect(connection.taskId).toBe(task.id);

    const listRes = await api.get(`${API}/api/mcp/sync/connections/${connection.id}`);
    expect(listRes.status()).toBe(200);
    expect((await listRes.json()).externalKey).toBe('MANUAL-1');

    await api.delete(`${API}/api/mcp/sync/connections/${connection.id}`).catch(() => {});
    await api.delete(`${API}/api/tasks/${task.id}`).catch(() => {});
  });

  test('UI: import into an empty project with validation, preview, and persistence', async ({ page }) => {
    const projectRes = await api.post(`${API}/api/projects`, {
      data: { name: `UI Import ${Date.now()}` },
    });
    expect(projectRes.status()).toBe(201);
    const project = await projectRes.json();

    try {
      await page.goto('/mcp/sync');
      await expect(page.getByRole('heading', { name: 'Task Synchronization' })).toBeVisible();
      await page.getByTestId('import-tasks-button').click();
      await expect(page.getByTestId('mcp-import-dialog')).toBeVisible();

      await page.getByTestId('import-project-select').selectOption(project.id);
      await page.getByTestId('import-server-select').selectOption(serverId);
      await expect(page.getByTestId('import-tool-select')).toHaveValue('list_tasks');

      // Required field is enforced before the tool call.
      await page.getByTestId('import-preview-button').click();
      await expect(page.getByTestId('import-error')).toHaveText('project is required');

      await page.getByTestId('import-arg-project').fill('ui-project');
      await page.getByTestId('import-preview-button').click();
      await expect(page.getByTestId('import-row-FIX-101')).toBeVisible();
      await expect(page.getByTestId('import-row-FIX-105')).toBeVisible();
      await expect(page.getByTestId('import-limitation')).toHaveCount(0);

      await page.getByTestId('import-confirm-button').click();
      await expect(page.getByTestId('import-summary')).toHaveText('Imported 5, skipped 0.');
      await expect(page.getByTestId('import-row-FIX-101')).toContainText('Already imported');

      await page.getByRole('button', { name: 'Close' }).last().click();
      await expect(page.getByTestId('mcp-import-dialog')).toHaveCount(0);

      // Persistence after reload: the connections created by import are still listed.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Task Synchronization' })).toBeVisible();
      const table = page.locator('table').first();
      await expect(table).toContainText('FIX-101');
      await expect(table).toContainText('FIX-105');

      const tasksRes = await api.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
      const tasks = await tasksRes.json();
      expect(tasks).toHaveLength(5);
      expect(tasks.every((task: any) => task.externalSource === `mcp:${SERVER_NAME}`)).toBe(true);
      expect(tasks.find((task: any) => task.externalKey === 'FIX-104').columnId).toBe('review');
    } finally {
      const tasksRes = await api.get(`${API}/api/tasks?projectId=${encodeURIComponent(project.id)}`);
      const tasks = await tasksRes.json().catch(() => []);
      for (const task of tasks) {
        await api.delete(`${API}/api/tasks/${task.id}`).catch(() => {});
      }
      await api.delete(`${API}/api/projects/${project.id}`).catch(() => {});
      const connectionsRes = await api.get(`${API}/api/mcp/sync/connections`).catch(() => null);
      if (connectionsRes?.ok()) {
        const connections = await connectionsRes.json();
        for (const conn of connections) {
          if (conn.externalSource === `mcp:${SERVER_NAME}`) {
            await api.delete(`${API}/api/mcp/sync/connections/${conn.id}`).catch(() => {});
          }
        }
      }
    }
  });
});
