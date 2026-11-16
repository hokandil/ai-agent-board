import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, waitForBoard } from './helpers';

const BASE = API;

async function createProfileViaApi(request: APIRequestContext, profile: any) {
  const res = await request.post(`${BASE}/api/agent-profiles`, { data: profile });
  expect(res.status()).toBe(201);
  return await res.json();
}

async function getProfilesViaApi(request: APIRequestContext) {
  const res = await request.get(`${BASE}/api/agent-profiles`);
  expect(res.status()).toBe(200);
  return await res.json();
}

async function deleteProfileViaApi(request: APIRequestContext, id: string) {
  const res = await request.delete(`${BASE}/api/agent-profiles/${id}`);
  expect(res.status()).toBe(204);
}

test.describe('Agent Profiles API - E2E', () => {
  const createdProfileIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdProfileIds.splice(0)) {
      await deleteProfileViaApi(request, id).catch(() => {});
    }
  });

  test('GET /api/agent-profiles returns list', async ({ request }) => {
    const profiles = await getProfilesViaApi(request);
    expect(Array.isArray(profiles)).toBe(true);
  });

  test('POST /api/agent-profiles creates a profile', async ({ request }) => {
    const profile = await createProfileViaApi(request, {
      name: 'Test Profile',
      provider: 'copilot',
      model: 'claude-3-sonnet',
      instructions: 'Be helpful and concise',
      mcpServerIds: [],
      skillIds: [],
      enabled: true,
    });
    createdProfileIds.push(profile.id);
    expect(profile.name).toBe('Test Profile');
    expect(profile.provider).toBe('copilot');
    expect(profile.model).toBe('claude-3-sonnet');
    expect(profile.instructions).toBe('Be helpful and concise');
    expect(profile.enabled).toBe(true);
    const profiles = await getProfilesViaApi(request);
    expect(profiles.find((p: any) => p.id === profile.id)).toBeTruthy();
  });

  test('PATCH /api/agent-profiles/:id updates a profile', async ({ request }) => {
    const profile = await createProfileViaApi(request, {
      name: 'Original Name',
      provider: 'copilot',
      instructions: 'Original instructions',
      mcpServerIds: [],
      skillIds: [],
      enabled: true,
    });
    createdProfileIds.push(profile.id);

    const updated = await request.patch(`${API}/api/agent-profiles/${profile.id}`, {
      data: { name: 'Updated Name', instructions: 'Updated instructions' },
    });
    expect(updated.status()).toBe(200);
    const body = await updated.json();
    expect(body.name).toBe('Updated Name');
    expect(body.instructions).toBe('Updated instructions');
    expect(body.provider).toBe('copilot');
  });

  test('DELETE /api/agent-profiles/:id deletes a profile', async ({ request }) => {
    const profile = await createProfileViaApi(request, {
      name: 'To Delete',
      provider: 'claude',
      mcpServerIds: [],
      skillIds: [],
      enabled: true,
    });
    await deleteProfileViaApi(request, profile.id);
    const profiles = await getProfilesViaApi(request);
    expect(profiles.find((p: any) => p.id === profile.id)).toBeUndefined();
  });

  test('rejects invalid provider', async ({ request }) => {
    const res = await request.post(`${BASE}/api/agent-profiles`, {
      data: { name: 'Bad', provider: 'not-a-real-provider', mcpServerIds: [], skillIds: [] },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe('Agents page UI', () => {
  const createdProfileIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdProfileIds.splice(0)) {
      await deleteProfileViaApi(request, id).catch(() => {});
    }
  });

  test('shows the Agents page', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agent Profiles' })).toBeVisible();
  });

  test('creates a profile via UI', async ({ page, request }) => {
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New Profile' }).click();
    await expect(page.getByRole('heading', { name: 'New agent profile' })).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('UI Test Profile');
    await page.getByLabel('Provider').selectOption('claude');
    await page.getByLabel('Model (optional)').fill('claude-3-haiku');
    await page.getByLabel('Instructions / persona (optional)').fill('Be a helpful coding assistant');

    await page.getByRole('button', { name: 'Create profile' }).click();
    await expect(page.getByText('UI Test Profile')).toBeVisible({ timeout: 5_000 });

    const created = await getProfilesViaApi(request);
    const found = created.find((p: any) => p.name === 'UI Test Profile');
    if (found) createdProfileIds.push(found.id);
  });
});

test.describe('Task assignment with profile', () => {
  const createdProfileIds: string[] = [];
  const createdTaskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds.splice(0)) {
      await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    }
    for (const id of createdProfileIds.splice(0)) {
      await deleteProfileViaApi(request, id).catch(() => {});
    }
  });

  test('creates a task via API with agentProfileId', async ({ page, request }) => {
    const profile = await createProfileViaApi(request, {
      name: 'API Task Profile',
      provider: 'copilot',
      model: 'gpt-4o',
      instructions: 'Follow strict typing',
      mcpServerIds: [],
      skillIds: [],
      enabled: true,
    });
    createdProfileIds.push(profile.id);

    await page.goto('/');
    await waitForBoard(page);

    const created = await request.post(`${API}/api/tasks`, {
      data: {
        title: 'API Task Profile Task',
        description: 'verify profile assignment',
        priority: 'medium',
        agentType: 'copilot',
        agentProfileId: profile.id,
        repoPath: process.cwd(),
      },
    });
    expect(created.status()).toBe(201);
    const task = await created.json();
    createdTaskIds.push(task.id);

    expect(task.agentProfileId).toBe(profile.id);
    expect(task.agentProfileSnapshot).toBeTruthy();
    expect(task.agentProfileSnapshot.name).toBe('API Task Profile');
    expect(task.agentProfileSnapshot.provider).toBe('copilot');
  });
});
