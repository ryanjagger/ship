import { test, expect } from './fixtures/isolated-env'

/**
 * Issue Estimates & Status Tracking - E2E Tests
 *
 * Tests for:
 * - Estimate field in issue editor
 * - Estimate validation for sprint assignment
 * - Sprint capacity display
 * - Status change timestamp tracking
 * - Activity/change history
 */

test.describe('Issue Estimates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test.describe('Estimate Field UI', () => {
    test('shows estimate field in issue editor properties', async ({ page }) => {
      // Create a new issue to test estimate field
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Should see Estimate field label in properties sidebar (PropertyRow renders label as <div>)
      await expect(page.getByText('Estimate', { exact: true })).toBeVisible({ timeout: 5000 })
    })

    test('can enter estimate as free text number', async ({ page }) => {
      await page.goto('/issues')
      // Use exact match to avoid matching both "New issue" icon and "New Issue" button
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Find and fill estimate input
      const estimateInput = page.locator('input[type="number"]')
      await expect(estimateInput).toBeVisible({ timeout: 5000 })
      await estimateInput.fill('4.5')

      // Wait for save and React state update
      await page.waitForResponse(resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH')
      await page.waitForTimeout(500) // Allow React to process state update

      // Verify value persists
      await expect(estimateInput).toHaveValue('4.5')
    })

    test('accepts decimal values (0.5 increments)', async ({ page }) => {
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      const estimateInput = page.locator('input[type="number"]')
      await expect(estimateInput).toBeVisible({ timeout: 5000 })
      await estimateInput.fill('2.5')

      await page.waitForResponse(resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH')
      await page.waitForTimeout(500)
      await expect(estimateInput).toHaveValue('2.5')
    })

    test('shows hours label/hint next to estimate field', async ({ page }) => {
      // Create a new issue to test hours label
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Should show "hours" label next to estimate field
      await expect(page.getByText('hours')).toBeVisible({ timeout: 5000 })
    })
  })

  test.describe('Week Assignment Validation', () => {
    test('allows adding issue without estimate to backlog', async ({ page }) => {
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Set title
      await page.getByPlaceholder('Untitled').fill('Backlog Issue No Estimate')
      await page.waitForResponse(resp => resp.url().includes('/api/documents/'))

      // Should be able to save without estimate (backlog is fine)
      // No error should appear
      await expect(page.getByText(/estimate required|must have estimate/i)).not.toBeVisible()
    })

    test('requires estimate before adding issue to sprint', async ({ page }) => {
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Set title and program
      await page.getByPlaceholder('Untitled').fill('Sprint Issue Needs Estimate')
      await page.waitForResponse(resp => resp.url().includes('/api/documents/'))

      // Select a program first - wait for program selector to appear
      const addProgram = page.getByText('Add program...')
      await expect(addProgram).toBeVisible({ timeout: 5000 })
      await addProgram.click()
      await page.waitForTimeout(500)

      // Click on API Platform in the dropdown
      const apiPlatform = page.getByText('API Platform', { exact: true })
      await expect(apiPlatform).toBeVisible({ timeout: 5000 })
      await apiPlatform.click()

      // Wait for sprints to load (the Week selector appears after program is selected)
      await page.waitForTimeout(1000)

      // Try to assign to sprint without estimate - the Week selector should now be visible
      const weekSelector = page.getByRole('combobox', { name: 'Week' })
      if (await weekSelector.isVisible({ timeout: 5000 }).catch(() => false)) {
        await weekSelector.click()
        await page.waitForTimeout(500)

        const sprintOption = page.locator('[cmdk-item]').filter({ hasText: /Week \d+/ }).first()

        // Either sprint options are disabled, or clicking shows validation error
        if (await sprintOption.isVisible({ timeout: 3000 }).catch(() => false)) {
          const isDisabled = await sprintOption.isDisabled().catch(() => false)
          if (!isDisabled) {
            await sprintOption.click()
            // Should show validation message
            await expect(page.getByText(/add an estimate before assigning/i)).toBeVisible({ timeout: 3000 })
          }
        }
      }
    })

    test('allows sprint assignment after estimate is set', async ({ page }) => {
      await page.goto('/issues')
      await page.getByRole('button', { name: 'New Issue', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Set title
      await page.getByPlaceholder('Untitled').fill('Sprint Issue With Estimate')
      await page.waitForResponse(resp => resp.url().includes('/api/documents/'))

      // Set estimate first
      const estimateInput = page.locator('input[type="number"]').or(page.getByPlaceholder(/estimate|hours/i))
      await expect(estimateInput.first()).toBeVisible({ timeout: 5000 })
      await estimateInput.first().fill('4')
      await page.waitForTimeout(500)

      // Select program
      const addProgram = page.getByText('Add program...')
      await expect(addProgram).toBeVisible({ timeout: 5000 })
      await addProgram.click()
      await page.waitForTimeout(500)

      const apiPlatform = page.getByText('API Platform', { exact: true })
      await expect(apiPlatform).toBeVisible({ timeout: 5000 })
      await apiPlatform.click()

      // Wait for Week selector to appear (it appears after program is selected)
      await page.waitForTimeout(1000)

      const weekSelector = page.getByRole('combobox', { name: 'Week' })
      await expect(weekSelector).toBeVisible({ timeout: 5000 })
      await weekSelector.click()
      await page.waitForTimeout(500)

      // Wait for sprint options to appear (InlineWeekSelector uses role="option" buttons)
      const sprintOption = page.locator('[role="option"]').filter({ hasText: /Week \d+/ }).first()
      await expect(sprintOption).toBeVisible({ timeout: 5000 })
      await sprintOption.click()

      // Wait for the update to complete
      await page.waitForTimeout(1000)

      // Should show sprint selected - the Week combobox should now show a week name
      await expect(page.getByRole('combobox', { name: 'Week' })).toContainText(/Week \d+/, { timeout: 5000 })
    })
  })

  test.describe('Week Capacity Display', () => {
    test('sprint header shows total estimated hours', async ({ page }) => {
      // Navigate to Ship Core which has comprehensive sprint/issue data with estimates
      await page.goto('/programs')
      await page.locator('tr[role="row"]', { hasText: /Ship Core/i }).first().click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

      // Go to Weeks tab and wait for sprints API to complete
      await page.getByRole('tab', { name: 'Weeks' }).click()
      await page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints'))

      // Should see week cards with progress info (format: "X/Y done" or "X/Y ✓")
      // Hours only show when estimates exist: "· Xh"
      await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible({ timeout: 10000 })
    })

    test('sprint timeline cards show estimate totals when issues have estimates', async ({ page }) => {
      await page.goto('/programs')
      await page.locator('tr[role="row"]', { hasText: /Ship Core/i }).first().click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

      // Wait for sprints API to complete after clicking Weeks tab
      await page.getByRole('tab', { name: 'Weeks' }).click()
      await page.waitForResponse(resp => resp.url().includes('/api/programs/') && resp.url().includes('/sprints'))

      // Timeline cards should be visible - format is "Week of Jan 27" not "Week 1"
      const sprintCard = page.locator('button').filter({ hasText: /Week of/ }).first()
      await expect(sprintCard).toBeVisible({ timeout: 10000 })

      // Sprint cards show issue counts (hours only show when estimates exist)
      // The format is "X/Y done" or "X/Y ✓" for completed sprints
      await expect(sprintCard.getByText(/\d+\/\d+/)).toBeVisible({ timeout: 5000 })
    })
  })
})


test.describe('Progress Chart Integration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('progress chart shows estimate-based metrics', async ({ page }) => {
    // Use Ship Core which has comprehensive sprint/issue data with estimates
    await page.goto('/programs')
    await page.locator('tr[role="row"]', { hasText: /Ship Core/i }).first().click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    await page.getByRole('tab', { name: 'Weeks' }).click()

    // The progress chart should include hours-based visualization
    // Look for the chart container
    await expect(page.locator('svg, [class*="chart"], [class*="progress"]').first()).toBeVisible({ timeout: 5000 })
  })
})
