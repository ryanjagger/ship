import { test, expect } from './fixtures/isolated-env'

test.describe('Issues - Bulk Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })

    // Navigate to issues
    await page.goto('/issues')

    // Switch to list view for easier testing
    await page.getByRole('button', { name: 'List view' }).click()
    await expect(page.locator('th').filter({ hasText: 'Status' })).toBeVisible({ timeout: 5000 })

    // Wait for the table to stabilize
    await page.waitForLoadState('networkidle')
  })

  test('can right-click to open context menu', async ({ page }) => {
    // Wait for at least one issue row to be visible and stable
    const row = page.locator('tbody tr').first()
    await expect(row).toBeVisible({ timeout: 10000 })

    // Wait for row to be stable before clicking
    await page.waitForTimeout(1000)

    // Right-click to open context menu
    await row.click({ button: 'right' })

    // Context menu should appear (use specific aria-label to distinguish from submenus)
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })

    // Should have archive option
    await expect(contextMenu.getByText(/archive/i)).toBeVisible()
  })

  test('can archive an issue via context menu', async ({ page }) => {
    // Create a new issue to archive (ensures we have one)
    // WCAG 2.1.4: single-char shortcut requires modifier; Shift+C creates an issue
    await page.keyboard.press('Shift+C')
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Go back to issues list
    await page.goto('/issues')
    await page.getByRole('button', { name: 'List view' }).click()
    await page.waitForLoadState('networkidle')

    // Wait for row to be stable
    await page.waitForTimeout(1000)

    // Get count before archive
    const rowsBefore = await page.locator('tbody tr').count()

    // Right-click first row
    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow).toBeVisible({ timeout: 5000 })
    await firstRow.click({ button: 'right' })

    // Click archive in context menu (use specific aria-label)
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })
    await contextMenu.getByText(/archive/i).click()

    // Wait for archive to complete - should show success toast
    await expect(page.getByText(/archived/i)).toBeVisible({ timeout: 5000 })

    // Row count should decrease
    await expect(async () => {
      const rowsAfter = await page.locator('tbody tr').count()
      expect(rowsAfter).toBeLessThan(rowsBefore)
    }).toPass({ timeout: 5000 })
  })

  test('context menu shows change status option', async ({ page }) => {
    // Wait for row to be visible and stable
    const row = page.locator('tbody tr').first()
    await expect(row).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Right-click to open context menu
    await row.click({ button: 'right' })

    // Context menu should appear with status change option (use specific aria-label)
    const contextMenu = page.getByRole('menu', { name: 'Context menu' })
    await expect(contextMenu).toBeVisible({ timeout: 3000 })

    // Look for "Change Status" option specifically
    await expect(contextMenu.getByRole('menuitem', { name: 'Change Status' })).toBeVisible()
  })
})
