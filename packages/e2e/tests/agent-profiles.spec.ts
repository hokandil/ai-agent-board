import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, waitForBoard } from './helpers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Skills are discovered from AGENTBOARD_HOME/skills/<name>/SKILL.md at request time.
// Seeding a skill exercises the real discovery path (no fake controls).
const AGENTBOARD_HOME = join(process.cwd(), 'test-results', 'agentboard-home');
function seedSkill(name: string): string {
  const dir = join(AGENTBOARD_HOME, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: E2E seeded skill\n---\n\n# ${name}\n`, 'utf8');
  return name;
}

const setTheme = async (page: Page, theme: 'dark' | 'light') => {
  await page.addInitScript((t) => { localStorage.setItem('theme', t); }, theme);
};

async function saveAgentConfig(request: APIRequestContext, provider: string, data: any) {
  const res = await request.put(`${API}/api/agents/${provider}/config`, { data });
  expect(res.status()).toBe(200);
  return await res.json();
}

async function getManagedAgents(request: APIRequestContext) {
  const res = await request.get(`${API}/api/agents/manage`);
  expect(res.status()).toBe(200);
  return await res.json();
}

test.describe('Agents management API', () => {
  test('GET /api/agents/manage lists every supported executor with capabilities + config', async ({ request }) => {
    const list = await getManagedAgents(request);
    expect(Array.isArray(list)).toBe(true);
    const byProvider = Object.fromEntries(list.map((a: any) => [a.provider, a]));
    // Every supported adapter is present — we manage installed executors, not arbitrary profiles.
    for (const p of ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok']) {
      expect(byProvider[p]).toBeTruthy();
      expect(byProvider[p].capabilities).toBeTruthy();
    }
  });

  test('capability matrix reflects real per-provider limitations', async ({ request }) => {
    const list = await getManagedAgents(request);
    const byProvider = Object.fromEntries(list.map((a: any) => [a.provider, a]));
    // Codex: model delivered per session, but no MCP/skills delivery.
    expect(byProvider.codex.capabilities.model).toBe('session');
    expect(byProvider.codex.capabilities.mcp).toBe(false);
    expect(byProvider.codex.capabilities.skills).toBe(false);
    // OpenCode: model fixed at construction (startup), not per-run.
    expect(byProvider.opencode.capabilities.model).toBe('startup');
    // Hermes/OpenClaw read model from their own config (native), but DO accept a command path.
    expect(byProvider.hermes.capabilities.model).toBe('native');
    expect(byProvider.hermes.capabilities.commandConfigurable).toBe(true);
    // Copilot/Claude have no configurable command path.
    expect(byProvider.copilot.capabilities.commandConfigurable).toBe(false);
  });

  test('PUT config for Codex persists model + instructions (configure an agent detection may miss)', async ({ request }) => {
    const saved = await saveAgentConfig(request, 'codex', { model: 'gpt-5-codex', instructions: 'Prefer functional style.', enabled: true });
    expect(saved.provider).toBe('codex');
    expect(saved.config.model).toBe('gpt-5-codex');
    expect(saved.config.instructions).toBe('Prefer functional style.');

    const list = await getManagedAgents(request);
    const codex = list.find((a: any) => a.provider === 'codex');
    expect(codex.config.model).toBe('gpt-5-codex');

    // OpenCode can likewise be saved even though startup may not have it on PATH.
    const oc = await saveAgentConfig(request, 'opencode', { model: 'anthropic/claude-sonnet-4', enabled: true });
    expect(oc.config.model).toBe('anthropic/claude-sonnet-4');
  });

  test('one saved config per provider (upsert, not multiple personas)', async ({ request }) => {
    await saveAgentConfig(request, 'claude', { model: 'first', enabled: true });
    await saveAgentConfig(request, 'claude', { model: 'second', enabled: true });
    const list = await getManagedAgents(request);
    const claude = list.find((a: any) => a.provider === 'claude');
    expect(claude.config.model).toBe('second');
    // Only one enabled config row for claude.
    const profiles = await (await request.get(`${API}/api/agent-profiles`)).json();
    const claudeRows = profiles.filter((p: any) => p.provider === 'claude' && p.enabled);
    expect(claudeRows.length).toBe(1);
  });

  test('detection failure is reported, not hidden', async ({ request }) => {
    const list = await getManagedAgents(request);
    // In the test environment real agents are unavailable; each must still appear with a
    // diagnosis (available flag + reason) rather than being silently omitted.
    const codex = list.find((a: any) => a.provider === 'codex');
    expect(codex.detection).not.toBeNull();
    expect(typeof codex.detection.available).toBe('boolean');
    if (!codex.detection.available) expect(codex.detection.reason).toBeTruthy();
  });
});

test.describe('Agents page UI', () => {
  const setEnabledCleanups: string[] = [];

  test.afterEach(async ({ request }) => {
    // Reset any executor we toggled so other tests see a clean baseline.
    for (const provider of setEnabledCleanups.splice(0)) {
      await request.put(`${API}/api/agents/${provider}/config`, { data: { enabled: true, model: null, instructions: null, command: null, mcpServerIds: [], skillIds: [] } }).catch(() => {});
    }
  });

  test('renders executor cards with a Configure action', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-scan executors' })).toBeVisible();
    // Each supported executor is listed.
    await expect(page.getByText('OpenAI Codex', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('OpenCode', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Configure/ }).first()).toBeVisible();
  });

  test('Configure modal is centered and readable in Dark (theming regression)', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Configure' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);

    const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r).toBeLessThan(60); expect(g).toBeLessThan(60); expect(b).toBeLessThan(60); // dark card, not white

    const box = await dialog.boundingBox();
    const vp = page.viewportSize()!;
    expect(Math.abs((box!.x + box!.width / 2) - vp.width / 2)).toBeLessThan(6);
    expect(Math.abs((box!.y + box!.height / 2) - vp.height / 2)).toBeLessThan(6);
    await page.screenshot({ path: 'test-results/agents-configure-dark.png' });
  });

  test('Configure modal is readable in Light Mode', async ({ page }) => {
    await setTheme(page, 'light');
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Configure' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    const lightBg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [lr] = lightBg.match(/\d+/g)!.map(Number);
    expect(lr).toBeGreaterThan(200);
    await page.screenshot({ path: 'test-results/agents-configure-light.png' });
  });

  test('MCP + Skills + command controls are capability-gated per provider', async ({ page, request }) => {
    const skillName = seedSkill('e2e-agents-skill');
    const server = await (await request.post(`${API}/api/mcp/servers`, {
      data: { name: 'Agents Test Server', transport: 'stdio', command: 'node', args: [], env: {}, headers: {} },
    })).json();

    await page.goto('/agents');

    // Copilot supports MCP + Skills, no command path.
    await page.getByRole('button', { name: 'Configure' }).first().click(); // Copilot is first
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText('MCP servers', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Skills', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Executable / command path')).toHaveCount(0);
    // Select the seeded server + skill
    await dialog.getByLabel(new RegExp('Agents Test Server')).check();
    await dialog.getByLabel(new RegExp(skillName)).check();
    await dialog.getByLabel('Model').fill('claude-3-5-sonnet');
    await dialog.getByRole('button', { name: 'Save configuration' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5_000 });

    const copilot = (await getManagedAgents(request)).find((a: any) => a.provider === 'copilot');
    expect(copilot.config.mcpServerIds).toContain(server.id);
    expect(copilot.config.skillIds).toContain(skillName);
    expect(copilot.config.model).toBe('claude-3-5-sonnet');

    // Codex supports neither MCP nor Skills (reported limitation, no fake controls).
    await page.getByRole('button', { name: 'Configure' }).nth(2).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Configure OpenAI Codex');
    await expect(dialog.getByText('MCP servers', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Skills', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(server.id)}`).catch(() => {});
    setEnabledCleanups.push('copilot');
  });

  test('model is disabled with explanation for native-model providers', async ({ page }) => {
    await page.goto('/agents');
    // Hermes is provider index 4 (copilot, claude, codex, opencode, hermes).
    await page.getByRole('button', { name: 'Configure' }).nth(4).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Configure Hermes');
    await expect(dialog.getByLabel('Model')).toBeDisabled();
    // Hermes DOES support a command path.
    await expect(dialog.getByLabel('Executable / command path')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('mobile viewport keeps the dialog usable with actions reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Configure' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    const box = await dialog.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600 + 6);
    await expect(dialog.getByRole('button', { name: 'Save configuration' })).toBeVisible();
    await page.screenshot({ path: 'test-results/agents-configure-mobile.png' });
  });
});

