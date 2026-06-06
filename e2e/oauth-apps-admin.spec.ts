import { test, expect } from './fixtures/isolated-env';

/**
 * End-to-end of the super-admin all-apps lens in the Developer Portal against
 * the live server. Drives legacy admin link redirect → Developer → All apps →
 * create an app (secret shown once) → see it listed → rotate the secret → delete
 * it. dev@ship.local is the seeded super-admin, matching the other OAuth specs.
 */
test.describe('Developer Portal · all OAuth apps management UI', () => {
  test('create → reveal secret once → list → rotate → delete', async ({ page, baseURL }) => {
    // 1) Log in as the seeded super-admin.
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    // 2) The old admin OAuth Apps tab redirects to the Developer Portal all-apps lens.
    await page.goto('/admin?tab=oauth-apps');
    await expect(page).toHaveURL(/\/developer\?tab=apps&scope=all/);
    await expect(page.getByTestId('developer-portal')).toBeVisible();
    await expect(page.getByTestId('dev-apps')).toBeVisible();
    await expect(page.getByTestId('dev-app-scope-all')).toBeVisible();

    // 3) Create a new app with documents:read.
    const appName = `E2E UI App ${Date.now()}`;
    await page.getByTestId('dev-new-app').click();
    await page.getByTestId('dev-app-name-input').fill(appName);
    await page.getByTestId('dev-client-type-confidential').check();
    await page.getByTestId('dev-app-redirects-input').fill(`${baseURL}/callback`);
    await page.getByTestId('dev-scope-documents:read').check();
    await page.getByTestId('dev-app-create-submit').click();

    // 4) The credentials are revealed exactly once.
    const modal = page.getByTestId('dev-secret-modal');
    await expect(modal).toBeVisible();
    const clientId = (await page.getByTestId('dev-client-id-value').innerText()).trim();
    const clientSecret = (await page.getByTestId('dev-secret-value').innerText()).trim();
    expect(clientId).toMatch(/^client_[0-9a-f]{32}$/);
    expect(clientSecret).toMatch(/^secret_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(modal).not.toBeVisible();

    // 5) The app appears in the list with its client_id and scope.
    const row = page.getByRole('row', { name: new RegExp(appName) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(clientId);
    await expect(row).toContainText('documents:read');

    // 6) Rotate the secret → confirm → a new, different secret is shown; client_id is stable.
    await row.getByRole('button', { name: 'Rotate secret' }).click();
    const rotateDialog = page.getByRole('dialog');
    await expect(rotateDialog).toBeVisible();
    await rotateDialog.getByRole('button', { name: 'Rotate secret' }).click();

    await expect(modal).toBeVisible();
    const rotatedSecret = (await page.getByTestId('dev-secret-value').innerText()).trim();
    expect(rotatedSecret).toMatch(/^secret_/);
    expect(rotatedSecret).not.toBe(clientSecret);
    await expect(page.getByTestId('dev-client-id-value')).toHaveText(clientId);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(modal).not.toBeVisible();

    // 7) Delete → confirm (destructive) → the row is gone.
    await page.getByRole('row', { name: new RegExp(appName) }).getByRole('button', { name: 'Delete' }).click();
    const deleteDialog = page.getByRole('dialog');
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByRole('row', { name: new RegExp(appName) })).toHaveCount(0);
  });

  test('system client (Ship CLI) is read-only — no rotate or delete', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    await page.goto('/developer?tab=apps&scope=all');
    await expect(page.getByTestId('dev-apps')).toBeVisible();

    // The platform-managed Ship CLI client is listed but locked down.
    const cliRow = page.getByRole('row', { name: /Ship CLI/ });
    await expect(cliRow).toBeVisible();
    await expect(cliRow).toContainText('client_ship_cli');
    await expect(cliRow.getByTestId('dev-app-system-managed')).toBeVisible();
    await expect(cliRow.getByRole('button', { name: 'Rotate secret' })).toHaveCount(0);
    await expect(cliRow.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('rejects a confidential client with no redirect URI', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    await page.goto('/developer?tab=apps&scope=all');
    await expect(page.getByTestId('dev-apps')).toBeVisible();

    await page.getByTestId('dev-new-app').click();
    await page.getByTestId('dev-app-name-input').fill('No Redirect App');
    // Leave redirect URIs empty and do NOT enable device flow → client-side guard.
    await page.getByTestId('dev-app-create-submit').click();

    await expect(page.getByText(/At least one redirect URI is required/i)).toBeVisible();
    await expect(page.getByTestId('dev-secret-modal')).not.toBeVisible();
  });
});
