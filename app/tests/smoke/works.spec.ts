/**
 * Works module smoke tests.
 * Verifies: page load, tab navigation, works order create round-trip,
 * Section 20 tab navigation.
 * Hits real Supabase — no mocks.
 */
import { test, expect } from '@playwright/test'

test.describe('Works page', () => {
  test('page loads with correct heading', async ({ page }) => {
    await page.goto('/works')
    await expect(page.getByRole('main').getByRole('heading', { name: 'Works' })).toBeVisible()
  })

  test('both tabs are present and switchable', async ({ page }) => {
    await page.goto('/works')
    await expect(page.getByRole('button', { name: 'Works Orders' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Section 20' })).toBeVisible()

    // Switch to Section 20 tab
    await page.getByRole('button', { name: 'Section 20' }).click()
    await expect(page.getByRole('button', { name: 'New consultation' })).toBeVisible()

    // Switch back
    await page.getByRole('button', { name: 'Works Orders' }).click()
    await expect(page.getByRole('button', { name: 'New order' })).toBeVisible()
  })

  test('create works order round-trip', async ({ page }) => {
    const marker = `Smoke WO ${Date.now()}`
    await page.goto('/works')

    // Open form
    await page.getByRole('button', { name: 'New order' }).click()
    await expect(page.getByRole('heading', { name: 'New works order' })).toBeVisible()

    // Select property
    await page.getByLabel('Property *').selectOption({ index: 1 })

    // Fill description
    await page.getByLabel('Description *').fill(marker)

    // Submit
    await page.getByRole('button', { name: 'Create order' }).click()

    // Form closes; order appears in list
    await expect(page.getByRole('heading', { name: 'New works order' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()
  })

  test('create Section 20 consultation round-trip', async ({ page }) => {
    const marker = `Smoke S20 ${Date.now()}`
    await page.goto('/works')

    // Switch to Section 20 tab
    await page.getByRole('button', { name: 'Section 20' }).click()

    // Open form
    await page.getByRole('button', { name: 'New consultation' }).click()
    await expect(page.getByRole('heading', { name: 'New Section 20 consultation' })).toBeVisible()

    // Select property
    await page.getByLabel('Property *').selectOption({ index: 1 })

    // Fill works description
    await page.getByLabel('Works description *').fill(marker)

    // Set estimated cost
    await page.getByLabel('Estimated cost (£)').fill('50000')

    // Submit
    await page.getByRole('button', { name: 'Create consultation' }).click()

    // Form closes; consultation appears in list
    await expect(page.getByRole('heading', { name: 'New Section 20 consultation' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()
  })
})
