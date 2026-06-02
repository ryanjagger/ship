import { test, expect } from './fixtures/isolated-env';

/**
 * End-to-end of the admin "OAuth Apps" management UI (PRD §5.2) against the live
 * server. Drives login → Admin Dashboard → OAuth Apps tab → create an app (secret
 * shown once) → see it listed → rotate the secret → delete it. dev@ship.local is
 * the seeded super-admin, matching the other OAuth specs.
 */
test.describe('Admin OAuth Apps management UI', () => {
  test('create → reveal secret once → list → rotate → delete', async ({ page, baseURL }) => {
    // 1) Log in as the seeded super-admin.
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    // 2) Open the OAuth Apps admin tab.
    await page.goto('/admin?tab=oauth-apps');
    await expect(page.getByTestId('oauth-apps-tab')).toBeVisible();

    // 3) Create a new app with documents:read.
    const appName = `E2E UI App ${Date.now()}`;
    await page.getByRole('button', { name: 'New OAuth App' }).click();
    await page.getByTestId('oauth-app-name-input').fill(appName);
    await page.getByTestId('oauth-app-redirects-input').fill(`${baseURL}/callback`);
    await page.getByTestId('oauth-scope-documents:read').check();
    await page.getByTestId('oauth-app-create-submit').click();

    // 4) The credentials are revealed exactly once.
    const modal = page.getByTestId('oauth-secret-modal');
    await expect(modal).toBeVisible();
    const clientId = (await page.getByTestId('oauth-client-id-value').innerText()).trim();
    const clientSecret = (await page.getByTestId('oauth-secret-value').innerText()).trim();
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
    const rotatedSecret = (await page.getByTestId('oauth-secret-value').innerText()).trim();
    expect(rotatedSecret).toMatch(/^secret_/);
    expect(rotatedSecret).not.toBe(clientSecret);
    await expect(page.getByTestId('oauth-client-id-value')).toHaveText(clientId);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(modal).not.toBeVisible();

    // 7) Delete → confirm (destructive) → the row is gone.
    await page.getByRole('row', { name: new RegExp(appName) }).getByRole('button', { name: 'Delete' }).click();
    const deleteDialog = page.getByRole('dialog');
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByRole('row', { name: new RegExp(appName) })).toHaveCount(0);
  });

  test('rejects a confidential client with no redirect URI', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5000 });

    await page.goto('/admin?tab=oauth-apps');
    await expect(page.getByTestId('oauth-apps-tab')).toBeVisible();

    await page.getByRole('button', { name: 'New OAuth App' }).click();
    await page.getByTestId('oauth-app-name-input').fill('No Redirect App');
    // Leave redirect URIs empty and do NOT enable device flow → client-side guard.
    await page.getByTestId('oauth-app-create-submit').click();

    await expect(page.getByText(/At least one redirect URI is required/i)).toBeVisible();
    await expect(page.getByTestId('oauth-secret-modal')).not.toBeVisible();
  });
});
