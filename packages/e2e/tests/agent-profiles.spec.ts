import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, waitForBoard } from './helpers';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = API;

// Skills are discovered from AGENTBOARD_HOME/skills/<name>/SKILL.md at request time.
// The e2e server sets AGENTBOARD_HOME to packages/e2e/test-results/agentboard-home and
// recreates it per run. Seeding a skill here exercises the real discovery path (no fake
// controls) so the profile Skills selector can be verified end-to-end.
const AGENTBOARD_HOME = join(process.cwd(), 'test-results', 'agentboard-home');
function seedSkill(name: string): string {
  const dir = join(AGENTBOARD_HOME, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: E2E seeded skill\n---\n\n# ${name}\n`, 'utf8');
  return name;
}

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
  const createdServerIds: string[] = [];

  // Theme is persisted in localStorage under "theme" (read on first render).
  const setTheme = async (page: Page, theme: 'dark' | 'light') => {
    await page.addInitScript((t) => { localStorage.setItem('theme', t); }, theme);
  };

  test.afterEach(async ({ request }) => {
    for (const id of createdProfileIds.splice(0)) {
      await deleteProfileViaApi(request, id).catch(() => {});
    }
    for (const id of createdServerIds.splice(0)) {
      await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  test('shows the Agents page with executors and empty state', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agent Profiles' })).toBeVisible();
    // Executors are surfaced separately from profiles.
    await expect(page.getByText('Discovered executors')).toBeVisible();
  });

  test('New Profile modal is centered and readable in Dark Mode (P0 regression)', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New Profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Agent Profile' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500); // let the spring open-animation settle before measuring

    // P0: modal must use the themed card surface, not a hardcoded white background,
    // and must be horizontally + vertically centered.
    const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Dark card is #0c0c0e -> rgb(12, 12, 14). Assert it is a dark, not white, surface.
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const vp = page.viewportSize()!;
    // Centered within a few px on both axes.
    expect(Math.abs((box!.x + box!.width / 2) - vp.width / 2)).toBeLessThan(4);
    expect(Math.abs((box!.y + box!.height / 2) - vp.height / 2)).toBeLessThan(4);

    // Label text must be legible (not near-invisible on white): contrast color is light.
    const labelColor = await dialog.getByLabel('Name', { exact: true }).evaluate((el) => {
      const label = document.querySelector('label[for="profile-name"]')!;
      return getComputedStyle(label).color;
    });
    const [lr, lg, lb] = labelColor.match(/\d+/g)!.map(Number);
    expect(lr + lg + lb).toBeGreaterThan(180); // light text on dark surface

    await page.screenshot({ path: 'test-results/agents-modal-dark.png' });
  });

  test('New Profile modal is readable in Light Mode', async ({ page }) => {
    await setTheme(page, 'light');
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New Profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Agent Profile' });
    await expect(dialog).toBeVisible();
    const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(200); // light card surface
    await page.screenshot({ path: 'test-results/agents-modal-light.png' });
  });

  test('creates a profile with model, MCP and skills selections', async ({ page, request }) => {
    // Seed a discovered skill on the server's skills dir so it appears for selection.
    const skillName = seedSkill('e2e-review-skill');

    // Seed a real MCP server so it can be selected in the profile.
    const server = await (await request.post(`${API}/api/mcp/servers`, {
      data: { name: 'Profile Test Server', transport: 'stdio', command: 'node', args: [], env: {}, headers: {} },
    })).json();
    createdServerIds.push(server.id);

    await page.goto('/agents');
    await page.getByRole('button', { name: 'New Profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Agent Profile' });
    await dialog.getByLabel('Name', { exact: true }).fill('UI Test Profile');
    await dialog.getByLabel('Provider').selectOption('claude');
    await dialog.getByLabel('Model (optional)').fill('claude-3-haiku');
    await dialog.getByLabel('Instructions / persona (optional)').fill('Be a helpful coding assistant');

    // The seeded server must be offered for selection.
    const serverCheckbox = dialog.getByLabel(new RegExp('Profile Test Server'));
    await expect(serverCheckbox).toBeVisible();
    await serverCheckbox.check();

    // The seeded, discovered skill must be offered and selectable.
    const skillCheckbox = dialog.getByLabel(new RegExp(skillName));
    await expect(skillCheckbox).toBeVisible({ timeout: 10_000 });
    await skillCheckbox.check();

    await dialog.getByRole('button', { name: 'Create profile', exact: true }).click();
    await expect(page.getByText('UI Test Profile')).toBeVisible({ timeout: 5_000 });

    const created = await getProfilesViaApi(request);
    const found = created.find((p: any) => p.name === 'UI Test Profile');
    expect(found).toBeTruthy();
    createdProfileIds.push(found.id);
    expect(found.provider).toBe('claude');
    expect(found.model).toBe('claude-3-haiku');
    expect(found.mcpServerIds).toContain(server.id);
    expect(found.skillIds).toContain(skillName);

    // Edit the profile: add instructions, disable it, and confirm persistence.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Agent Profile' });
    await expect(editDialog).toBeVisible();
    await editDialog.getByLabel('Enabled').uncheck();
    await editDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Disabled')).toBeVisible({ timeout: 5_000 });

    const after = await getProfilesViaApi(request);
    expect(after.find((p: any) => p.id === found.id).enabled).toBe(false);
  });

  test('modal stays usable on a mobile-sized viewport (scroll + actions visible)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto('/agents');
    await page.getByRole('button', { name: 'New Profile' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Agent Profile' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    // The dialog must fit within the viewport height (it scrolls internally).
    const box = await dialog.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600 + 4);
    // Submit action remains reachable.
    await expect(dialog.getByRole('button', { name: 'Create profile', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/agents-modal-mobile.png' });
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
