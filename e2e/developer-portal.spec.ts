import { test, expect } from './fixtures/isolated-env';

/**
 * End-to-end of the workspace-scoped Developer Portal (PRD §8) against the live
 * server: login → Developer → create app (secret shown once) → rotate → create a
 * webhook subscription (signing secret shown once) → inspect the seeded
 * dead-lettered delivery → replay it → confirm the API audit view renders.
 * dev@ship.local is the seeded super-admin (workspace-admin access).
 */
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });
}

test.describe('Developer Portal', () => {
  test('create app → secret once → rotate → create subscription', async ({ page, baseURL }) => {
    await login(page);
    await page.goto('/developer');
    await expect(page.getByTestId('developer-portal')).toBeVisible();
    await expect(page.getByTestId('dev-apps')).toBeVisible();

    // Create an app; the secret is shown exactly once.
    const appName = `Portal App ${Date.now()}`;
    await page.getByTestId('dev-new-app').click();
    await page.getByTestId('dev-app-name-input').fill(appName);
    await page.getByTestId('dev-client-type-confidential').check();
    await page.getByTestId('dev-app-redirects-input').fill(`${baseURL}/callback`);
    await page.getByTestId('dev-scope-webhooks:manage').check();
    // issue.created delivery requires the app to hold a matching read scope
    // (the webhook read-scope gate); without this the subscription is rejected.
    await page.getByTestId('dev-scope-issues:read').check();
    await page.getByTestId('dev-app-create-submit').click();

    await expect(page.getByTestId('dev-secret-modal')).toBeVisible();
    const clientId = (await page.getByTestId('dev-client-id-value').innerText()).trim();
    const secret = (await page.getByTestId('dev-secret-value').innerText()).trim();
    expect(clientId).toMatch(/^client_[0-9a-f]{32}$/);
    expect(secret).toMatch(/^secret_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('dev-secret-modal')).not.toBeVisible();

    // It appears in the list.
    const row = page.getByRole('row', { name: new RegExp(appName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(clientId);

    // Rotate → a new, different secret; client_id is stable.
    await row.getByRole('button', { name: 'Rotate secret' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Rotate secret' }).click();
    await expect(page.getByTestId('dev-secret-modal')).toBeVisible();
    const rotated = (await page.getByTestId('dev-secret-value').innerText()).trim();
    expect(rotated).toMatch(/^secret_/);
    expect(rotated).not.toBe(secret);
    await expect(page.getByTestId('dev-client-id-value')).toHaveText(clientId);
    await page.getByRole('button', { name: 'Done' }).click();

    // Create a webhook subscription for the new app; the signing secret shows once.
    await page.getByTestId('dev-tab-webhooks').click();
    await page.getByTestId('dev-app-picker').selectOption({ label: appName });
    await page.getByTestId('dev-new-subscription').click();
    await page.getByTestId('dev-sub-url-input').fill('https://example.com/hooks/portal');
    await page.getByTestId('dev-sub-events-input').fill('issue.created');
    await page.getByTestId('dev-sub-create-submit').click();
    await expect(page.getByTestId('dev-secret-modal')).toBeVisible();
    const signingSecret = (await page.getByTestId('dev-sub-secret-value').innerText()).trim();
    expect(signingSecret.length).toBeGreaterThan(10);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('dev-subscription-row')).toContainText('https://example.com/hooks/portal');
  });

  test('replay a dead-lettered delivery from the delivery log', async ({ page }) => {
    await login(page);
    await page.goto('/developer');
    await page.getByTestId('dev-tab-deliveries').click();

    // The seeded dev-owned app with a dead-lettered delivery.
    await page.getByTestId('dev-app-picker').selectOption({ label: 'Seed Webhook App' });
    await page.getByTestId('dev-delivery-status-filter').selectOption('dead_lettered');
    const deliveryRow = page.getByTestId('dev-delivery-row').first();
    await expect(deliveryRow).toBeVisible();
    await expect(deliveryRow).toContainText('dead_lettered');

    // Replay it; a success toast confirms a new delivery id.
    await deliveryRow.getByRole('button', { name: 'Replay' }).click();
    await expect(page.getByText(/Replayed — new delivery/i)).toBeVisible({ timeout: 5000 });
  });

  test('replay a delivered delivery — the original keeps its delivered status', async ({ page }) => {
    await login(page);
    await page.goto('/developer');
    await page.getByTestId('dev-tab-deliveries').click();

    // The seeded delivered delivery (same dev-owned app).
    await page.getByTestId('dev-app-picker').selectOption({ label: 'Seed Webhook App' });
    await page.getByTestId('dev-delivery-status-filter').selectOption('delivered');
    const deliveryRow = page.getByTestId('dev-delivery-row').first();
    await expect(deliveryRow).toBeVisible();
    await expect(deliveryRow).toContainText('delivered');

    // Delivered rows are replayable (e.g. to test consumer idempotency handling).
    await deliveryRow.getByRole('button', { name: 'Replay' }).click();
    await expect(page.getByText(/Replayed — new delivery/i)).toBeVisible({ timeout: 5000 });

    // The list reloads with the 'delivered' filter still applied: the original
    // keeps its delivered audit record (only the new replay row is pending).
    await expect(page.getByTestId('dev-delivery-row')).toHaveCount(1);
    await expect(page.getByTestId('dev-delivery-row').first()).toContainText('delivered');
  });

  test('Connections tab lists a live token and revokes it', async ({ page }) => {
    await login(page);
    await page.goto('/developer');
    await page.getByTestId('dev-tab-connections').click();
    await expect(page.getByTestId('dev-connections')).toBeVisible();

    // The seeded dev app holds a live access token, so it appears here.
    const row = page.getByTestId('dev-connection-row').filter({ hasText: 'Seed Webhook App' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('issues:read');

    // Revoke it; the row disappears once its only live token is killed.
    await row.getByTestId('dev-revoke-connection').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('Connection revoked')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('dev-connection-row').filter({ hasText: 'Seed Webhook App' })).toHaveCount(0);
  });

  test('API audit tab renders', async ({ page }) => {
    await login(page);
    await page.goto('/developer');
    await page.getByTestId('dev-tab-audit').click();
    await expect(page.getByTestId('dev-audit')).toBeVisible();
    // The status filter is present whether or not any calls have been recorded.
    await expect(page.getByTestId('dev-audit-status-filter')).toBeVisible();
  });
});
