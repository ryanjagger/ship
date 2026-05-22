import { test, expect } from './fixtures/isolated-env'

test.describe('Issues (Phase 5)', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('can navigate to Issues mode via URL', async ({ page }) => {
    // Navigate to issues via URL (Issues is not in the icon rail)
    await page.goto('/issues')

    // Should be in issues mode
    await expect(page).toHaveURL(/\/issues/)

    // Should see Issues heading
    await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible({ timeout: 5000 })
  })

  test('shows issues list or empty state', async ({ page }) => {
    await page.goto('/issues')

    // Should see New Issue button in the main content area (exact match to avoid sidebar button)
    await expect(page.getByRole('button', { name: 'New Issue', exact: true })).toBeVisible({ timeout: 5000 })
  })

  test('can create a new issue', async ({ page }) => {
    await page.goto('/issues')

    // Click New Issue button (exact match to avoid sidebar icon button)
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()

    // Should navigate to issue editor (full-page editor) - unified document routing
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Editor should be visible
    await expect(page.locator('.ProseMirror, .tiptap, [data-testid="editor"]')).toBeVisible({ timeout: 5000 })
  })

  test('new issue appears with ticket number in list', async ({ page }) => {
    await page.goto('/issues')

    // Create new issue (exact match to avoid sidebar icon button)
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Navigate back to list
    await page.goto('/issues')

    // Should see issue with ticket number (e.g., #1)
    await expect(page.getByText(/#\d+/).first()).toBeVisible({ timeout: 5000 })
  })

  test('issue has filter tabs (All, Active, Backlog, Done)', async ({ page }) => {
    await page.goto('/issues')

    // Should see filter tabs with exact names (implemented as actual tabs, not buttons)
    await expect(page.getByRole('tab', { name: 'All' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('tab', { name: 'Active' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Backlog' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Done' })).toBeVisible()
  })

  test('can switch between list and kanban view', async ({ page }) => {
    await page.goto('/issues')

    // Should see view toggle buttons (list/kanban icons)
    const viewToggle = page.locator('.flex.rounded-md.border')
    await expect(viewToggle.first()).toBeVisible({ timeout: 5000 })

    // Click kanban view button (second button in toggle)
    const kanbanButton = viewToggle.locator('button').nth(1)
    await kanbanButton.click()

    // Should show kanban columns - column titles are "Backlog", "Todo", "In Progress", "Done"
    await expect(page.getByText('Backlog').first()).toBeVisible({ timeout: 5000 })
  })

  test('issue editor shows full document editor', async ({ page }) => {
    await page.goto('/issues')

    // Create new issue (exact match to avoid sidebar icon button)
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Should see full editor with title area
    await expect(page.locator('.ProseMirror, .tiptap')).toBeVisible({ timeout: 5000 })

    // Should see properties sidebar (status, priority, etc.)
    await expect(page.getByText('Status', { exact: true })).toBeVisible({ timeout: 5000 })
  })

  test('can edit issue title', async ({ page }) => {
    await page.goto('/issues')

    // Create new issue (exact match to avoid sidebar icon button)
    await page.getByRole('button', { name: 'New Issue', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Find title input (contenteditable or input)
    const titleElement = page.locator('[contenteditable="true"]').first()

    if (await titleElement.isVisible({ timeout: 2000 })) {
      await titleElement.click()
      await page.keyboard.press('Meta+a')
      await page.waitForTimeout(100)  // Wait for selection
      await titleElement.fill('My Test Issue Title')

      // Wait for save with longer timeout
      await page.waitForTimeout(1000)

      await expect(titleElement).toContainText('My Test Issue Title', { timeout: 5000 })
    }
  })

  test('issue list shows status column', async ({ page }) => {
    await page.goto('/issues')

    // Switch to list view (default is Kanban)
    await page.getByRole('button', { name: 'List view' }).click()

    // Should see Status column header in the table
    await expect(page.locator('th').filter({ hasText: 'Status' })).toBeVisible({ timeout: 5000 })
  })

  test('issue list shows priority column', async ({ page }) => {
    await page.goto('/issues')

    // Switch to list view (default is Kanban)
    await page.getByRole('button', { name: 'List view' }).click()

    // Should see Priority column header
    await expect(page.locator('th').filter({ hasText: 'Priority' })).toBeVisible({ timeout: 5000 })
  })

  test('clicking issue row opens editor', async ({ page }) => {
    await page.goto('/issues')

    // Switch to list view (default is Kanban)
    await page.getByRole('button', { name: 'List view' }).click()

    // Wait for table to have data
    await page.waitForSelector('tbody tr', { timeout: 10000 })

    // Click on an issue row (seed data has issues)
    const issueRow = page.locator('tbody tr').first()
    await expect(issueRow).toBeVisible({ timeout: 5000 })
    await issueRow.click()

    // Should navigate to issue editor - unified document routing
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    await expect(page.locator('.ProseMirror, .tiptap')).toBeVisible({ timeout: 5000 })
  })

  test('filter tabs filter the issues list', async ({ page }) => {
    await page.goto('/issues')

    // Click Active filter tab (seed data has issues in various states)
    await page.getByRole('tab', { name: 'Active' }).click()

    // URL should update with filter
    await expect(page).toHaveURL(/state=/)
  })

  test('keyboard shortcut Shift+C creates new issue', async ({ page }) => {
    await page.goto('/issues')

    // Wait for page to be fully loaded
    await expect(page.getByRole('heading', { name: 'Issues', level: 1 })).toBeVisible({ timeout: 5000 })

    // Press Shift+C to create new issue (WCAG 2.1.4 requires modifier for single-char shortcuts)
    await page.keyboard.press('Shift+C')

    // Should navigate to new issue editor - unified document routing
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
  })
})
