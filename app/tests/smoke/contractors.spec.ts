/**
 * Contractors module smoke tests.
 * Verifies: page load, contractor create round-trip.
 * Hits real Supabase — no mocks.
 */
import { test, expect } from '@playwright/test'

test.describe('Contractors page', () => {
  test('page loads with correct heading', async ({ page }) => {
    await page.goto('/contractors')
    await expect(page.getByRole('main').getByRole('heading', { name: 'Contractors' })).toBeVisible()
  })

  test('add contractor button is visible', async ({ page }) => {
    await page.goto('/contractors')
    await expect(page.getByRole('button', { name: 'Add contractor' })).toBeVisible()
  })

  test('sidebar nav has Contractors link', async ({ page }) => {
    await page.goto('/contractors')
    await expect(page.getByRole('complementary').getByText('Contractors')).toBeVisible()
  })

  test('create contractor round-trip', async ({ page }) => {
    const marker = `Smoke Co ${Date.now()}`
    await page.goto('/contractors')

    // Open form
    await page.getByRole('button', { name: 'Add contractor' }).click()
    await expect(page.getByRole('heading', { name: 'New contractor' })).toBeVisible()

    // Fill company name
    await page.getByLabel('Company name *').fill(marker)

    // Submit
    await page.getByRole('button', { name: 'Save contractor' }).click()

    // Form closes; contractor appears in table
    await expect(page.getByRole('heading', { name: 'New contractor' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()
  })
})
