/**
 * Smoke tests — Properties module
 * Verifies: list loads, seed properties present, create new property.
 * afterAll cleans up Smoke Test Block records left by this test run.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

test.describe('Properties', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/properties')
  })

  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    await supabase.from('properties').delete().like('name', 'Smoke Test Block %')
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
