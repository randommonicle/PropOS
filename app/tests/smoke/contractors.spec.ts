/**
 * Contractors module smoke tests.
 * Verifies: page load, contractor create round-trip.
 * Hits real Supabase — no mocks.
 * afterAll cleans up any Smoke Co records left by this test run.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

test.describe('Contractors page', () => {
  test.afterAll(async () => {
    // Sign in as demo admin and delete any smoke test contractors
    await supabase.auth.signInWithPassword({
      email: 'admin@propos.local',
      password: 'PropOS2026!',
    })
    await supabase
      .from('contractors')
      .delete()
      .like('company_name', 'Smoke Co %')
  })

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