test.describe('Task creation has exactly one Agent selector', () => {
  test('no separate Agent Profile control; a single Agent selector drives selection', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
    await page.getByRole('button', { name: 'New Task', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Requirement: exactly ONE agent selection, no contradictory Agent/Profile pair.
    await expect(dialog.getByText('Agent Profile')).toHaveCount(0);
    await expect(dialog.getByText('Select profile', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('No profiles available')).toHaveCount(0);
    // The single Agent selector is present.
    await expect(dialog.getByText('Agent', { exact: true })).toBeVisible();
  });
});

test.describe('Existing task+profile compatibility (legacy agentProfileId path)', () => {
  const createdProfileIds: string[] = [];
  const createdTaskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds.splice(0)) await request.delete(`${API}/api/tasks/${id}`).catch(() => {});
    for (const id of createdProfileIds.splice(0)) await request.delete(`${API}/api/agent-profiles/${id}`).catch(() => {});
  });

  test('a task created with an explicit agentProfileId still snapshots it', async ({ request }) => {
    const profile = await (await request.post(`${API}/api/agent-profiles`, {
      data: { name: 'Legacy Profile', provider: 'copilot', model: 'gpt-4o', mcpServerIds: [], skillIds: [], enabled: true },
    })).json();
    createdProfileIds.push(profile.id);

    const created = await request.post(`${API}/api/tasks`, {
      data: { title: 'Legacy Profile Task', priority: 'medium', columnId: 'backlog', agentType: 'copilot', agentProfileId: profile.id, repoPath: process.cwd() },
    });
    expect(created.status()).toBe(201);
    const task = await created.json();
    createdTaskIds.push(task.id);

    expect(task.agentProfileId).toBe(profile.id);
    expect(task.agentProfileSnapshot?.name).toBe('Legacy Profile');
  });
});
