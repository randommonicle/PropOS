/**
 * Compliance module smoke tests.
 * Verifies: page load, tab navigation, compliance item create round-trip,
 * insurance tab navigation.
 * Hits real Supabase — no mocks.
 * afterAll cleans up Py2 CI records left by this test run.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

test.describe('Compliance page', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    await supabase.from('compliance_items').delete().like('description', 'Py2 CI %')
  })

  test('page loads with correct heading', async ({ page }) => {
    await page.goto('/compliance')
    await expect(page.getByRole('main').getByRole('heading', { name: 'Compliance' })).toBeVisible()
  })

  test('both tabs are present and switchable', async ({ page }) => {
    await page.goto('/compliance')
    await expect(page.getByRole('button', { name: 'Compliance Items' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Insurance Policies' })).toBeVisible()

    // Switch to insurance tab
    await page.getByRole('button', { name: 'Insurance Policies' }).click()
    await expect(page.getByRole('button', { name: 'Add policy' })).toBeVisible()

    // Switch back
    await page.getByRole('button', { name: 'Compliance Items' }).click()
    await expect(page.getByRole('button', { name: 'Add item' })).toBeVisible()
  })

  test('RAG summary strip shows three cards', async ({ page }) => {
    await page.goto('/compliance')
    // The three RAG counter cards show labels Red, Amber, Green
    await expect(page.getByRole('main').getByText('Red')).toBeVisible()
    await expect(page.getByRole('main').getByText('Amber')).toBeVisible()
    await expect(page.getByRole('main').getByText('Green')).toBeVisible()
  })

  test('create compliance item round-trip', async ({ page }) => {
    const marker = `Py2 CI ${Date.now()}`
    await page.goto('/compliance')

    // Open form
    await page.getByRole('button', { name: 'Add item' }).click()
    await expect(page.getByRole('heading', { name: 'New compliance item' })).toBeVisible()

    // Fill property (first real property)
    await page.getByLabel('Property *').selectOption({ index: 1 })

    // Fill description
    await page.getByLabel('Description *').fill(marker)

    // Set expiry date
    await page.getByLabel('Expiry date').fill('2027-12-31')

    // Submit
    await page.getByRole('button', { name: 'Save item' }).click()

    // Form closes; item appears in list
    await expect(page.getByRole('heading', { name: 'New compliance item' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()
  })
})
