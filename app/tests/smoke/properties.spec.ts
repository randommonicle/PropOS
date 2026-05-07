/**
 * Smoke tests — Properties module
 * Verifies: list loads, seed properties present, create new property.
 */
import { test, expect } from '@playwright/test'

test.describe('Properties', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/properties')
  })

  test('properties list loads', async ({ page }) => {
    // Scope to main to avoid matching the 'Properties' sidebar nav link
    await expect(page.getByRole('main').getByRole('heading', { name: 'Properties' })).toBeVisible()
  })

  test('seed properties are displayed', async ({ page }) => {
    await expect(page.getByText('Maple House')).toBeVisible()
    await expect(page.getByText('Birchwood Court')).toBeVisible()
    await expect(page.getByText('Cedar Estate')).toBeVisible()
  })

  test('can create a new property', async ({ page }) => {
    const uniqueName = `Smoke Test Block ${Date.now()}`

    await page.getByRole('button', { name: 'Add property' }).click()

    // Wait for form — labels now have proper htmlFor/id associations
    await expect(page.getByRole('heading', { name: 'New property' })).toBeVisible()

    await page.getByLabel('Property name *').fill(uniqueName)
    await page.getByLabel('Address line 1 *').fill('1 Test Street')
    await page.getByLabel('Town *').fill('London')
    await page.getByLabel('Postcode *').fill('SW1A 1AA')

    await page.getByRole('button', { name: 'Save property' }).click()

    // New property card should appear in the grid
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10_000 })
  })
})
