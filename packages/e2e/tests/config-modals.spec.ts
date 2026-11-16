import { test, expect, type Page } from '@playwright/test';
import { API } from './helpers';

/**
 * Regression tests for the P1 modal-positioning defects (Add/Edit MCP Server,
 * Add Sync Connection). Previously these dialogs used in-flow `relative`
 * positioning, so they rendered against the top-left of the viewport instead of
 * centered over the fixed backdrop. They must now be horizontally + vertically
 * centered and, on short viewports, fit within it (the body scrolls internally)
 * with the primary actions reachable.
 */

const setTheme = async (page: Page, theme: 'dark' | 'light') => {
  await page.addInitScript((t) => { localStorage.setItem('theme', t); }, theme);
};

async function expectCentered(dialog: import('@playwright/test').Locator, vp: { width: number; height: number }) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs((box!.x + box!.width / 2) - vp.width / 2)).toBeLessThan(6);
  expect(Math.abs((box!.y + box!.height / 2) - vp.height / 2)).toBeLessThan(6);
}

test.describe('MCP server dialogs', () => {
  const serverIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of serverIds.splice(0)) {
      await request.delete(`${API}/api/mcp/servers/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  test('Add MCP Server dialog is centered (not top-left)', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/mcp');
    await page.getByRole('button', { name: 'Add Server' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP Server' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    await expectCentered(dialog, page.viewportSize()!);
    await page.screenshot({ path: 'test-results/mcp-server-modal-dark.png' });
  });

  test('Add MCP Server dialog fits a short viewport with visible actions', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.setViewportSize({ width: 420, height: 560 });
    await page.goto('/mcp');
    await page.getByRole('button', { name: 'Add Server' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add MCP Server' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    const box = await dialog.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(560 + 6);
    await expect(dialog.getByRole('button', { name: 'Add Server' }).last()).toBeVisible();
  });
});

test.describe('Sync connection dialogs', () => {
  test('Add Sync Connection dialog is centered and offers task selection', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.goto('/mcp/sync');
    await page.getByRole('button', { name: 'Add Connection' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Sync Connection' });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(500);
    await expectCentered(dialog, page.viewportSize()!);
    // Simplified form: Board task is now a selectable object, not a forced id field.
    await expect(dialog.getByText('Board Task', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/mcp-sync-modal-dark.png' });
  });
});
