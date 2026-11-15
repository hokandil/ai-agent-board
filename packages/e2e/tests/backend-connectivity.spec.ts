import { test, expect } from '@playwright/test';

/**
 * UI-08 — backend connectivity and recovery.
 *
 * Simulates a real backend outage by taking the browser context offline, then
 * asserts that the board shows an explicit "backend unavailable" state instead
 * of raw HTTP errors, and that it recovers automatically once the backend is
 * reachable again.
 */
test.describe('Backend unavailable / recovery', () => {
  test('shows a backend-unavailable state while the backend is unreachable and recovers', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveCount(0);

    // Type into the search box first: a temporary outage must not wipe out
    // what the user has already entered.
    const search = page.getByPlaceholder('Search tasks...').first();
    await search.fill('acceptance-typing');

    // Take the browser offline: REST calls and the health heartbeat fail,
    // which is what a down backend looks like from the UI.
    await context.setOffline(true);

    // The health heartbeat drives the banner into the offline state.
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('Backend unavailable');
    await expect(banner).toContainText('Reconnecting automatically');

    // Unsaved input is preserved across the outage.
    await expect(search).toHaveValue('acceptance-typing');

    // Recover: the board reconnects on its own and clears the banner.
    await context.setOffline(false);
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await expect(search).toHaveValue('acceptance-typing');
  });

  test('raw HTTP failures are not shown as raw status codes', async ({ page }) => {
    // Intercept API calls with a gateway error, the way a reverse proxy
    // reports a down upstream.
    await page.route('**/api/**', async (route) => {
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Bad Gateway' }) });
    });

    await page.goto('/');
    await page.waitForTimeout(1500);

    const body = await page.evaluate(() => document.body.innerText);
    expect(body).not.toContain('HTTP 502');
    expect(body).not.toContain('Bad Gateway');
  });
});
